/**
 * Oturum 41 devamı — dış bağımlılık 4: bildirim e-postası (şirket başına SMTP).
 * Süreç içi gerçek bir SMTP sunucusu (smtp-server) açılır; nodemailer gerçek SMTP konuşması yapar (AUTH, MAIL FROM, RCPT, DATA).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "node:net";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { processEmailJob } from "../src/lib/email";

let w: World;
let A: string;
const M = "manager@a.test";
type Got = { from: string; to: string[]; data: string; user?: string };
let inbox: Got[] = [];
let rejectRcpt: { code: number; match: string } | null = null;
let server: SMTPServer;
let port: number;
const ids: Record<string, string> = {};

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  for (const r of (await w.owner.query(`select id, email from users`)).rows) ids[r.email] = r.id;
  server = new SMTPServer({
    secure: false,
    disabledCommands: ["STARTTLS"],
    authOptional: false,
    onAuth(auth, _s, cb) {
      if (auth.username === "bildirim@a.test" && auth.password === "s3cret-pw") cb(null, { user: auth.username });
      else cb(new Error("Geçersiz kimlik"));
    },
    onRcptTo(addr, _s, cb) {
      if (rejectRcpt && addr.address.includes(rejectRcpt.match)) {
        const e = new Error("reddedildi") as Error & { responseCode: number };
        e.responseCode = rejectRcpt.code;
        return cb(e);
      }
      cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        inbox.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), data: Buffer.concat(chunks).toString("utf8"), user: session.user as string | undefined });
        cb();
      });
    },
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  port = (server.server.address() as AddressInfo).port;
});

beforeEach(() => {
  inbox = [];
  rejectRcpt = null;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await w.app.close();
  await w.owner.end();
  await closePool();
});

const settings = (over: Record<string, unknown> = {}) => ({
  mode: "live", host: "127.0.0.1", port, secure: false, username: "bildirim@a.test", password: "s3cret-pw",
  fromAddress: "bildirim@a.test", fromName: "Şirket A", replyTo: null, topics: ["mention", "meeting_invite", "meeting_minutes", "meeting_cancelled", "escalation", "customer_reminder"], ...over,
});
const deliveries = async () => expectOk(await call(w.app, M, A, "GET", "/api/email-deliveries")) as { topic: string; recipient: string; status: string; error: string | null }[];

describe("E-posta kanalı ayarı", () => {
  it("varsayılan kapalıdır; yalnız workflow.manage yetkisi görebilir", async () => {
    const s = expectOk(await call(w.app, M, A, "GET", "/api/email-channel"));
    expect(s).toMatchObject({ mode: "off", hasPassword: false, host: null });
    expect((await call(w.app, "sales@a.test", A, "GET", "/api/email-channel")).status).toBe(403);
    expect((await call(w.app, "admin@a.test", A, "PUT", "/api/email-channel", settings())).status).toBe(403);
  });

  it("canlı mod sunucu/port/gönderen olmadan reddedilir", async () => {
    const r = await call(w.app, M, A, "PUT", "/api/email-channel", settings({ host: null }));
    expect(r.status).toBe(400);
  });

  it("parola şifreli saklanır, yanıtta ve olay kaydında yer almaz; boş bırakılınca korunur", async () => {
    const s = expectOk(await call(w.app, M, A, "PUT", "/api/email-channel", settings({ mode: "test" })));
    expect(s).toMatchObject({ mode: "test", hasPassword: true, host: "127.0.0.1" });
    expect(JSON.stringify(s)).not.toContain("s3cret-pw");
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    const row = (await w.owner.query(`select credentials_enc from email_channels`)).rows[0];
    expect(row.credentials_enc).toBeTruthy();
    expect(row.credentials_enc).not.toContain("s3cret-pw");
    const ev = (await w.owner.query(`select before_state as before, after_state as after from events where entity_type = 'email_channel' order by id`)).rows;
    expect(JSON.stringify(ev)).not.toContain("s3cret-pw");
    expect(ev.at(-1).after.passwordChanged).toBe(true);
    const { password: _p, ...noPw } = settings({ mode: "test" });
    const s2 = expectOk(await call(w.app, M, A, "PUT", "/api/email-channel", noPw));
    expect(s2.hasPassword).toBe(true);
    await w.owner.query(`select set_config('app.company_id', '', false)`);
  });

  it("deneme gönderimi gerçek SMTP ile yalnız isteyenin kendi adresine gider", async () => {
    const r = expectOk(await call(w.app, M, A, "POST", "/api/email-channel/test", { to: "baska@disari.test" }));
    expect(r).toEqual({ ok: true, to: M, error: null });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ from: "bildirim@a.test", to: [M], user: "bildirim@a.test" });
    expect((await deliveries())[0]).toMatchObject({ topic: "test_send", recipient: M, status: "sent" });
  });

  it("yanlış parola ile deneme gönderimi başarısız olarak kaydedilir", async () => {
    expectOk(await call(w.app, M, A, "PUT", "/api/email-channel", settings({ mode: "test", password: "yanlis" })));
    const r = expectOk(await call(w.app, M, A, "POST", "/api/email-channel/test"));
    expect(r.ok).toBe(false);
    expect(inbox).toHaveLength(0);
    expectOk(await call(w.app, M, A, "PUT", "/api/email-channel", settings({ mode: "test" })));
  });
});

describe("Kuyruk işi → e-posta", () => {
  it("test modunda gönderilmez, yalnız kaydedilir", async () => {
    const res = await processEmailJob(A, "9001", "notification.mention", { userId: ids["sales@a.test"], entityType: "product", label: "PRD-1" });
    expect(res).toMatchObject({ handled: true, status: "test" });
    expect(inbox).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({ topic: "mention", recipient: "sales@a.test", status: "test" });
  });

  it("canlı modda gönderir; içerik yerine etiket + bağlantı taşır; aynı iş yeniden denenirse çift gönderim olmaz", async () => {
    expectOk(await call(w.app, M, A, "PUT", "/api/email-channel", settings()));
    await processEmailJob(A, "9002", "notification.mention", { userId: ids["sales@a.test"], entityType: "product", label: "PRD-1" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.to).toEqual(["sales@a.test"]);
    expect(inbox[0]!.data).toContain("PRD-1");
    await processEmailJob(A, "9002", "notification.mention", { userId: ids["sales@a.test"], entityType: "product", label: "PRD-1" });
    expect(inbox).toHaveLength(1);
  });

  it("yükseltme: hedef roldeki etkin üyelere gider", async () => {
    await processEmailJob(A, "9003", "notification.escalation", { taskId: "x", toRole: "manager", title: "Onay bekliyor" });
    expect(inbox.flatMap((m) => m.to)).toEqual([M]);
  });

  it("kapatılan konu gönderilmez ve kaydedilmez", async () => {
    expectOk(await call(w.app, M, A, "PUT", "/api/email-channel", settings({ topics: ["escalation"] })));
    const before = (await deliveries()).length;
    const res = await processEmailJob(A, "9004", "notification.mention", { userId: ids["sales@a.test"], label: "PRD-2" });
    expect(res).toMatchObject({ status: "off" });
    expect(inbox).toHaveLength(0);
    expect((await deliveries()).length).toBe(before);
    expectOk(await call(w.app, M, A, "PUT", "/api/email-channel", settings()));
  });

  it("başka şirketin kullanıcısına gönderilmez (alıcı yalnız etkin üye)", async () => {
    const res = await processEmailJob(A, "9005", "notification.mention", { userId: ids["all@b.test"], label: "PRD-3" });
    expect(res).toMatchObject({ status: "skipped" });
    expect(inbox).toHaveLength(0);
  });

  it("kalıcı ret (5xx) yeniden denenmez; geçici hata (4xx) iş için yeniden deneme ister ama 'failed' kaydı kalır", async () => {
    rejectRcpt = { code: 550, match: "customer" };
    await expect(processEmailJob(A, "9006", "customer.reminder", { invoiceCode: "INV-1", email: "customer@x.test", message: "Hatırlatma" })).resolves.toMatchObject({ status: "live" });
    rejectRcpt = { code: 451, match: "customer" };
    await expect(processEmailJob(A, "9007", "customer.reminder", { invoiceCode: "INV-2", email: "customer@x.test", message: "Hatırlatma" })).rejects.toThrow();
    const d = await deliveries();
    expect(d.filter((x) => x.recipient === "customer@x.test" && x.status === "failed")).toHaveLength(2);
    rejectRcpt = null;
    await processEmailJob(A, "9007", "customer.reminder", { invoiceCode: "INV-2", email: "customer@x.test", message: "Hatırlatma" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.data).toContain("INV-2");
  });

  it("teslim kayıtları şirket içidir (B, A'nın kayıtlarını görmez)", async () => {
    const b = expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/email-deliveries"));
    expect(b).toEqual([]);
  });
});
