import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import type { Permission } from "@apisfactory/shared";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { enqueue, idempotent, nextCode, recordEvent } from "../lib/records";
import { can, ctxOf, idempotencyKey, need, parse, tenant } from "../http/context";

/**
 * W27/W28 — Kayda bağlı iç mesajlaşma ve toplantı.
 *  - Konuşma her zaman bir kayda bağlıdır (iş emri, değişiklik talebi, iade, sipariş, görev, toplantı…);
 *    kaydı görme yetkisi olmayan konuşmayı da göremez, ondan bahsedilemez.
 *  - Mesaj metni değişmez; yazar gerekçeyle geri çekebilir (kayıt kalır).
 *  - Toplantı tutanağı kapanınca kararlar değişmez, aksiyonlar sorumlusuna görev olarak açılır.
 *  - Dış takvim/toplantı bağlayıcısı yok; davet ve bildirimler test modundaki çıkış kutusuna yazılır.
 */

export const ENTITY: Record<string, { table: string; perm: Permission; label: (r: any) => string; link: (id: string) => string; select: string }> = {
  work_order: { table: "work_orders", perm: "production.view", select: "code", label: (r) => r.code, link: (id) => `/production/${id}` },
  change_request: { table: "change_requests", perm: "change.view", select: "code || ' ' || title as code", label: (r) => r.code, link: (id) => `/changes/${id}` },
  rma: { table: "rmas", perm: "rma.view", select: "code", label: (r) => r.code, link: (id) => `/returns/${id}` },
  sales_order: { table: "sales_orders", perm: "sales.view", select: "code", label: (r) => r.code, link: (id) => `/sales/${id}` },
  shipment: { table: "shipments", perm: "shipment.view", select: "code", label: (r) => r.code, link: (id) => `/shipments/${id}` },
  product: { table: "products", perm: "product.view", select: "code || ' ' || name as code", label: (r) => r.code, link: (id) => `/products/${id}` },
  purchase_order: { table: "purchase_orders", perm: "purchase.view", select: "code", label: (r) => r.code, link: (id) => `/purchasing/orders/${id}` },
  supplier_invoice: { table: "supplier_invoices", perm: "invoice.view", select: "code || ' ' || invoice_no as code", label: (r) => r.code, link: (id) => `/payables/${id}` },
  customer_invoice: { table: "customer_invoices", perm: "receivable.view", select: "code", label: (r) => r.code, link: (id) => `/receivables/${id}` },
  purchase_request: { table: "purchase_requests", perm: "purchase.view", select: "code", label: (r) => r.code, link: () => `/purchasing` },
  task: { table: "tasks", perm: "task.view", select: "title as code", label: (r) => r.code, link: (id) => `/planning/tasks/${id}` },
  meeting: { table: "meetings", perm: "task.view", select: "code || ' ' || title as code", label: (r) => r.code, link: (id) => `/planning/meetings/${id}` },
  channel: { table: "channels", perm: "task.view", select: "code || ' ' || name as code", label: (r) => r.code, link: (id) => `/collaboration/channels/${id}` },
  item_alternate: {
    table: "item_alternates",
    perm: "bom.view",
    select: "(select concat(i.code, ' → ', x.code) from items i, items x where i.id = item_alternates.item_id and x.id = item_alternates.alternate_item_id) as code",
    label: (r) => r.code,
    link: () => `/products/alternates`,
  },
};

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 3_000_000;
const MAX_ATTACHMENTS_TOTAL_BYTES = 5_000_000; // istek gövdesi 8 MB ile sınırlı (app.ts bodyLimit); base64 ~%33 büyür
const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "text/csv"] as const;
const AttachmentInput = z.object({ fileName: z.string().trim().min(1).max(200), contentType: z.enum(ATTACHMENT_TYPES), contentBase64: z.string().min(1) });

async function entityLabel(db: Db, type: string, id: string) {
  const e = ENTITY[type];
  if (!e) throw badRequest(`Konuşma bu kayıt türüne bağlanamaz: ${type}`);
  const r = await db.query(`select ${e.select} from ${e.table} where id = $1`, [id]);
  if (!r.rows[0]) throw notFound("Bağlı kayıt");
  return e.label(r.rows[0]);
}

