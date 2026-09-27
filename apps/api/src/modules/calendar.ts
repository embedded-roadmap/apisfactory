import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../config";
import { withTenant, type Db } from "../db/pool";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { recordEvent, type Actor } from "../lib/records";
import { decryptSecret, encryptSecret } from "../lib/secrets";
import { CALENDAR_PROVIDERS, CalendarError, type CalendarProviderKey, type EventInput, type Tokens } from "../lib/calendar-providers";
import { can, ctxOf, tenant } from "../http/context";

/**
 * Dış bağımlılık maddesi 5 (W28) — takvim canlı senkronu.
 *  - Bağlama: kullanıcı kendi Google/Microsoft hesabını OAuth ile yetkilendirir; token şifreli saklanır.
 *  - Uygulama → takvim: toplantı düzenleyenin bağlı takvimine etkinlik olarak yazılır (oluştur/güncelle/iptal),
 *    katılımcı davetlerini sağlayıcı gönderir. Tetikleme outbox'tan ("calendar.push") veya elle.
 *  - Takvim → uygulama: artımlı senkron; yalnız bu uygulamanın oluşturduğu (bağlı) etkinliklerde saat/süre/başlık
 *    değişikliği veya iptal, hâlâ planlı toplantıya yansır. Kapanmış toplantı değişmez.
 * Sağlayıcı çağrıları veri tabanı işlemi DIŞINDA yapılır.
 */

/** İstek dışı (worker) okumalarında kullanıcı bağlamı: gerçek bir kullanıcı değildir, yalnız şirket kapsamlı RLS için. */
const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";
const PROVIDERS = ["google", "microsoft"] as const;
const isProvider = (p: string): p is CalendarProviderKey => (PROVIDERS as readonly string[]).includes(p);
const stateKey = () => new TextEncoder().encode(`${config.jwtSecret}:calendar-oauth`);
const redirectUri = (p: CalendarProviderKey) => `${process.env.OAUTH_REDIRECT_BASE || `http://localhost:${config.port}`}/api/calendar/oauth/callback/${p}`;

type Conn = { id: string; user_id: string; provider: CalendarProviderKey; token_enc: string; sync_cursor: string | null };
type Ctx = { companyId: string; userId: string };
const automation = (c: Ctx): Actor & { userId: string } => ({ companyId: c.companyId, userId: c.userId, kind: "automation" });

/** Geçerli erişim belirteci; süresi dolmak üzereyse yeniler ve yenisini saklar. Yetki geçersizse bağlantı 'error' olur. */
async function accessToken(ctx: Ctx, conn: Conn): Promise<string> {
  const t = decryptSecret<Tokens>(conn.token_enc);
  if (t.expiresAt > Date.now() + 60_000) return t.accessToken;
  try {
    const fresh = await CALENDAR_PROVIDERS[conn.provider].refresh(t.refreshToken);
    await withTenant(ctx, (db) => db.query(`update calendar_connections set token_enc = $2, updated_at = now() where id = $1`, [conn.id, encryptSecret(fresh)]));
    return fresh.accessToken;
  } catch (e) {
    if (e instanceof CalendarError && e.kind === "auth") await markError(ctx, conn.id, "Takvim yetkisi geçersiz veya geri alındı — hesabı yeniden bağlayın");
    throw e;
  }
}

async function markError(ctx: Ctx, id: string, msg: string) {
  await withTenant(ctx, (db) => db.query(`update calendar_connections set status = 'error', last_error = $2, updated_at = now() where id = $1`, [id, msg]));
}

