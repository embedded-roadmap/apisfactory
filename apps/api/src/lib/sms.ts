import { withTenant, type Db } from "../db/pool";
import { compose } from "./email";
import { decryptSecret } from "./secrets";

/**
 * Oturum 41 devamı — SMS bildirimi (dış bağımlılık 4). Sağlayıcılar DOĞRULANMADI (gerçek hesapla denenmedi):
 *  - Netgsm: resmi JS SDK'sı (github.com/netgsm/netgsm-sms-js) — POST api.netgsm.com.tr/sms/rest/v2/send, Basic auth,
 *    { msgheader, encoding, messages:[{msg,no}] } → { code:"00", jobid } (hata kodları SDK'daki SendSmsErrorCode).
 *  - Verimor: resmi kullanım kılavuzu (github.com/verimor/SMS-API) — POST sms.verimor.com.tr/v2/send.json,
 *    { username, password, source_addr, custom_id, messages:[{msg,dest}] } → 200 düz metin kampanya no / 400 hata metni.
 * Mesajlar bilgilendirme amaçlıdır; ticari ileti işareti (İYS) gönderilmez.
 */

type Fetch = typeof fetch;
export const smsDeps: { fetch: Fetch; timeoutMs: number } = { fetch: (...a) => fetch(...a), timeoutMs: 15_000 };

/** Kalıcı ret: yeniden denemek sonucu değiştirmez (kimlik, başlık, parametre). Geçici: hız sınırı, sistem hatası, ağ. */
export class SmsError extends Error {
  constructor(message: string, public readonly permanent: boolean) {
    super(message);
  }
}

export type SmsProvider = {
  label: string;
  credentialFields: string[];
  docsUrl: string;
  verified: boolean;
  /** Tek alıcıya gönderir; sağlayıcı referansı döner. */
  send(to: string, text: string, sender: string, creds: Record<string, string>, ref: string): Promise<string>;
};

async function http(url: string, init: RequestInit) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), smsDeps.timeoutMs);
  try {
    return await smsDeps.fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw new SmsError(`bağlantı hatası (${(e as Error).name})`, false);
  } finally {
    clearTimeout(t);
  }
}

const NETGSM_CODES: Record<string, [string, boolean]> = {
  "20": ["mesaj metni hatalı veya çok uzun", true],
  "30": ["kullanıcı adı/şifre geçersiz, API yetkisi yok veya IP izni yok", true],
  "40": ["gönderici başlığı tanımlı değil", true],
  "50": ["İYS kontrollü gönderim bu hesapla yapılamaz", true],
  "51": ["İYS marka bilgisi yok", true],
  "70": ["parametre hatası", true],
  "80": ["gönderim hız sınırı aşıldı", false],
  "85": ["aynı numaraya mükerrer gönderim sınırı", false],
  "100": ["Netgsm sistem hatası", false],
  "101": ["Netgsm sistem hatası", false],
};

