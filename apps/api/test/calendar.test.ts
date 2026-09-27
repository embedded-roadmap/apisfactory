/**
 * Oturum 41 — dış bağımlılık maddesi 5 (W28): Google Calendar / Microsoft 365 canlı senkronu.
 * Sağlayıcı HTTP'si `calendarDeps.fetch` ile SAHTE yanıtlanır: giden istekler (uç nokta, yöntem, gövde, yetki başlığı)
 * ve yanıtların işlenişi sınanır. Gerçek sağlayıcıya karşı doğrulama OAuth uygulama kaydı sonrası yapılır.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, login, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { calendarDeps } from "../src/lib/calendar-providers";
import { encryptSecret } from "../src/lib/secrets";

let w: World;
let A: string;
const M = "manager@a.test";
type Req = { method: string; url: string; headers: Headers; body: string };
let log: Req[] = [];
let routes: ((r: Req) => { status?: number; json?: unknown } | undefined)[] = [];
const realFetch = calendarDeps.fetch;
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;

function route(fn: (r: Req) => { status?: number; json?: unknown } | undefined) {
  routes.unshift(fn);
}

async function asOwner<T>(fn: () => Promise<T>) {
  await w.owner.query("begin");
  await w.owner.query(`select set_config('app.company_id', $1, true)`, [A]);
  try {
    return await fn();
  } finally {
    await w.owner.query("commit");
  }
}

async function callback(provider: string, query: string) {
  return w.app.inject({ method: "GET", url: `/api/calendar/oauth/callback/${provider}?${query}` });
}

async function connect(provider: "google" | "microsoft") {
  const { authorizeUrl } = expectOk(await call(w.app, M, A, "POST", `/api/calendar/connect/${provider}`));
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  return { authorizeUrl: new URL(authorizeUrl), state };
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  calendarDeps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r: Req = { method: init?.method ?? "GET", url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    log.push(r);
    for (const fn of routes) {
      const out = fn(r);
      if (out) return new Response(out.json === undefined ? "" : JSON.stringify(out.json), { status: out.status ?? 200 });
    }
    return new Response(JSON.stringify({ error: "unrouted" }), { status: 599 });
  }) as typeof fetch;
});

beforeEach(() => {
  log = [];
});

afterAll(async () => {
  calendarDeps.fetch = realFetch;
  for (const k of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "MS_OAUTH_CLIENT_ID", "MS_OAUTH_CLIENT_SECRET", "OAUTH_REDIRECT_BASE"]) delete process.env[k];
  await w.app.close();
  await w.owner.end();
  await closePool();
});

let meetingId: string;
let meetingCode: string;

describe("Takvim bağlantısı (OAuth)", () => {
  it("OAuth uygulaması yapılandırılmamışsa bağlanma 503 döner ve durum bunu gösterir", async () => {
    const s = expectOk(await call(w.app, M, A, "GET", "/api/calendar/status"));
    expect(s).toEqual({ providers: { google: { configured: false }, microsoft: { configured: false } }, connections: [] });
    const r = await call(w.app, M, A, "POST", "/api/calendar/connect/google");
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("calendar_not_configured");
  });

  it("Google yetkilendirme bağlantısı doğru kapsam, yönlendirme adresi ve imzalı state içerir", async () => {
    Object.assign(process.env, { GOOGLE_OAUTH_CLIENT_ID: "g-client", GOOGLE_OAUTH_CLIENT_SECRET: "g-secret", MS_OAUTH_CLIENT_ID: "m-client", MS_OAUTH_CLIENT_SECRET: "m-secret", OAUTH_REDIRECT_BASE: "https://api.example.test" });
    const { authorizeUrl, state } = await connect("google");
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
      client_id: "g-client", redirect_uri: "https://api.example.test/api/calendar/oauth/callback/google", response_type: "code", access_type: "offline", prompt: "consent",
    });
    expect(authorizeUrl.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(state.split(".")).toHaveLength(3);
  });

  it("geri çağrı: bozuk state ve reddedilen onay güvenle geri yönlendirilir, bağlantı açılmaz", async () => {
    expect((await callback("google", "code=x&state=bozuk")).headers.location).toMatch(/calendar=error$/);
    const { state } = await connect("google");
    expect((await callback("microsoft", `code=x&state=${state}`)).headers.location).toMatch(/calendar=error$/); // state başka sağlayıcıya ait
    expect((await callback("google", `error=access_denied&state=${state}`)).headers.location).toMatch(/calendar=denied$/);
    expect(expectOk(await call(w.app, M, A, "GET", "/api/calendar/status")).connections).toEqual([]);
  });

  it("geri çağrı başarılı: kod token'a çevrilir, hesap e-postası alınır, token şifreli saklanır", async () => {
    route((r) => (r.url === "https://oauth2.googleapis.com/token" ? { json: { access_token: "g-access-1", refresh_token: "g-refresh-1", expires_in: 3600, id_token: idToken("yonetici@gmail.test") } } : undefined));
    const { state } = await connect("google");
    const res = await callback("google", `code=auth-code-1&state=${state}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://localhost:5173/planning/meetings?calendar=connected");
    const tokenReq = log.find((x) => x.url === "https://oauth2.googleapis.com/token")!;
    expect(Object.fromEntries(new URLSearchParams(tokenReq.body))).toMatchObject({ code: "auth-code-1", client_id: "g-client", client_secret: "g-secret", grant_type: "authorization_code", redirect_uri: "https://api.example.test/api/calendar/oauth/callback/google" });
    const s = expectOk(await call(w.app, M, A, "GET", "/api/calendar/status"));
    expect(s.connections).toEqual([expect.objectContaining({ provider: "google", accountEmail: "yonetici@gmail.test", status: "active" })]);
    expect(JSON.stringify(s)).not.toContain("g-access-1");
    const row = await asOwner(async () => (await w.owner.query(`select token_enc from calendar_connections where provider = 'google'`)).rows[0]);
    expect(row.token_enc).toMatch(/^v1:/);
    expect(row.token_enc).not.toContain("g-refresh-1");
    // Başka kullanıcı bu bağlantıyı görmez (kişisel)
    expect(expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/calendar/status")).connections).toEqual([]);
  });
});

describe("Uygulama → takvim (Google)", () => {
  it("toplantı düzenleyenin takvimine katılımcılarla birlikte etkinlik olarak yazılır; outbox işi de bırakılır", async () => {
    const rdId = (await w.owner.query(`select id from users where email = 'rd@a.test'`)).rows[0].id;
    const m = expectOk(await call(w.app, M, A, "POST", "/api/meetings", { title: "Tasarım gözden geçirme", startsAt: "2026-10-05T07:00:00Z", durationMinutes: 45, location: "Toplantı odası", agenda: "Rev B kararı", participantIds: [rdId] }));
    meetingId = m.id;
    meetingCode = m.code;
    const jobs = await asOwner(async () => (await w.owner.query(`select payload from outbox where topic = 'calendar.push'`)).rows);
    expect(jobs.some((j) => j.payload.meetingId === meetingId)).toBe(true);
    route((r) => (r.method === "POST" && r.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?") ? { json: { id: "g-evt-1" } } : undefined));
    const p = expectOk(await call(w.app, M, A, "POST", `/api/meetings/${meetingId}/calendar-push`));
    expect(p).toEqual({ status: "created", externalId: "g-evt-1" });
    const req = log.find((x) => x.method === "POST" && x.url.includes("/events"))!;
    expect(req.url).toContain("sendUpdates=all");
    expect(req.headers.get("authorization")).toBe("Bearer g-access-1");
    expect(JSON.parse(req.body)).toMatchObject({
      summary: `${meetingCode} Tasarım gözden geçirme`, location: "Toplantı odası",
      start: { dateTime: "2026-10-05T07:00:00.000Z" }, end: { dateTime: "2026-10-05T07:45:00.000Z" },
      attendees: [{ email: "rd@a.test", displayName: "A rd" }],
    });
    expect(JSON.parse(req.body).description).toContain(`/planning/meetings/${meetingId}`);
  });

  it("güncelleme aynı etkinliği PATCH eder (ikinci etkinlik açılmaz)", async () => {
    expectOk(await call(w.app, M, A, "POST", `/api/meetings/${meetingId}/update`, { startsAt: "2026-10-05T08:00:00Z" }));
    route((r) => (r.method === "PATCH" && r.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events/g-evt-1?") ? { json: { id: "g-evt-1" } } : undefined));
    expect(expectOk(await call(w.app, M, A, "POST", `/api/meetings/${meetingId}/calendar-push`))).toMatchObject({ status: "updated" });
    expect(JSON.parse(log.find((x) => x.method === "PATCH")!.body).start).toEqual({ dateTime: "2026-10-05T08:00:00.000Z" });
    expect(log.some((x) => x.method === "POST" && x.url.includes("/events"))).toBe(false);
  });

  it("bağlı takvimi olmayan düzenleyenin toplantısı sessizce atlanır", async () => {
    const m = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/meetings", { title: "Ar-Ge iç toplantı", startsAt: "2026-10-06T07:00:00Z", durationMinutes: 30, participantIds: [] }));
    expect(expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/meetings/${m.id}/calendar-push`))).toEqual({ status: "skipped", reason: "no_connection" });
    expect(log).toEqual([]); // sağlayıcıya hiç istek gitmedi
  });
});

describe("Takvim → uygulama (Google artımlı senkron)", () => {
  it("bağlı etkinlikte saat/süre/başlık değişikliği toplantıya yansır; imleç saklanır; ilgisiz etkinlik yok sayılır", async () => {
    route((r) =>
      r.method === "GET" && r.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?") && !r.url.includes("syncToken")
        ? { json: { items: [
            { id: "g-evt-1", status: "confirmed", summary: `${meetingCode} Tasarım GR (Rev B)`, start: { dateTime: "2026-10-05T12:30:00+03:00" }, end: { dateTime: "2026-10-05T13:30:00+03:00" } },
            { id: "baska-etkinlik", status: "confirmed", summary: "Diş hekimi", start: { dateTime: "2026-10-05T15:00:00Z" }, end: { dateTime: "2026-10-05T16:00:00Z" } },
          ], nextSyncToken: "sync-1" } }
        : undefined,
    );
    expect(expectOk(await call(w.app, M, A, "POST", "/api/calendar/sync"))).toEqual({ applied: 1, seen: 2 });
    const m = expectOk(await call(w.app, M, A, "GET", `/api/meetings/${meetingId}`));
    expect(m).toMatchObject({ title: "Tasarım GR (Rev B)", durationMinutes: 60 });
    expect(new Date(m.startsAt).toISOString()).toBe("2026-10-05T09:30:00.000Z");
    const hist = expectOk(await call(w.app, M, A, "GET", `/api/history/meeting/${meetingId}`));
    expect(JSON.stringify(hist)).toContain('"source":"calendar"');
  });

  it("sonraki senkron syncToken ile yapılır; 410 (imleç geçersiz) gelirse tam senkrona döner; değişmeyen etkinlik no-op", async () => {
    route((r) => (r.url.includes("syncToken=sync-1") ? { status: 410, json: { error: "gone" } } : undefined));
    route((r) =>
      r.method === "GET" && r.url.includes("/events?") && !r.url.includes("syncToken")
        ? { json: { items: [{ id: "g-evt-1", status: "confirmed", summary: `${meetingCode} Tasarım GR (Rev B)`, start: { dateTime: "2026-10-05T09:30:00Z" }, end: { dateTime: "2026-10-05T10:30:00Z" } }], nextSyncToken: "sync-2" } }
        : undefined,
    );
    expect(expectOk(await call(w.app, M, A, "POST", "/api/calendar/sync"))).toEqual({ applied: 0, seen: 1 });
    expect(log.filter((x) => x.method === "GET").map((x) => x.url.includes("syncToken=sync-1"))).toEqual([true, false]);
    const cur = await asOwner(async () => (await w.owner.query(`select sync_cursor from calendar_connections where provider = 'google'`)).rows[0].sync_cursor);
    expect(cur).toBe("sync-2");
  });

  it("süresi dolmuş erişim belirteci yenilenir ve yenisi şifreli saklanır", async () => {
    await asOwner(() => w.owner.query(`update calendar_connections set token_enc = $1 where provider = 'google'`, [encryptSecret({ accessToken: "eski", refreshToken: "g-refresh-1", expiresAt: Date.now() - 1000 })]));
    route((r) => (r.url === "https://oauth2.googleapis.com/token" ? { json: { access_token: "g-access-2", expires_in: 3600 } } : undefined));
    route((r) => (r.url.includes("syncToken=sync-2") ? { json: { items: [], nextSyncToken: "sync-3" } } : undefined));
    expectOk(await call(w.app, M, A, "POST", "/api/calendar/sync"));
    const refresh = log.find((x) => x.url === "https://oauth2.googleapis.com/token")!;
    expect(Object.fromEntries(new URLSearchParams(refresh.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "g-refresh-1" });
    expect(log.find((x) => x.url.includes("syncToken=sync-2"))!.headers.get("authorization")).toBe("Bearer g-access-2");
  });

  it("takvimde silinen etkinlik planlı toplantıyı gerekçesiyle iptal eder", async () => {
    route((r) => (r.url.includes("syncToken=sync-3") ? { json: { items: [{ id: "g-evt-1", status: "cancelled" }], nextSyncToken: "sync-4" } } : undefined));
    expect(expectOk(await call(w.app, M, A, "POST", "/api/calendar/sync")).applied).toBe(1);
    expect(expectOk(await call(w.app, M, A, "GET", `/api/meetings/${meetingId}`))).toMatchObject({ status: "cancelled", cancelReason: "Takvimden iptal edildi (google)" });
  });

  it("yenileme yetkisi geri alındıysa (invalid_grant) bağlantı 'error' olur ve kullanıcıya yeniden bağlanması söylenir", async () => {
    await asOwner(() => w.owner.query(`update calendar_connections set token_enc = $1 where provider = 'google'`, [encryptSecret({ accessToken: "eski", refreshToken: "iptal", expiresAt: 0 })]));
    route((r) => (r.url === "https://oauth2.googleapis.com/token" ? { status: 400, json: { error: "invalid_grant" } } : undefined));
    const r = await call(w.app, M, A, "POST", "/api/calendar/sync");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("calendar_auth");
    expect(expectOk(await call(w.app, M, A, "GET", "/api/calendar/status")).connections[0]).toMatchObject({ status: "error", lastError: expect.stringMatching(/yeniden bağlayın/) });
  });
});

describe("Microsoft 365 (Graph)", () => {
  it("bağlanır, etkinlik UTC saatiyle oluşturulur, iptal edildiğinde düzenleyen olarak iptal bildirimi gönderilir", async () => {
    // Google bağlantısını kaldır (düzenleyen artık Microsoft ile çalışsın)
    expectOk(await call(w.app, M, A, "POST", "/api/calendar/disconnect/google"));
    route((r) => (r.url === "https://login.microsoftonline.com/common/oauth2/v2.0/token" ? { json: { access_token: "m-access-1", refresh_token: "m-refresh-1", expires_in: 3600 } } : undefined));
    route((r) => (r.url === "https://graph.microsoft.com/v1.0/me" ? { json: { mail: "yonetici@firma.test" } } : undefined));
    const { authorizeUrl, state } = await connect("microsoft");
    expect(authorizeUrl.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(authorizeUrl.searchParams.get("scope")).toContain("Calendars.ReadWrite");
    expect((await callback("microsoft", `code=m-code&state=${state}`)).headers.location).toMatch(/calendar=connected$/);
    const conns = expectOk(await call(w.app, M, A, "GET", "/api/calendar/status")).connections;
    expect(conns.find((c: any) => c.provider === "microsoft")).toMatchObject({ accountEmail: "yonetici@firma.test", status: "active" });
    expect(conns.find((c: any) => c.provider === "google")).toMatchObject({ status: "revoked" });

    const m = expectOk(await call(w.app, M, A, "POST", "/api/meetings", { title: "Tedarikçi görüşmesi", startsAt: "2026-10-07T11:00:00Z", durationMinutes: 30, participantIds: [] }));
    route((r) => (r.method === "POST" && r.url === "https://graph.microsoft.com/v1.0/me/events" ? { json: { id: "m-evt-1" } } : undefined));
    expect(expectOk(await call(w.app, M, A, "POST", `/api/meetings/${m.id}/calendar-push`))).toMatchObject({ status: "created", externalId: "m-evt-1" });
    const body = JSON.parse(log.find((x) => x.url === "https://graph.microsoft.com/v1.0/me/events")!.body);
    expect(body).toMatchObject({ subject: `${m.code} Tedarikçi görüşmesi`, start: { dateTime: "2026-10-07T11:00:00.000", timeZone: "UTC" }, end: { dateTime: "2026-10-07T11:30:00.000", timeZone: "UTC" } });

    expectOk(await call(w.app, M, A, "POST", `/api/meetings/${m.id}/cancel`, { reason: "Tedarikçi erteledi" }));
    route((r) => (r.method === "POST" && r.url === "https://graph.microsoft.com/v1.0/me/events/m-evt-1/cancel" ? { status: 202 } : undefined));
    expect(expectOk(await call(w.app, M, A, "POST", `/api/meetings/${m.id}/calendar-push`))).toMatchObject({ status: "cancelled" });
    expect(JSON.parse(log.find((x) => x.url.endsWith("/m-evt-1/cancel"))!.body)).toEqual({ comment: "Tedarikçi erteledi" });
  });

  it("Graph delta: sayfalı sonuç izlenir, @removed iptal sayılır, deltaLink imleç olarak saklanır", async () => {
    const m = expectOk(await call(w.app, M, A, "POST", "/api/meetings", { title: "Kalite toplantısı", startsAt: "2026-10-08T06:00:00Z", durationMinutes: 60, participantIds: [] }));
    route((r) => (r.method === "POST" && r.url === "https://graph.microsoft.com/v1.0/me/events" ? { json: { id: "m-evt-2" } } : undefined));
    expectOk(await call(w.app, M, A, "POST", `/api/meetings/${m.id}/calendar-push`));
    route((r) => (r.url.startsWith("https://graph.microsoft.com/v1.0/me/calendarView/delta?startDateTime=") ? { json: { value: [{ id: "diger", subject: "x", start: { dateTime: "2026-10-01T00:00:00.0000000" }, end: { dateTime: "2026-10-01T01:00:00.0000000" } }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=p2" } } : undefined));
    route((r) => (r.url.endsWith("$skiptoken=p2") ? { json: { value: [{ id: "m-evt-2", subject: `${m.code} Kalite toplantısı`, start: { dateTime: "2026-10-08T07:00:00.0000000" }, end: { dateTime: "2026-10-08T08:30:00.0000000" } }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=d1" } } : undefined));
    expect(expectOk(await call(w.app, M, A, "POST", "/api/calendar/sync"))).toEqual({ applied: 1, seen: 2 });
    expect(log.find((x) => x.url.includes("calendarView/delta"))!.headers.get("prefer")).toBe('outlook.timezone="UTC"');
    const upd = expectOk(await call(w.app, M, A, "GET", `/api/meetings/${m.id}`));
    expect(new Date(upd.startsAt).toISOString()).toBe("2026-10-08T07:00:00.000Z");
    expect(upd.durationMinutes).toBe(90);
    route((r) => (r.url.endsWith("$deltatoken=d1") ? { json: { value: [{ id: "m-evt-2", "@removed": { reason: "deleted" } }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=d2" } } : undefined));
    expect(expectOk(await call(w.app, M, A, "POST", "/api/calendar/sync")).applied).toBe(1);
    expect(expectOk(await call(w.app, M, A, "GET", `/api/meetings/${m.id}`)).status).toBe("cancelled");
  });

  it("bağlantı kesilince token silinir; başka şirket bağlantıyı görmez", async () => {
    expectOk(await call(w.app, M, A, "POST", "/api/calendar/disconnect/microsoft"));
    const row = await asOwner(async () => (await w.owner.query(`select token_enc, status from calendar_connections where provider = 'microsoft'`)).rows[0]);
    expect(row).toEqual({ token_enc: null, status: "revoked" });
    expect(expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/calendar/status")).connections).toEqual([]);
    await login(w.app, M);
  });
});