/** Toplantıyı düzenleyenin bağlı takvimine yazar. Bağlantı yoksa sessizce atlar (etkinlik zorunlu değil). */
export async function pushMeeting(companyId: string, meetingId: string): Promise<{ status: "created" | "updated" | "cancelled" | "skipped"; reason?: string; externalId?: string }> {
  const lookup = await withTenant({ companyId, userId: SYSTEM_USER }, async (db) => {
    const m = (await db.query(`select id, code, title, starts_at, duration_minutes, location, agenda, status, cancel_reason, organizer_id from meetings where id = $1`, [meetingId])).rows[0];
    if (!m) return null;
    const link = (await db.query(`select l.external_event_id, c.id, c.user_id, c.provider, c.token_enc, c.sync_cursor, c.status from calendar_event_links l join calendar_connections c on c.id = l.connection_id where l.meeting_id = $1`, [meetingId])).rows[0];
    const conn = link ?? (await db.query(`select id, user_id, provider, token_enc, sync_cursor, status from calendar_connections where user_id = $1 and status = 'active' order by provider limit 1`, [m.organizer_id])).rows[0];
    const attendees = (await db.query(`select u.email, u.name from meeting_participants p join users u on u.id = p.user_id where p.meeting_id = $1 and p.user_id <> $2 order by u.name`, [meetingId, m.organizer_id])).rows;
    return { m, link, conn, attendees };
  });
  if (!lookup) throw notFound("Toplantı");
  const { m, link, conn, attendees } = lookup;
  if (!conn || conn.status !== "active") return { status: "skipped", reason: "no_connection" };
  if (m.status === "closed") return { status: "skipped", reason: "closed" };
  if (m.status === "cancelled" && !link) return { status: "skipped", reason: "cancelled_unlinked" };
  const ctx = { companyId, userId: m.organizer_id as string };
  const provider = CALENDAR_PROVIDERS[conn.provider as CalendarProviderKey];
  const token = await accessToken(ctx, conn);
  const input: EventInput = {
    title: `${m.code} ${m.title}`,
    description: `${m.agenda ?? ""}\n\napisfactory: ${config.corsOrigin}/planning/meetings/${m.id}`.trim(),
    location: m.location,
    startsAt: new Date(m.starts_at).toISOString(),
    durationMinutes: m.duration_minutes,
    attendees,
  };
  let status: "created" | "updated" | "cancelled";
  let externalId: string = link?.external_event_id;
  if (m.status === "cancelled") {
    await provider.cancelEvent(token, externalId, m.cancel_reason ?? "Toplantı iptal edildi");
    status = "cancelled";
  } else if (link) {
    await provider.updateEvent(token, externalId, input);
    status = "updated";
  } else {
    externalId = await provider.createEvent(token, input);
    status = "created";
  }
  await withTenant(ctx, async (db) => {
    await db.query(
      `insert into calendar_event_links (company_id, meeting_id, connection_id, external_event_id) values (app_company_id(), $1, $2, $3)
       on conflict (meeting_id) do update set last_pushed_at = now()`,
      [meetingId, conn.id, externalId],
    );
    await recordEvent(db, automation(ctx), { entityType: "meeting", entityId: meetingId, eventType: `calendar.${status}`, after: { provider: conn.provider } });
  });
  return { status, externalId };
}