/** Kullanıcının izinleri (rolden; vekâlet onay izinleri görünürlük vermez). */
async function userPerms(db: Db, userIds: string[]) {
  const r = await db.query(
    `select m.user_id, u.name, array_agg(distinct rp.permission) filter (where rp.permission is not null) as perms
       from memberships m join users u on u.id = m.user_id
       left join membership_roles mr on mr.membership_id = m.id left join role_permissions rp on rp.role_id = mr.role_id
      where m.status = 'active' and m.user_id = any($1) group by m.user_id, u.name`,
    [userIds],
  );
  return new Map(r.rows.map((x) => [x.user_id as string, { name: x.name as string, perms: new Set<string>(x.perms ?? []) }]));
}

async function threadId(db: Db, type: string, id: string, create: boolean) {
  const t = await db.query(`select id from threads where entity_type = $1 and entity_id = $2`, [type, id]);
  if (t.rows[0]) return t.rows[0].id as string;
  if (!create) return null;
  const n = await db.query(
    `insert into threads (company_id, entity_type, entity_id) values (app_company_id(), $1, $2) on conflict (company_id, entity_type, entity_id) do update set entity_type = excluded.entity_type returning id`,
    [type, id],
  );
  return n.rows[0].id as string;
}

const MeetingInput = z.object({
  title: z.string().min(3).max(200),
  startsAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(600).default(60),
  location: z.string().max(200).optional(),
  agenda: z.string().max(8000).optional(),
  participantIds: z.array(z.string().uuid()).max(50).default([]),
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
});

async function loadMeeting(db: Db, id: string) {
  const m = await db.query(
    `select m.id, m.code, m.title, m.starts_at as "startsAt", m.duration_minutes as "durationMinutes", m.location, m.agenda, m.notes, m.status,
            m.entity_type as "entityType", m.entity_id as "entityId", m.organizer_id as "organizerId", o.name as "organizerName",
            m.closed_at as "closedAt", cu.name as "closedBy", m.cancel_reason as "cancelReason", m.created_at as "createdAt"
       from meetings m join users o on o.id = m.organizer_id left join users cu on cu.id = m.closed_by where m.id = $1`,
    [id],
  );
  if (!m.rows[0]) throw notFound("Toplantı");
  const participants = await db.query(
    `select p.user_id as "userId", u.name, p.attendance from meeting_participants p join users u on u.id = p.user_id where p.meeting_id = $1 order by u.name`,
    [id],
  );
  const items = await db.query(
    `select i.id, i.seq, i.kind, i.text, i.owner_user_id as "ownerUserId", u.name as "ownerName", i.due_date::text as "dueDate", i.task_id as "taskId", t.status as "taskStatus"
       from meeting_items i left join users u on u.id = i.owner_user_id left join tasks t on t.id = i.task_id where i.meeting_id = $1 order by i.seq`,
    [id],
  );
  const row = m.rows[0];
  const entityLabelText = row.entityType ? await entityLabel(db, row.entityType, row.entityId).catch(() => null) : null;
  return { ...row, entityLabel: entityLabelText, entityLink: row.entityType ? ENTITY[row.entityType]?.link(row.entityId) ?? null : null, participants: participants.rows, items: items.rows };
}

/** RFC 5545 metin kaçışı (virgül, noktalı virgül, ters eğik çizgi, satır sonu). */
function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** RFC 5545 satır katlama: 75 oktetten uzun satırlar devam satırına (boşlukla başlayan) bölünür. */
function icsFold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // çok baytlı bir karakterin ortasından kesmemek için geri çekil
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // devam satırındaki baştaki boşluk 1 bayt yer kaplar
  }
  return parts.join("\r\n ");
}

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Toplantıdan standart bir iCalendar (.ics) davet dosyası üretir — gerçek dış takvim bağlayıcısı yok, elle içe aktarılır. */
function buildMeetingIcs(
  m: Awaited<ReturnType<typeof loadMeeting>>,
  organizer: { email: string; name: string } | undefined,
  attendees: { email: string; name: string }[],
) {
  const start = new Date(m.startsAt);
  const end = new Date(start.getTime() + m.durationMinutes * 60_000);
  const status = m.status === "cancelled" ? "CANCELLED" : m.status === "closed" ? "CONFIRMED" : "CONFIRMED";
  const descParts = [m.agenda ? `Gündem: ${m.agenda}` : null, m.entityLabel ? `Bağlı kayıt: ${m.entityLabel}` : null].filter(Boolean);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//apisfactory//TR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:meeting-${m.id}@apisfactory`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(`${m.code} ${m.title}`)}`,
    m.location ? `LOCATION:${icsEscape(m.location)}` : null,
    descParts.length ? `DESCRIPTION:${icsEscape(descParts.join("\n"))}` : null,
    `STATUS:${status}`,
    organizer?.email ? `ORGANIZER;CN=${icsEscape(organizer.name)}:mailto:${organizer.email}` : null,
    ...attendees.filter((a) => a.email).map((a) => `ATTENDEE;CN=${icsEscape(a.name)};ROLE=REQ-PARTICIPANT:mailto:${a.email}`),
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((l): l is string => l !== null);
  const content = lines.map(icsFold).join("\r\n") + "\r\n";
  const safeCode = m.code.replace(/[^A-Za-z0-9_-]/g, "");
  return { content, fileName: `toplanti-${safeCode}.ics` };
}

