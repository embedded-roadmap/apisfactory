import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { decryptSecret, encryptSecret } from "../lib/secrets";
import { channelOf, EMAIL_TOPICS, transportFor } from "../lib/email";
import { normalizeTrMobile, SMS_PROVIDERS, SmsError, smsChannelOf } from "../lib/sms";
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

  // ---- SMS (Netgsm / Verimor) ----------------------------------------------------------------------------------
  const smsView = (r: Record<string, any> | null) => ({
    mode: r?.mode ?? "off", provider: r?.provider ?? null, sender: r?.sender ?? null, hasCredentials: Boolean(r?.credentials_enc),
    topics: r?.topics ?? ["escalation", "customer_reminder"], updatedAt: r?.updated_at ?? null,
  });
  const providers = Object.fromEntries(Object.entries(SMS_PROVIDERS).map(([k, p]) => [k, { label: p.label, credentialFields: p.credentialFields, docsUrl: p.docsUrl, verified: p.verified }]));

  app.get("/api/sms-channel", async (req) =>
    tenant(req, "workflow.manage", async (db) => ({ ...smsView((await db.query(`select * from sms_channels`)).rows[0] ?? null), providers, topicOptions: EMAIL_TOPICS })));

  app.put("/api/sms-channel", async (req) => {
    const input = parse(
      z.object({
        mode: z.enum(["off", "test", "live"]),
        provider: z.enum(["netgsm", "verimor"]).nullable(),
        sender: z.string().trim().regex(/^[A-Za-z0-9 .-]{2,11}$/, "Başlık 2–11 karakter (harf, rakam, boşluk, nokta, tire)").nullable(),
        /** Boş bırakılırsa mevcut erişim bilgisi korunur; sağlayıcı değişirse yeniden girilmelidir. */
        credentials: z.record(z.string().min(1).max(60), z.string().min(1).max(200)).optional(),
        topics: z.array(z.enum(EMAIL_TOPICS)).max(EMAIL_TOPICS.length),
        reason: z.string().trim().max(500).optional(),
      }),
      req.body,
    );
    return tenant(req, "workflow.manage", async (db, actor) => {
      const cur = (await db.query(`select * from sms_channels for update`)).rows[0] ?? null;
      let enc: string | null = cur?.credentials_enc ?? null;
      if (input.credentials) {
        const fields = input.provider ? SMS_PROVIDERS[input.provider]!.credentialFields : [];
        const missing = fields.filter((f) => !input.credentials![f]);
        if (!input.provider || missing.length) throw badRequest(`Erişim bilgisi eksik: ${missing.join(", ") || "sağlayıcı"}`);
        enc = encryptSecret(Object.fromEntries(fields.map((f) => [f, input.credentials![f]])));
      } else if (cur && cur.provider !== input.provider) enc = null; // başka sağlayıcının bilgisi taşınmaz
      if (input.mode === "live" && (!input.provider || !input.sender || !enc)) throw badRequest("Canlı mod için sağlayıcı, gönderici başlığı ve erişim bilgisi gerekli");
      await db.query(
        `insert into sms_channels (company_id, mode, provider, sender, credentials_enc, topics, updated_by, updated_at)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, now())
         on conflict (company_id) do update set mode = $1, provider = $2, sender = $3, credentials_enc = $4, topics = $5, updated_by = $6, updated_at = now()`,
        [input.mode, input.provider, input.sender, enc, input.topics, actor.userId],
      );
      const next = (await db.query(`select * from sms_channels`)).rows[0];
      const safe = (r: Record<string, any> | null) => (r ? (({ updatedAt: _u, ...rest }) => rest)(smsView(r)) : null);
      await recordEvent(db, actor, { entityType: "sms_channel", entityId: actor.companyId, eventType: "updated", before: safe(cur), after: { ...safe(next), credentialsChanged: Boolean(input.credentials) }, reason: input.reason });
      return smsView(next);
    });
  });

  /** Deneme SMS'i: yalnız isteyenin kendi kayıtlı telefonuna (kötüye kullanım olmasın), mod ne olursa olsun. */
  app.post("/api/sms-channel/test", async (req) =>
    tenant(req, "workflow.manage", async (db, actor) => {
      const ch = await smsChannelOf(db);
      const p = SMS_PROVIDERS[ch?.provider ?? ""];
      if (!ch || !p || !ch.sender || !ch.credentials_enc) throw badRequest("Önce sağlayıcı, başlık ve erişim bilgisini kaydedin");
      const to = (await db.query(`select notify_phone from memberships where user_id = $1 and company_id = app_company_id()`, [actor.userId])).rows[0]?.notify_phone as string | null;
      if (!to) throw badRequest("Önce Parola sayfasından kendi bildirim telefonunuzu girin");
      let status = "sent";
      let error: string | null = null;
      let ref: string | null = null;
      try {
        ref = await p.send(to, "Deneme SMS'i — bildirim ayarı doğrulaması", ch.sender, decryptSecret<Record<string, string>>(ch.credentials_enc), `test-${Date.now()}`);
      } catch (e) {
        status = "failed";
        error = (e instanceof SmsError ? e.message : "gönderilemedi").slice(0, 300);
      }
      await db.query(`insert into sms_deliveries (company_id, topic, recipient, status, error, provider_ref) values (app_company_id(), 'test_send', $1, $2, $3, $4)`, [to, status, error, ref]);
      return { ok: status === "sent", to, error };
    }),
  );

  app.get("/api/sms-deliveries", async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return tenant(req, "workflow.manage", async (db) =>
      (await db.query(`select id, topic, recipient, status, error, provider_ref as "providerRef", created_at as "createdAt" from sms_deliveries order by created_at desc, id limit $1`, [q.limit])).rows,
    );
  });

  /** Kişinin kendi bildirim telefonu (yalnız kendisi okur/yazar; bu şirketteki üyeliğine yazılır). */
  app.get("/api/me/notify-phone", async (req) =>
    tenant(req, null, async (db, actor) => ({
      phone: ((await db.query(`select notify_phone from memberships where user_id = $1 and company_id = app_company_id()`, [actor.userId])).rows[0]?.notify_phone as string | null) ?? null,
    })),
  );

  app.put("/api/me/notify-phone", async (req) => {
    const input = parse(z.object({ phone: z.string().trim().max(20).nullable() }), req.body);
    return tenant(req, null, async (db, actor) => {
      const phone = input.phone ? normalizeTrMobile(input.phone) : null;
      if (input.phone && !phone) throw badRequest("Türkiye cep telefonu girin (5xx xxx xx xx)");
      const r = await db.query(`update memberships set notify_phone = $2 where user_id = $1 and company_id = app_company_id() returning id`, [actor.userId, phone]);
      if (!r.rowCount) throw badRequest("Bu şirkette üyelik bulunamadı");
      await recordEvent(db, actor, { entityType: "membership", entityId: r.rows[0].id, eventType: "notify_phone.updated", after: { hasPhone: Boolean(phone) } });
      return { phone };
    });
  });

  app.get("/api/email-deliveries", async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return tenant(req, "workflow.manage", async (db) =>
      (await db.query(`select id, topic, recipient, subject, status, error, message_id as "messageId", created_at as "createdAt" from email_deliveries order by created_at desc, id limit $1`, [q.limit])).rows,
    );
  });
}
