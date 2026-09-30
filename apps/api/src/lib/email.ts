import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config";
import { withTenant, type Db } from "../db/pool";
import { decryptSecret } from "./secrets";

/**
 * Bildirim e-postası (dış bağımlılık 4). Şirket başına SMTP (email_channels). Kuyruk (outbox) işleyicisi çağırır.
 * Gizlilik: e-postaya mesaj/kayıt İÇERİĞİ konmaz — yalnız başlık/etiket ve uygulama bağlantısı; içeriği görmek oturum ister.
 */

export const EMAIL_TOPICS = ["mention", "meeting_invite", "meeting_minutes", "meeting_cancelled", "escalation", "customer_reminder"] as const;
export type EmailTopic = (typeof EMAIL_TOPICS)[number];

export type Channel = {
  mode: "off" | "test" | "live"; host: string | null; port: number | null; secure: boolean; username: string | null;
  credentials_enc: string | null; from_address: string | null; from_name: string | null; reply_to: string | null; topics: string[];
};

/** Testlerde gerçek SMTP yerine yakalanabilir taşıyıcı. */
export const emailDeps: { transport: ((c: Channel) => Transporter) | null } = { transport: null };

export function transportFor(c: Channel) {
  if (emailDeps.transport) return emailDeps.transport(c);
  const pass = c.credentials_enc ? decryptSecret<{ password: string }>(c.credentials_enc).password : undefined;
  return nodemailer.createTransport({
    host: c.host!, port: c.port!, secure: c.secure,
    auth: c.username ? { user: c.username, pass } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
}

export async function channelOf(db: Db): Promise<Channel | null> {
  return ((await db.query(`select * from email_channels`)).rows[0] as Channel | undefined) ?? null;
}

type Mail = { topic: EmailTopic; to: string[]; subject: string; text: string };

/** Konu → alıcı(lar) ve içerik. Alıcı bulunamazsa boş liste (kayıt 'skipped'). */
export async function compose(db: Db, jobTopic: string, p: Record<string, any>): Promise<Mail | null> {
  const app = config.corsOrigin;
  // Yalnız bu şirketin etkin üyesi olan kullanıcıya gönderilir (askıya alınmış/ayrılmış üyeye bildirim gitmez).
  const userEmail = async (id: string) =>
    ((await db.query(`select u.email from memberships m join users u on u.id = m.user_id where m.user_id = $1 and m.status = 'active'`, [id])).rows[0]?.email as string | undefined) ?? null;
  const meeting = async (id: string) => (await db.query(`select code, title, starts_at from meetings where id = $1`, [id])).rows[0] as { code: string; title: string; starts_at: Date } | undefined;
  switch (jobTopic) {
    case "notification.mention": {
      const to = await userEmail(p.userId);
      return { topic: "mention", to: to ? [to] : [], subject: `Sizden bahsedildi: ${p.label ?? p.entityType}`, text: `Bir mesajda sizden bahsedildi (${p.label ?? p.entityType}).\n\nGörmek için: ${app}/`.trim() };
    }
    case "notification.meeting_invite": {
      const to = await userEmail(p.userId);
      const m = await meeting(p.meetingId);
      if (!m) return null;
      return { topic: "meeting_invite", to: to ? [to] : [], subject: `Toplantı daveti: ${m.code} ${m.title}`, text: `${m.code} ${m.title}\nBaşlangıç: ${new Date(m.starts_at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}\n\n${app}/planning/meetings/${p.meetingId}` };
    }
    case "notification.meeting_minutes":
    case "notification.meeting_cancelled": {
      const to = await userEmail(p.userId);
      const m = await meeting(p.meetingId);
      const cancelled = jobTopic.endsWith("cancelled");
      return { topic: cancelled ? "meeting_cancelled" : "meeting_minutes", to: to ? [to] : [], subject: `${cancelled ? "Toplantı iptal edildi" : "Toplantı tutanağı"}: ${m?.code ?? ""} ${m?.title ?? ""}`.trim(), text: `${app}/planning/meetings/${p.meetingId}` };
    }
    case "notification.escalation": {
      const rows = (await db.query(
        `select distinct u.email from memberships m join users u on u.id = m.user_id join membership_roles mr on mr.membership_id = m.id join roles r on r.id = mr.role_id
          where m.status = 'active' and r.code = $1 and u.email is not null`,
        [p.toRole],
      )).rows;
      return { topic: "escalation", to: rows.map((r) => r.email), subject: `Süresi geçen iş yükseltildi: ${p.title}`, text: `${p.title}\n\n${app}/`.trim() };
    }
    case "customer.reminder":
      // Müşteriye giden metin şirketin kendi hatırlatma şablonundan (collections) üretilmiştir.
      return { topic: "customer_reminder", to: p.email ? [p.email] : [], subject: `Ödeme hatırlatması — ${p.invoiceCode}`, text: String(p.message ?? "") };
    default:
      return null;
  }
}

/** Kuyruk işi için e-posta: kanal/konu/alıcıya göre gönder, test kaydı veya atla; her alıcı için teslim kaydı. */
export async function deliver(db: Db, jobTopic: string, payload: Record<string, any>, alreadySent?: Set<string>, outboxId?: string) {
  const mail = await compose(db, jobTopic, payload);
  if (!mail) return { handled: false as const };
  const ch = await channelOf(db);
  const log = (recipient: string, status: string, error: string | null = null, messageId: string | null = null) =>
    db.query(`insert into email_deliveries (company_id, outbox_id, topic, recipient, subject, status, error, message_id) values (app_company_id(), $7, $1, $2, $3, $4, $5, $6)`,
      [mail.topic, recipient, mail.subject, status, error, messageId, outboxId ?? null]);
  if (!ch || ch.mode === "off" || !ch.topics.includes(mail.topic)) return { handled: true as const, status: "off" };
  if (!mail.to.length) {
    await log("-", "skipped", "alıcı e-posta adresi yok");
    return { handled: true as const, status: "skipped" };
  }
  if (ch.mode === "test") {
    for (const to of mail.to) await log(to, "test");
    return { handled: true as const, status: "test" };
  }
  const t = transportFor(ch);
  const pending = alreadySent ? mail.to.filter((to) => !alreadySent.has(to)) : mail.to;
  let transient: Error | null = null;
  for (const to of pending) {
    try {
      const info = await t.sendMail({ from: ch.from_name ? { name: ch.from_name, address: ch.from_address! } : ch.from_address!, replyTo: ch.reply_to ?? undefined, to, subject: mail.subject, text: mail.text });
      await log(to, "sent", null, info.messageId ?? null);
      alreadySent?.add(to);
    } catch (e) {
      // Kalıcı ret (SMTP 5xx: adres yok, reddedildi) tekrar denenmez; geçici hata (bağlantı, 4xx) sonunda fırlatılır ve
      // işleyici geri çekilmeyle yeniden dener — o denemede daha önce gönderilmiş alıcılar atlanır.
      const code = (e as { responseCode?: number }).responseCode;
      await log(to, "failed", (e as Error).message.slice(0, 300));
      if (!(code && code >= 500 && code < 600)) transient = e as Error;
    }
  }
  // Fırlatmak yerine döndürülür: fırlatma işlemi geri alır ve 'sent' kayıtları da kaybolurdu (yeniden denemede çift gönderim).
  if (transient) return { handled: true as const, status: "retry", error: transient.message };
  return { handled: true as const, status: "live" };
}

const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";
export const EMAIL_JOB_TOPICS = new Set(["notification.mention", "notification.meeting_invite", "notification.meeting_minutes", "notification.meeting_cancelled", "notification.escalation", "customer.reminder"]);

/**
 * Kuyruk işleyicisinden çağrılır. Alıcı çözümü ve kanal okuması şirket bağlamında (RLS); SMTP çağrısı veri tabanı işleminin
 * içinde yapılır ama teslim kaydı her alıcı için ayrı işlemde yazılır — geçici hatada gönderilmiş alıcılar kaybolmaz.
 */
export async function processEmailJob(companyId: string, jobId: string, topic: string, payload: Record<string, any>) {
  const sent = await withTenant({ companyId, userId: SYSTEM_USER }, async (db) =>
    new Set((await db.query(`select recipient from email_deliveries where outbox_id = $1 and status = 'sent'`, [jobId])).rows.map((r) => r.recipient as string)));
  const res = await withTenant({ companyId, userId: SYSTEM_USER }, (db) => deliver(db, topic, payload, sent, jobId));
  if (res.handled && res.status === "retry") throw new Error(res.error);
  return res;
}