export async function collaborationRoutes(app: FastifyInstance) {
  // ---- Mesajlaşma ------------------------------------------------------------------------
  app.get("/api/threads/:entityType/:entityId", async (req) => {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };
    const e = ENTITY[entityType];
    if (!e) throw badRequest("Bilinmeyen kayıt türü");
    const c = ctxOf(req);
    return tenant(req, e.perm, async (db) => {
      const label = await entityLabel(db, entityType, entityId);
      const tid = await threadId(db, entityType, entityId, false);
      if (!tid) return { entityType, entityId, label, messages: [], lastReadAt: null };
      const r = await db.query(
        `select m.id, m.author_id as "authorId", u.name as "authorName", case when m.retracted_at is null then m.body end as body,
                m.reply_to as "replyTo", m.created_at as "createdAt", m.retracted_at as "retractedAt", m.retract_reason as "retractReason",
                coalesce((select json_agg(json_build_object('userId', mm.user_id, 'name', mu.name)) from message_mentions mm join users mu on mu.id = mm.user_id where mm.message_id = m.id), '[]') as mentions,
                coalesce((select json_agg(json_build_object('id', a.id, 'fileName', a.file_name, 'contentType', a.content_type, 'sizeBytes', a.size_bytes) order by a.created_at)
                            from message_attachments a where a.message_id = m.id and m.retracted_at is null), '[]') as attachments
           from messages m join users u on u.id = m.author_id where m.thread_id = $1 order by m.created_at, m.id limit 500`,
        [tid],
      );
      const read = await db.query(`select last_read_at from thread_reads where thread_id = $1 and user_id = $2`, [tid, c.userId]);
      return { entityType, entityId, label, messages: r.rows, lastReadAt: read.rows[0]?.last_read_at ?? null };
    });
  });

  /** Okundu: konuşmanın okunma zamanı ve bu konuşmadaki bahsetmeler. */
  app.post("/api/threads/:entityType/:entityId/read", async (req) => {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };
    const e = ENTITY[entityType];
    if (!e) throw badRequest("Bilinmeyen kayıt türü");
    return tenant(req, e.perm, async (db, actor) => {
      const tid = await threadId(db, entityType, entityId, false);
      if (!tid) return { read: 0 };
      await db.query(
        `insert into thread_reads (company_id, thread_id, user_id) values (app_company_id(), $1, $2) on conflict (thread_id, user_id) do update set last_read_at = now()`,
        [tid, actor.userId],
      );
      const r = await db.query(
        `update message_mentions set read_at = now() where user_id = $1 and read_at is null and message_id in (select id from messages where thread_id = $2)`,
        [actor.userId, tid],
      );
      return { read: r.rowCount ?? 0 };
    });
  });

  /** Bahsedilebilecek kişiler: kaydı görme yetkisi olan aktif üyeler. */
  app.get("/api/threads/:entityType/:entityId/mentionable", async (req) => {
    const { entityType } = req.params as { entityType: string; entityId: string };
    const e = ENTITY[entityType];
    if (!e) throw badRequest("Bilinmeyen kayıt türü");
    return tenant(req, e.perm, async (db) => {
      const r = await db.query(
        `select distinct u.id, u.name from memberships m join users u on u.id = m.user_id join membership_roles mr on mr.membership_id = m.id
           join role_permissions rp on rp.role_id = mr.role_id where m.status = 'active' and rp.permission = $1 order by u.name`,
        [e.perm],
      );
      return r.rows;
    });
  });

  app.post("/api/threads/:entityType/:entityId/messages", async (req) => {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };
    const e = ENTITY[entityType];
    if (!e) throw badRequest("Bilinmeyen kayıt türü");
    const input = parse(
      z.object({ body: z.string().trim().min(1).max(4000), mentions: z.array(z.string().uuid()).max(20).default([]), replyTo: z.string().uuid().optional(), attachments: z.array(AttachmentInput).max(MAX_ATTACHMENTS).default([]) }),
      req.body,
    );
    const files = input.attachments.map((a) => {
      const buf = Buffer.from(a.contentBase64, "base64");
      if (!buf.length || buf.length > MAX_ATTACHMENT_BYTES) throw badRequest(`${a.fileName}: dosya boyutu sınırın dışında (en fazla ${MAX_ATTACHMENT_BYTES / 1_000_000} MB)`);
      return { fileName: a.fileName, contentType: a.contentType, buf, sha: createHash("sha256").update(buf).digest("hex") };
    });
    if (files.reduce((n, f) => n + f.buf.length, 0) > MAX_ATTACHMENTS_TOTAL_BYTES) throw badRequest(`Ekler toplamda ${MAX_ATTACHMENTS_TOTAL_BYTES / 1_000_000} MB'ı aşamaz`);
    return tenant(req, e.perm, (db, actor) =>
      idempotent(db, actor.companyId, "message_post", idempotencyKey(req), async () => {
        const label = await entityLabel(db, entityType, entityId);
        const tid = (await threadId(db, entityType, entityId, true))!;
        if (input.replyTo) {
          const rt = await db.query(`select 1 from messages where id = $1 and thread_id = $2`, [input.replyTo, tid]);
          if (!rt.rowCount) throw badRequest("Yanıtlanan mesaj bu konuşmada değil");
        }
        const mentionIds = [...new Set(input.mentions)].filter((u) => u !== actor.userId);
        const perms = await userPerms(db, mentionIds);
        const noAccess = mentionIds.filter((u) => !perms.get(u)?.perms.has(e.perm));
        if (noAccess.length) {
          // Yetkisi olmayan kişiye kaydın içeriği bildirimle sızdırılmaz.
          throw conflict("mention_no_access", "Bahsedilen kişilerden bazıları bu kaydı görme yetkisine sahip değil veya şirkette aktif değil", { userIds: noAccess, names: noAccess.map((u) => perms.get(u)?.name ?? null) });
        }
        const id = randomUUID();
        await db.query(
          `insert into messages (id, company_id, thread_id, author_id, body, reply_to) values ($1, app_company_id(), $2, $3, $4, $5)`,
          [id, tid, actor.userId, input.body, input.replyTo ?? null],
        );
        for (const f of files) {
          await db.query(
            `insert into message_attachments (company_id, message_id, file_name, content_type, size_bytes, sha256, content, uploaded_by)
             values (app_company_id(), $1, $2, $3, $4, $5, $6, $7)`,
            [id, f.fileName, f.contentType, f.buf.length, f.sha, f.buf, actor.userId],
          );
        }
        for (const u of mentionIds) {
          await db.query(`insert into message_mentions (company_id, message_id, user_id) values (app_company_id(), $1, $2)`, [id, u]);
          await enqueue(db, actor.companyId, "notification.mention", { messageId: id, userId: u, entityType, entityId, label });
        }
        await db.query(
          `insert into thread_reads (company_id, thread_id, user_id) values (app_company_id(), $1, $2) on conflict (thread_id, user_id) do update set last_read_at = now()`,
          [tid, actor.userId],
        );
        return { id, threadId: tid, mentioned: mentionIds.length, attachments: files.length };
      }),
    );
  });

  app.post("/api/messages/:id/retract", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(300) }), req.body);
    return tenant(req, "task.view", async (db, actor) => {
      const m = (await db.query(`select m.author_id, m.retracted_at, t.entity_type, t.entity_id from messages m join threads t on t.id = m.thread_id where m.id = $1`, [id])).rows[0];
      if (!m) throw notFound("Mesaj");
      if (m.author_id !== actor.userId) throw forbidden();
      if (m.retracted_at) throw conflict("invalid_transition", "Mesaj zaten geri çekilmiş");
      await db.query(`update messages set retracted_at = now(), retract_reason = $2 where id = $1`, [id, input.reason]);
      await recordEvent(db, actor, { entityType: m.entity_type, entityId: m.entity_id, eventType: "message.retracted", after: { messageId: id }, reason: input.reason });
      return { id, retracted: true };
    });
  });

  /** Ek dosya indirme: mesajın bağlı olduğu kaydı görme yetkisi gerekir. */
  app.get("/api/attachments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await tenant(req, null, async (db) => {
      const a = (await db.query(
        `select a.file_name as "fileName", a.content_type as "contentType", a.content, t.entity_type as "entityType"
           from message_attachments a join messages m on m.id = a.message_id join threads t on t.id = m.thread_id where a.id = $1`,
        [id],
      )).rows[0];
      if (!a) throw notFound("Ek");
      const e = ENTITY[a.entityType];
      if (!e) throw notFound("Ek");
      need(req, e.perm);
      return a;
    });
    reply.header("content-type", out.contentType).header("content-disposition", `inline; filename="${encodeURIComponent(out.fileName)}"`);
    return out.content;
  });

  // ---- Kanallar ---------------------------------------------------------------------------
  app.get("/api/channels", async (req) =>
    tenant(req, "task.view", async (db) => {
      const r = await db.query(
        `select c.id, c.code, c.name, c.description, c.archived_at as "archivedAt", u.name as "createdBy", c.created_at as "createdAt",
                (select max(m.created_at) from threads t join messages m on m.thread_id = t.id where t.entity_type = 'channel' and t.entity_id = c.id) as "lastMessageAt"
           from channels c left join users u on u.id = c.created_by
          order by c.archived_at is not null, coalesce((select max(m.created_at) from threads t join messages m on m.thread_id = t.id where t.entity_type = 'channel' and t.entity_id = c.id), c.created_at) desc`,
      );
      return r.rows;
    }),
  );

  app.post("/api/channels", async (req) => {
    const input = parse(z.object({ name: z.string().trim().min(2).max(100), description: z.string().max(2000).optional() }), req.body);
    return tenant(req, "task.view", async (db, actor) => {
      const code = await nextCode(db, actor.companyId, "channel", "KNL");
      const r = await db.query(
        `insert into channels (company_id, code, name, description, created_by) values (app_company_id(), $1, $2, $3, $4) returning id, code`,
        [code, input.name, input.description ?? null, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "channel", entityId: r.rows[0].id, eventType: "created", after: { code, name: input.name } });
      return r.rows[0];
    });
  });

  app.post("/api/channels/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "task.view", async (db, actor) => {
      const c = (await db.query(`select code, created_by, archived_at from channels where id = $1 for update`, [id])).rows[0];
      if (!c) throw notFound("Kanal");
      if (c.archived_at) throw conflict("invalid_transition", "Kanal zaten arşivlenmiş");
      if (c.created_by !== actor.userId) need(req, "task.manage");
      await db.query(`update channels set archived_at = now(), archived_by = $2 where id = $1`, [id, actor.userId]);
      await recordEvent(db, actor, { entityType: "channel", entityId: id, eventType: "archived", reason: input.reason });
      return { id, archived: true };
    });
  });

  /** Bahsedildiğim mesajlar (okunmamışlar önce); kaydı artık göremiyorsam listelenmez. */
  app.get("/api/mentions", async (req) => {
    const q = z.object({ unread: z.coerce.boolean().optional() }).parse(req.query);
    const c = ctxOf(req);
    return tenant(req, "task.view", async (db) => {
      const r = await db.query(
        `select m.id as "messageId", t.entity_type as "entityType", t.entity_id as "entityId", u.name as "authorName",
                case when m.retracted_at is null then left(m.body, 280) end as excerpt, m.created_at as "createdAt", mm.read_at as "readAt"
           from message_mentions mm join messages m on m.id = mm.message_id join threads t on t.id = m.thread_id join users u on u.id = m.author_id
          where mm.user_id = $1 and ($2::boolean is not true or mm.read_at is null)
          order by (mm.read_at is null) desc, m.created_at desc limit 100`,
        [c.userId, q.unread ?? null],
      );
      const out = [];
      for (const x of r.rows) {
        const e = ENTITY[x.entityType];
        if (!e || !can(req, e.perm)) continue;
        out.push({ ...x, label: await entityLabel(db, x.entityType, x.entityId).catch(() => null), link: e.link(x.entityId) });
      }
      return out;
    });
  });

  // ---- Toplantı -------------------------------------------------------------------------
  app.get("/api/meetings", async (req) => {
    const q = z.object({ scope: z.enum(["upcoming", "past", "mine", "all"]).default("upcoming") }).parse(req.query);
    const c = ctxOf(req);
    return tenant(req, "task.view", async (db) => {
      const r = await db.query(
        `select m.id, m.code, m.title, m.starts_at as "startsAt", m.duration_minutes as "durationMinutes", m.location, m.status, o.name as "organizerName",
                (select count(*) from meeting_participants p where p.meeting_id = m.id)::int as participants,
                (select count(*) from meeting_items i where i.meeting_id = m.id and i.kind = 'action')::int as actions,
                (select count(*) from meeting_items i join tasks t on t.id = i.task_id where i.meeting_id = m.id and t.status in ('open', 'in_progress', 'blocked'))::int as "openActions",
                exists (select 1 from meeting_participants p where p.meeting_id = m.id and p.user_id = $2) as "isParticipant"
           from meetings m join users o on o.id = m.organizer_id
          where case $1 when 'upcoming' then m.status = 'planned'
                        when 'past' then m.status <> 'planned'
                        when 'mine' then exists (select 1 from meeting_participants p where p.meeting_id = m.id and p.user_id = $2)
                        else true end
          order by case when $1 = 'upcoming' then m.starts_at end asc, m.starts_at desc limit 200`,
        [q.scope, c.userId],
      );
      return r.rows;
    });
  });

  app.post("/api/meetings", async (req) => {
    const input = parse(MeetingInput, req.body);
    return tenant(req, "task.manage", (db, actor) =>
      idempotent(db, actor.companyId, "meeting_create", idempotencyKey(req), async () => {
        if (!!input.entityType !== !!input.entityId) throw badRequest("Bağlantı türü ve kaydı birlikte verilmeli");
        if (input.entityType) {
          if (input.entityType === "meeting") throw badRequest("Toplantı başka toplantıya bağlanamaz");
          await entityLabel(db, input.entityType, input.entityId!);
        }
        const ids = [...new Set([actor.userId!, ...input.participantIds])];
        const members = await userPerms(db, ids);
        const missing = ids.filter((u) => !members.has(u));
        if (missing.length) throw conflict("not_member", "Katılımcılardan bazıları şirkette aktif üye değil", { userIds: missing });
        const code = await nextCode(db, actor.companyId, "meeting", "TOP");
        const id = randomUUID();
        await db.query(
          `insert into meetings (id, company_id, code, title, starts_at, duration_minutes, location, agenda, entity_type, entity_id, organizer_id)
           values ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, code, input.title, input.startsAt, input.durationMinutes, input.location ?? null, input.agenda ?? null, input.entityType ?? null, input.entityId ?? null, actor.userId],
        );
        for (const u of ids) {
          await db.query(`insert into meeting_participants (company_id, meeting_id, user_id) values (app_company_id(), $1, $2)`, [id, u]);
          if (u !== actor.userId) await enqueue(db, actor.companyId, "notification.meeting_invite", { meetingId: id, userId: u, code, title: input.title, startsAt: input.startsAt });
        }
        await recordEvent(db, actor, { entityType: "meeting", entityId: id, eventType: "created", after: { code, ...input } });
        return loadMeeting(db, id);
      }),
    );
  });

  app.get("/api/meetings/:id", async (req) => tenant(req, "task.view", (db) => loadMeeting(db, (req.params as { id: string }).id)));

  /**
   * Takvim daveti (.ics) — gerçek bir dış takvim/toplantı bağlayıcısı yok (bilinen sınır); bunun yerine
   * standart bir iCalendar dosyası üretilir, katılımcı kendi takvim uygulamasına (Outlook/Google/…) elle
   * içe aktarır. Sunucu hiçbir zamanı uydurmaz — toplantının kendi tarih/süresi kullanılır.
   */
  app.get("/api/meetings/:id/ics", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ics = await tenant(req, "task.view", async (db) => {
      const m = await loadMeeting(db, id);
      const organizer = (await db.query(`select u.email, u.name from users u where u.id = $1`, [m.organizerId])).rows[0];
      const attendeeEmails = await db.query(
        `select u.email, u.name from meeting_participants p join users u on u.id = p.user_id where p.meeting_id = $1 order by u.name`,
        [id],
      );
      return buildMeetingIcs(m, organizer, attendeeEmails.rows);
    });
    reply.header("content-type", "text/calendar; charset=utf-8").header("content-disposition", `attachment; filename="${ics.fileName}"`);
    return ics.content;
  });

  /** Düzenleme yetkisi: düzenleyen veya görev yöneticisi. */
  async function editable(db: Db, id: string, userId: string, canManage: boolean) {
    const m = (await db.query(`select organizer_id, status from meetings where id = $1 for update`, [id])).rows[0];
    if (!m) throw notFound("Toplantı");
    if (m.organizer_id !== userId && !canManage) throw forbidden("task.manage");
    if (m.status !== "planned") throw conflict("meeting_closed", "Kapanmış veya iptal edilmiş toplantı değiştirilemez");
    return m;
  }

  app.post("/api/meetings/:id/update", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        title: z.string().min(3).max(200).optional(), startsAt: z.string().datetime({ offset: true }).optional(), durationMinutes: z.number().int().min(5).max(600).optional(),
        location: z.string().max(200).nullable().optional(), agenda: z.string().max(8000).nullable().optional(), notes: z.string().max(20000).nullable().optional(),
      }),
      req.body,
    );
    return tenant(req, "task.view", async (db, actor) => {
      await editable(db, id, actor.userId, can(req, "task.manage"));
      await db.query(
        `update meetings set title = coalesce($2, title), starts_at = coalesce($3, starts_at), duration_minutes = coalesce($4, duration_minutes),
                location = case when $5 then $6 else location end, agenda = case when $7 then $8 else agenda end, notes = case when $9 then $10 else notes end
          where id = $1`,
        [id, input.title ?? null, input.startsAt ?? null, input.durationMinutes ?? null, input.location !== undefined, input.location ?? null, input.agenda !== undefined, input.agenda ?? null, input.notes !== undefined, input.notes ?? null],
      );
      if (input.startsAt) await recordEvent(db, actor, { entityType: "meeting", entityId: id, eventType: "rescheduled", after: { startsAt: input.startsAt } });
      return loadMeeting(db, id);
    });
  });

  app.post("/api/meetings/:id/participants", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ userId: z.string().uuid(), action: z.enum(["add", "remove"]).default("add"), attendance: z.enum(["invited", "attended", "absent", "excused"]).optional() }), req.body);
    return tenant(req, "task.view", async (db, actor) => {
      const m = await editable(db, id, actor.userId, can(req, "task.manage"));
      if (input.action === "remove") {
        if (input.userId === m.organizer_id) throw conflict("organizer", "Düzenleyen çıkarılamaz");
        await db.query(`delete from meeting_participants where meeting_id = $1 and user_id = $2`, [id, input.userId]);
      } else {
        const mem = await userPerms(db, [input.userId]);
        if (!mem.has(input.userId)) throw conflict("not_member", "Kişi şirkette aktif üye değil");
        const r = await db.query(
          `insert into meeting_participants (company_id, meeting_id, user_id, attendance) values (app_company_id(), $1, $2, coalesce($3, 'invited'))
           on conflict (meeting_id, user_id) do update set attendance = coalesce($3, meeting_participants.attendance) returning (xmax = 0) as inserted`,
          [id, input.userId, input.attendance ?? null],
        );
        if (r.rows[0].inserted) await enqueue(db, actor.companyId, "notification.meeting_invite", { meetingId: id, userId: input.userId });
      }
      return loadMeeting(db, id);
    });
  });

  app.post("/api/meetings/:id/items", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({ kind: z.enum(["decision", "action", "info"]), text: z.string().trim().min(3).max(2000), ownerUserId: z.string().uuid().optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
      req.body,
    );
    return tenant(req, "task.view", async (db, actor) => {
      await editable(db, id, actor.userId, can(req, "task.manage"));
      if (input.kind === "action") {
        if (!input.ownerUserId || !input.dueDate) throw badRequest("Aksiyon için sorumlu ve bitiş tarihi zorunlu");
        const mem = await userPerms(db, [input.ownerUserId]);
        if (!mem.has(input.ownerUserId)) throw conflict("not_member", "Sorumlu şirkette aktif üye değil");
      }
      const seq = (await db.query(`select coalesce(max(seq), 0) + 1 as n from meeting_items where meeting_id = $1`, [id])).rows[0].n;
      await db.query(
        `insert into meeting_items (company_id, meeting_id, seq, kind, text, owner_user_id, due_date, created_by) values (app_company_id(), $1, $2, $3, $4, $5, $6, $7)`,
        [id, seq, input.kind, input.text, input.kind === "action" ? input.ownerUserId : input.ownerUserId ?? null, input.kind === "action" ? input.dueDate : null, actor.userId],
      );
      return loadMeeting(db, id);
    });
  });

  app.post("/api/meetings/:id/items/:itemId/remove", async (req) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    return tenant(req, "task.view", async (db, actor) => {
      await editable(db, id, actor.userId, can(req, "task.manage"));
      const r = await db.query(`delete from meeting_items where id = $1 and meeting_id = $2`, [itemId, id]);
      if (!r.rowCount) throw notFound("Tutanak maddesi");
      return loadMeeting(db, id);
    });
  });

  /**
   * Tutanağı kapat: katılım işaretlenmiş olmalı, en az bir madde olmalı. Aksiyonlar sorumlusuna görev olarak açılır
   * (toplantıya bağlı, bitiş tarihli); tutanak ve kararlar bundan sonra değişmez. Katılımcılara özet bildirimi (test modu).
   */
  app.post("/api/meetings/:id/close", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "task.view", async (db, actor) => {
      await editable(db, id, actor.userId, can(req, "task.manage"));
      const m = (await db.query(`select code, title, notes from meetings where id = $1`, [id])).rows[0];
      const pending = await db.query(`select count(*)::int as n from meeting_participants where meeting_id = $1 and attendance = 'invited'`, [id]);
      if (pending.rows[0].n) throw conflict("attendance_missing", `${pending.rows[0].n} katılımcının katılım durumu işaretlenmedi`);
      const items = (await db.query(`select id, seq, kind, text, owner_user_id, due_date::text as due from meeting_items where meeting_id = $1 order by seq`, [id])).rows;
      if (!items.length) throw conflict("minutes_empty", "Tutanakta en az bir karar, aksiyon veya bilgi maddesi olmalı");
      const created: string[] = [];
      for (const i of items.filter((x) => x.kind === "action")) {
        const taskId = randomUUID();
        await db.query(
          `insert into tasks (id, company_id, title, description, assignee_user_id, priority, start_date, due_date, entity_type, entity_id, kind, created_by)
           values ($1, app_company_id(), $2, $3, $4, 'normal', least(current_date, $5::date), $5::date, 'meeting', $6, 'manual', $7)`,
          [taskId, i.text.length > 200 ? `${i.text.slice(0, 197)}…` : i.text, `${m.code} ${m.title} — aksiyon #${i.seq}\n${i.text}`, i.owner_user_id, i.due, id, actor.userId],
        );
        await db.query(`update meeting_items set task_id = $2 where id = $1`, [i.id, taskId]);
        await recordEvent(db, actor, { entityType: "task", entityId: taskId, eventType: "created", after: { source: "meeting", meetingId: id, seq: i.seq, assigneeUserId: i.owner_user_id, dueDate: i.due } });
        created.push(taskId);
      }
      await db.query(`update meetings set status = 'closed', closed_at = now(), closed_by = $2 where id = $1`, [id, actor.userId]);
      const parts = (await db.query(`select user_id from meeting_participants where meeting_id = $1`, [id])).rows;
      for (const p of parts) await enqueue(db, actor.companyId, "notification.meeting_minutes", { meetingId: id, userId: p.user_id, code: m.code, actions: created.length });
      await recordEvent(db, actor, { entityType: "meeting", entityId: id, eventType: "closed", after: { items: items.length, tasksCreated: created.length } });
      return { ...(await loadMeeting(db, id)), tasksCreated: created.length };
    });
  });

  app.post("/api/meetings/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "task.view", async (db, actor) => {
      await editable(db, id, actor.userId, can(req, "task.manage"));
      await db.query(`update meetings set status = 'cancelled', cancel_reason = $2 where id = $1`, [id, input.reason]);
      const parts = (await db.query(`select user_id from meeting_participants where meeting_id = $1 and user_id <> $2`, [id, actor.userId])).rows;
      for (const p of parts) await enqueue(db, actor.companyId, "notification.meeting_cancelled", { meetingId: id, userId: p.user_id });
      await recordEvent(db, actor, { entityType: "meeting", entityId: id, eventType: "cancelled", reason: input.reason });
      return loadMeeting(db, id);
    });
  });
}