export const SMS_PROVIDERS: Record<string, SmsProvider> = {
  netgsm: {
    label: "Netgsm",
    credentialFields: ["username", "password"],
    docsUrl: "https://github.com/netgsm/netgsm-sms-js",
    verified: false,
    async send(to, text, sender, c) {
      const res = await http("https://api.netgsm.com.tr/sms/rest/v2/send", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}` },
        // Netgsm yerel biçim: 5xxxxxxxxx
        body: JSON.stringify({ msgheader: sender, encoding: "TR", messages: [{ msg: text, no: to.slice(2) }] }),
      });
      let j: { code?: string; jobid?: string } = {};
      try {
        j = (await res.json()) as typeof j;
      } catch {
        throw new SmsError(`Netgsm: HTTP ${res.status}`, res.status < 500 && res.status !== 429);
      }
      if ((res.status === 200 || res.status === 406) && j.code === "00" && j.jobid) return String(j.jobid);
      const known = NETGSM_CODES[String(j.code)];
      if (known) throw new SmsError(`Netgsm ${j.code}: ${known[0]}`, known[1]);
      throw new SmsError(`Netgsm: HTTP ${res.status}${j.code ? ` kod ${j.code}` : ""}`, res.status >= 400 && res.status < 500 && res.status !== 429);
    },
  },
  verimor: {
    label: "Verimor",
    credentialFields: ["username", "password"],
    docsUrl: "https://github.com/verimor/SMS-API/blob/master/user_guide.md",
    verified: false,
    async send(to, text, sender, c, ref) {
      const res = await http("https://sms.verimor.com.tr/v2/send.json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: c.username, password: c.password, source_addr: sender, custom_id: ref, messages: [{ msg: text, dest: to }] }),
      });
      const body = (await res.text()).trim();
      if (res.status === 200 && /^\d+$/.test(body)) return body;
      // Kılavuz: başarısızlıkta 400 + düz metin hata. Metin kimlik bilgisi içermez ama yine de kısaltılır.
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw new SmsError(`Verimor: HTTP ${res.status}${body ? ` ${body.slice(0, 160)}` : ""}`, permanent);
    },
  },
};

/** Türkiye cep telefonu → 905xxxxxxxxx; olmuyorsa null (yurt dışı numara desteklenmez). */
export function normalizeTrMobile(v: string | null | undefined) {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("90")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^5\d{9}$/.test(d) ? `90${d}` : null;
}

export type SmsChannel = { mode: "off" | "test" | "live"; provider: string | null; sender: string | null; credentials_enc: string | null; topics: string[] };

export async function smsChannelOf(db: Db): Promise<SmsChannel | null> {
  return ((await db.query(`select * from sms_channels`)).rows[0] as SmsChannel | undefined) ?? null;
}

/** Konu → telefonlar + kısa metin. Metin e-posta konusundan (içerik değil, etiket + bağlantı) türetilir. */
async function composeSms(db: Db, jobTopic: string, p: Record<string, any>) {
  const mail = await compose(db, jobTopic, p);
  if (!mail) return null;
  const phoneOf = async (userId: string) =>
    ((await db.query(`select notify_phone from memberships where user_id = $1 and status = 'active'`, [userId])).rows[0]?.notify_phone as string | null) ?? null;
  let to: string[] = [];
  if (mail.topic === "escalation") {
    to = (await db.query(
      `select distinct m.notify_phone from memberships m join membership_roles mr on mr.membership_id = m.id join roles r on r.id = mr.role_id
        where m.status = 'active' and r.code = $1 and m.notify_phone is not null`,
      [p.toRole],
    )).rows.map((r) => r.notify_phone);
  } else if (mail.topic === "customer_reminder") {
    const a = (await db.query(`select phone from customer_addresses where customer_id = $1 and is_default and active`, [p.customerId])).rows[0];
    const n = normalizeTrMobile(a?.phone);
    to = n ? [n] : [];
  } else {
    const n = await phoneOf(p.userId);
    to = n ? [n] : [];
  }
  // Müşteri hatırlatmasında şirketin kendi şablon metni; iç bildirimde konu + bağlantı.
  const link = mail.text.match(/https?:\/\/\S+/)?.[0];
  const text = mail.topic === "customer_reminder" ? mail.text.slice(0, 600) : `${mail.subject}${link ? ` ${link}` : ""}`.slice(0, 300);
  return { topic: mail.topic, to, text };
}

export async function deliverSms(db: Db, jobTopic: string, payload: Record<string, any>, alreadySent?: Set<string>, outboxId?: string) {
  const ch = await smsChannelOf(db);
  if (!ch || ch.mode === "off") return { handled: true as const, status: "off" };
  const m = await composeSms(db, jobTopic, payload);
  if (!m) return { handled: false as const };
  if (!ch.topics.includes(m.topic)) return { handled: true as const, status: "off" };
  const log = (recipient: string, status: string, error: string | null = null, ref: string | null = null) =>
    db.query(`insert into sms_deliveries (company_id, outbox_id, topic, recipient, status, error, provider_ref) values (app_company_id(), $1, $2, $3, $4, $5, $6)`,
      [outboxId ?? null, m.topic, recipient, status, error, ref]);
  if (!m.to.length) {
    await log("-", "skipped", "alıcının kayıtlı cep telefonu yok");
    return { handled: true as const, status: "skipped" };
  }
  if (ch.mode === "test") {
    for (const to of m.to) await log(to, "test");
    return { handled: true as const, status: "test" };
  }
  const provider = SMS_PROVIDERS[ch.provider ?? ""];
  if (!provider || !ch.credentials_enc || !ch.sender) {
    await log("-", "failed", "SMS sağlayıcısı ayarı eksik");
    return { handled: true as const, status: "failed" };
  }
  const creds = decryptSecret<Record<string, string>>(ch.credentials_enc);
  let transient: string | null = null;
  for (const to of m.to) {
    if (alreadySent?.has(to)) continue;
    try {
      const ref = await provider.send(to, m.text, ch.sender, creds, `${outboxId ?? "x"}-${to.slice(-4)}`);
      await log(to, "sent", null, ref);
    } catch (e) {
      const err = e instanceof SmsError ? e : new SmsError((e as Error).message, false);
      await log(to, "failed", err.message.slice(0, 300));
      if (!err.permanent) transient = err.message;
    }
  }
  // Fırlatılmaz, döndürülür: kayıtlar işlemle birlikte kalıcı olsun (yeniden denemede gönderilmişler atlanır).
  if (transient) return { handled: true as const, status: "retry", error: transient };
  return { handled: true as const, status: "live" };
}

const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

export async function processSmsJob(companyId: string, jobId: string, topic: string, payload: Record<string, any>) {
  const sent = await withTenant({ companyId, userId: SYSTEM_USER }, async (db) =>
    new Set((await db.query(`select recipient from sms_deliveries where outbox_id = $1 and status = 'sent'`, [jobId])).rows.map((r) => r.recipient as string)));
  const res = await withTenant({ companyId, userId: SYSTEM_USER }, (db) => deliverSms(db, topic, payload, sent, jobId));
  if (res.handled && res.status === "retry") throw new Error(res.error);
  return res;
}