/** Bir bağlantının artımlı senkronu: bağlı etkinliklerdeki değişiklikleri planlı toplantılara uygular. */
export async function pullConnection(companyId: string, connectionId: string): Promise<{ applied: number; seen: number }> {
  const conn = await withTenant({ companyId, userId: SYSTEM_USER }, async (db) =>
    (await db.query(`select id, user_id, provider, token_enc, sync_cursor from calendar_connections where id = $1 and status = 'active'`, [connectionId])).rows[0] as Conn | undefined,
  );
  if (!conn) return { applied: 0, seen: 0 };
  const ctx = { companyId, userId: conn.user_id };
  const provider = CALENDAR_PROVIDERS[conn.provider];
  const token = await accessToken(ctx, conn);
  let res;
  try {
    res = await provider.pullChanges(token, conn.sync_cursor);
  } catch (e) {
    if (!(e instanceof CalendarError && e.kind === "gone")) throw e;
    res = await provider.pullChanges(token, null); // imleç geçersizleşti → tam senkron
  }
  const changes = res.changes;
  return withTenant(ctx, async (db) => {
    let applied = 0;
    for (const ch of changes) {
      const row = (
        await db.query(
          `select m.id, m.title, m.code, m.starts_at, m.duration_minutes, m.status from calendar_event_links l join meetings m on m.id = l.meeting_id
            where l.connection_id = $1 and l.external_event_id = $2 for update of m`,
          [conn.id, ch.externalId],
        )
      ).rows[0];
      if (!row) continue;
      await db.query(`update calendar_event_links set last_pulled_at = now() where connection_id = $1 and external_event_id = $2`, [conn.id, ch.externalId]);
      if (row.status !== "planned") continue;
      const actor = automation(ctx);
      if (ch.deleted) {
        const reason = `Takvimden iptal edildi (${conn.provider})`;
        await db.query(`update meetings set status = 'cancelled', cancel_reason = $2 where id = $1`, [row.id, reason]);
        await recordEvent(db, actor, { entityType: "meeting", entityId: row.id, eventType: "cancelled", reason, after: { source: "calendar" } });
        applied++;
        continue;
      }
      const startsChanged = ch.startsAt && new Date(ch.startsAt).getTime() !== new Date(row.starts_at).getTime();
      const durChanged = ch.durationMinutes !== undefined && ch.durationMinutes !== row.duration_minutes && ch.durationMinutes >= 5 && ch.durationMinutes <= 600;
      const prefix = `${row.code} `;
      const newTitle = ch.title?.startsWith(prefix) ? ch.title.slice(prefix.length).trim() : null;
      const titleChanged = newTitle && newTitle.length >= 3 && newTitle !== row.title;
      if (!startsChanged && !durChanged && !titleChanged) continue;
      await db.query(
        `update meetings set starts_at = coalesce($2, starts_at), duration_minutes = coalesce($3, duration_minutes), title = coalesce($4, title) where id = $1`,
        [row.id, startsChanged ? ch.startsAt : null, durChanged ? ch.durationMinutes : null, titleChanged ? newTitle : null],
      );
      await recordEvent(db, actor, {
        entityType: "meeting", entityId: row.id, eventType: "rescheduled",
        before: { startsAt: row.starts_at, durationMinutes: row.duration_minutes, title: row.title },
        after: { startsAt: ch.startsAt, durationMinutes: ch.durationMinutes, title: newTitle ?? row.title, source: "calendar" },
      });
      applied++;
    }
    await db.query(`update calendar_connections set sync_cursor = $2, last_synced_at = now(), last_error = null, updated_at = now() where id = $1`, [conn.id, res.cursor]);
    return { applied, seen: changes.length };
  });
}

/** Worker için: şirketin aktif bağlantılarını senkronlar (hata bağlantı bazında kaydedilir, diğerlerini durdurmaz). */
export async function runCalendarPull(db: Db, companyId: string): Promise<number> {
  const ids = (await db.query(`select id from calendar_connections where status = 'active'`)).rows.map((r) => r.id as string);
  let applied = 0;
  for (const id of ids) {
    try {
      applied += (await pullConnection(companyId, id)).applied;
    } catch (e) {
      await withTenant({ companyId, userId: SYSTEM_USER }, (d) => d.query(`update calendar_connections set last_error = $2, updated_at = now() where id = $1`, [id, (e as Error).message]));
    }
  }
  return applied;
}

function mapError(e: unknown): never {
  if (e instanceof CalendarError) {
    throw new AppError(e.kind === "auth" ? 409 : 502, e.kind === "auth" ? "calendar_auth" : "calendar_error", e.kind === "auth" ? "Takvim yetkisi geçersiz — hesabı yeniden bağlayın" : e.message);
  }
  throw e;
}

