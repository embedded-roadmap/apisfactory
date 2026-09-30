import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { encryptSecret } from "../lib/secrets";
import { channelOf, EMAIL_TOPICS, transportFor } from "../lib/email";
import { parse, tenant } from "../http/context";

/**
 * Oturum 41 devamı — dış bağımlılık 4: bildirim e-postası ayarı (şirket başına SMTP).
 * SMTP her e-posta sağlayıcısında standart olduğundan müşteri kendi sağlayıcısını seçer (sunucu/port/kullanıcı).
 * Parola şifreli saklanır, hiçbir yanıtta ve olay kaydında yer almaz (yalnız "kayıtlı mı").
 */

const SettingsInput = z
  .object({
    mode: z.enum(["off", "test", "live"]),
    host: z.string().trim().min(3).max(253).regex(/^[a-zA-Z0-9.-]+$/, "Geçersiz sunucu adı").nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    secure: z.boolean().default(false),
    username: z.string().trim().max(254).nullable().optional(),
    /** Boş bırakılırsa mevcut parola korunur; null gönderilirse silinir. */
    password: z.string().min(1).max(512).nullable().optional(),
    fromAddress: z.string().trim().email().max(254).nullable().optional(),
    fromName: z.string().trim().max(120).nullable().optional(),
    replyTo: z.string().trim().email().max(254).nullable().optional(),
    topics: z.array(z.enum(EMAIL_TOPICS)).max(EMAIL_TOPICS.length),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "live" && (!v.host || !v.port || !v.fromAddress))
      ctx.addIssue({ code: "custom", path: ["mode"], message: "Canlı mod için sunucu, port ve gönderen adresi gerekli" });
  });

const view = (r: Record<string, any> | null) =>
  r
    ? { mode: r.mode, host: r.host, port: r.port, secure: r.secure, username: r.username, hasPassword: Boolean(r.credentials_enc), fromAddress: r.from_address, fromName: r.from_name, replyTo: r.reply_to, topics: r.topics, updatedAt: r.updated_at }
    : { mode: "off", host: null, port: null, secure: false, username: null, hasPassword: false, fromAddress: null, fromName: null, replyTo: null, topics: [...EMAIL_TOPICS], updatedAt: null };

export async function notificationRoutes(app: FastifyInstance) {
  app.get("/api/email-channel", async (req) => tenant(req, "workflow.manage", async (db) => ({ ...view(await channelOf(db)), topicOptions: EMAIL_TOPICS })));

  app.put("/api/email-channel", async (req) => {
    const input = parse(SettingsInput, req.body);
    return tenant(req, "workflow.manage", async (db, actor) => {
      const cur = (await db.query(`select * from email_channels for update`)).rows[0] ?? null;
      const enc = input.password === undefined ? (cur?.credentials_enc ?? null) : input.password === null ? null : encryptSecret({ password: input.password });
      const vals = [input.mode, input.host ?? null, input.port ?? null, input.secure, input.username ?? null, enc, input.fromAddress ?? null, input.fromName ?? null, input.replyTo ?? null, input.topics, actor.userId];
      await db.query(
        `insert into email_channels (company_id, mode, host, port, secure, username, credentials_enc, from_address, from_name, reply_to, topics, updated_by, updated_at)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
         on conflict (company_id) do update set mode = $1, host = $2, port = $3, secure = $4, username = $5, credentials_enc = $6, from_address = $7,
           from_name = $8, reply_to = $9, topics = $10, updated_by = $11, updated_at = now()`,
        vals,
      );
      const next = (await db.query(`select * from email_channels`)).rows[0];
      const safe = (r: Record<string, any> | null) => (r ? (({ updatedAt: _u, ...rest }) => rest)(view(r)) : null);
      await recordEvent(db, actor, {
        entityType: "email_channel", entityId: actor.companyId, eventType: "updated", before: safe(cur), after: { ...safe(next), passwordChanged: input.password !== undefined }, reason: input.reason,
      });
      return view(next);
    });
  });

  /**
   * Kayıtlı ayarla deneme e-postası gönderir (mod ne olursa olsun — ayarı canlıya almadan doğrulamak için).
   * Kötüye kullanım olmasın diye alıcı yalnız isteği yapan kullanıcının kendi adresidir.
   */
  app.post("/api/email-channel/test", async (req) =>
    tenant(req, "workflow.manage", async (db, actor) => {
      const ch = await channelOf(db);
      if (!ch?.host || !ch.port || !ch.from_address) throw badRequest("Önce sunucu, port ve gönderen adresini kaydedin");
      const to = (await db.query(`select email from users where id = $1`, [actor.userId])).rows[0]?.email as string;
      const subject = "Deneme e-postası — bildirim ayarı";
      let status = "sent";
      let error: string | null = null;
      let messageId: string | null = null;
      try {
        const info = await transportFor(ch).sendMail({ from: ch.from_name ? { name: ch.from_name, address: ch.from_address } : ch.from_address, replyTo: ch.reply_to ?? undefined, to, subject, text: "Bu e-posta bildirim ayarını doğrulamak için gönderildi." });
        messageId = info.messageId ?? null;
      } catch (e) {
        status = "failed";
        error = (e as Error).message.slice(0, 300);
      }
      await db.query(`insert into email_deliveries (company_id, topic, recipient, subject, status, error, message_id) values (app_company_id(), 'test_send', $1, $2, $3, $4, $5)`, [to, subject, status, error, messageId]);
      return { ok: status === "sent", to, error };
    }),
  );

  app.get("/api/email-deliveries", async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return tenant(req, "workflow.manage", async (db) =>
      (await db.query(`select id, topic, recipient, subject, status, error, message_id as "messageId", created_at as "createdAt" from email_deliveries order by created_at desc, id limit $1`, [q.limit])).rows,
    );
  });
}