export async function calendarRoutes(app: FastifyInstance) {
  app.get("/api/calendar/status", async (req) =>
    tenant(req, null, async (db, actor) => ({
      providers: Object.fromEntries(PROVIDERS.map((p) => [p, { configured: CALENDAR_PROVIDERS[p].configured() }])),
      connections: (
        await db.query(
          `select provider, account_email as "accountEmail", status, last_synced_at as "lastSyncedAt", last_error as "lastError", created_at as "createdAt"
             from calendar_connections where user_id = $1 order by provider`,
          [actor.userId],
        )
      ).rows,
    })),
  );

  /** Yetkilendirme bağlantısı üretir; kullanıcı tarayıcıda sağlayıcının onay ekranına gider. */
  app.post("/api/calendar/connect/:provider", async (req) => {
    const { provider } = req.params as { provider: string };
    if (!isProvider(provider)) throw notFound("Takvim sağlayıcısı");
    if (!CALENDAR_PROVIDERS[provider].configured()) throw new AppError(503, "calendar_not_configured", `${provider === "google" ? "Google" : "Microsoft"} OAuth uygulaması yapılandırılmadı (platform işletmecisi)`);
    const c = ctxOf(req);
    if (!c.companyId || !c.userId) throw forbidden();
    const state = await new SignJWT({ cid: c.companyId, p: provider, n: randomUUID() })
      .setProtectedHeader({ alg: "HS256" }).setSubject(c.userId).setIssuedAt().setExpirationTime("10m").sign(stateKey());
    return { authorizeUrl: CALENDAR_PROVIDERS[provider].authorizeUrl(state, redirectUri(provider)) };
  });

  /** Sağlayıcının geri çağrısı (tarayıcı yönlendirmesi — oturum başlığı yok; kimlik imzalı state'ten gelir). */
  app.get("/api/calendar/oauth/callback/:provider", { config: { public: true } }, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = req.query as { code?: string; state?: string; error?: string };
    const back = (r: string) => reply.redirect(`${config.corsOrigin}/planning/meetings?calendar=${r}`);
    if (!isProvider(provider) || !q.state) return back("error");
    let claims: { sub?: string; cid?: unknown; p?: unknown };
    try {
      claims = (await jwtVerify(q.state, stateKey(), { algorithms: ["HS256"] })).payload;
    } catch {
      return back("error");
    }
    if (claims.p !== provider || typeof claims.cid !== "string" || !claims.sub) return back("error");
    if (q.error || !q.code) return back("denied");
    const ctx = { companyId: claims.cid, userId: claims.sub };
    let t;
    try {
      t = await CALENDAR_PROVIDERS[provider].exchangeCode(q.code, redirectUri(provider));
    } catch {
      return back("error");
    }
    const { email, ...tokens } = t;
    await withTenant(ctx, async (db) => {
      const r = await db.query(
        `insert into calendar_connections (company_id, user_id, provider, account_email, token_enc, status)
         values (app_company_id(), $1, $2, $3, $4, 'active')
         on conflict (company_id, user_id, provider) do update set account_email = $3, token_enc = $4, status = 'active', sync_cursor = null, last_error = null, updated_at = now()
         returning id`,
        [ctx.userId, provider, email, encryptSecret(tokens)],
      );
      await recordEvent(db, { ...ctx, kind: "human" }, { entityType: "calendar_connection", entityId: r.rows[0].id, eventType: "connected", after: { provider, accountEmail: email } });
    });
    return back("connected");
  });

  app.post("/api/calendar/disconnect/:provider", async (req) => {
    const { provider } = req.params as { provider: string };
    if (!isProvider(provider)) throw notFound("Takvim sağlayıcısı");
    return tenant(req, null, async (db, actor) => {
      const r = await db.query(
        `update calendar_connections set status = 'revoked', token_enc = null, sync_cursor = null, updated_at = now() where user_id = $1 and provider = $2 returning id`,
        [actor.userId, provider],
      );
      if (!r.rows[0]) throw notFound("Takvim bağlantısı");
      await recordEvent(db, actor, { entityType: "calendar_connection", entityId: r.rows[0].id, eventType: "disconnected", after: { provider } });
      return { provider, status: "revoked" };
    });
  });

  /** Kendi bağlı takvimlerini şimdi senkronla (takvim → uygulama). */
  app.post("/api/calendar/sync", async (req) => {
    const c = ctxOf(req);
    const ids = await tenant(req, null, async (db, actor) => (await db.query(`select id from calendar_connections where user_id = $1 and status = 'active'`, [actor.userId])).rows.map((r) => r.id as string));
    if (!ids.length) throw conflict("no_connection", "Bağlı takvim yok");
    let applied = 0;
    let seen = 0;
    for (const id of ids) {
      const r = await pullConnection(c.companyId!, id).catch(mapError);
      applied += r.applied;
      seen += r.seen;
    }
    return { applied, seen };
  });

  /** Toplantıyı takvime şimdi gönder (uygulama → takvim). Düzenleyen veya görev yöneticisi. */
  app.post("/api/meetings/:id/calendar-push", async (req) => {
    const { id } = req.params as { id: string };
    const c = ctxOf(req);
    await tenant(req, "task.view", async (db, actor) => {
      const m = (await db.query(`select organizer_id from meetings where id = $1`, [id])).rows[0];
      if (!m) throw notFound("Toplantı");
      if (m.organizer_id !== actor.userId && !can(req, "task.manage")) throw forbidden("task.manage");
    });
    return pushMeeting(c.companyId!, id).catch(mapError);
  });
}
