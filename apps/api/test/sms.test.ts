/**
 * Oturum 41 devamı — SMS bildirimi (Netgsm / Verimor; DOĞRULANMADI — gerçek hesap yok).
 * Sağlayıcı istek/yanıt biçimleri sahte fetch ile (Netgsm resmi SDK'sı, Verimor resmi kılavuzu); kanal ayarı, kişinin kendi
 * telefonu, alıcı çözümü ve teslim kaydı gerçek veri tabanıyla sınanır.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { normalizeTrMobile, processSmsJob, SMS_PROVIDERS, smsDeps, SmsError } from "../src/lib/sms";

let w: World;
let A: string;
const M = "manager@a.test";
type Req = { url: string; headers: Headers; body: string };
let log: Req[] = [];
let respond: (r: Req) => { status?: number; body: string };
const realFetch = smsDeps.fetch;
const ids: Record<string, string> = {};

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  for (const r of (await w.owner.query(`select id, email from users`)).rows) ids[r.email] = r.id;
  smsDeps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r: Req = { url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    log.push(r);
    const out = respond(r);
    return new Response(out.body, { status: out.status ?? 200 });
  }) as typeof fetch;
});
beforeEach(() => {
  log = [];
  respond = () => ({ body: JSON.stringify({ code: "00", jobid: "17377215342605050417149344", description: "queued" }) });
});
afterAll(async () => {
  smsDeps.fetch = realFetch;
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Sağlayıcı sözleşmeleri", () => {
  it("telefon normalleştirme", () => {
    for (const v of ["0555 000 00 00", "+90 555 000 0000", "5550000000", "905550000000"]) expect(normalizeTrMobile(v)).toBe("905550000000");
    for (const v of ["0212 000 00 00", "12345", "", null]) expect(normalizeTrMobile(v)).toBeNull();
  });

  it("Netgsm: REST v2, Basic auth, msgheader/messages; kod 00 → jobid; kalıcı ve geçici hata kodları", async () => {
    const ng = SMS_PROVIDERS.netgsm!;
    expect(await ng.send("905550000000", "Merhaba", "FIRMA", { username: "8503000000", password: "ng-SECRET" }, "r1")).toBe("17377215342605050417149344");
    expect(log[0]!.url).toBe("https://api.netgsm.com.tr/sms/rest/v2/send");
    expect(log[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from("8503000000:ng-SECRET").toString("base64")}`);
    expect(JSON.parse(log[0]!.body)).toEqual({ msgheader: "FIRMA", encoding: "TR", messages: [{ msg: "Merhaba", no: "5550000000" }] });
    respond = () => ({ status: 406, body: JSON.stringify({ code: "40", description: "header" }) });
    const e1 = await ng.send("905550000000", "x", "YOK", { username: "u", password: "p" }, "r").catch((e) => e);
    expect(e1).toBeInstanceOf(SmsError);
    expect(e1).toMatchObject({ permanent: true, message: "Netgsm 40: gönderici başlığı tanımlı değil" });
    respond = () => ({ status: 406, body: JSON.stringify({ code: "80" }) });
    expect(await ng.send("905550000000", "x", "F", { username: "u", password: "p" }, "r").catch((e) => e)).toMatchObject({ permanent: false });
  });

  it("Verimor: send.json gövdesi; 200 kampanya no; 400 düz metin kalıcı, 5xx geçici", async () => {
    const vr = SMS_PROVIDERS.verimor!;
    respond = () => ({ body: "20212" });
    expect(await vr.send("905550000000", "Merhaba", "BASLIK", { username: "908501234567", password: "vr-SECRET" }, "job-9")).toBe("20212");
    expect(log[0]!.url).toBe("https://sms.verimor.com.tr/v2/send.json");
    expect(JSON.parse(log[0]!.body)).toEqual({ username: "908501234567", password: "vr-SECRET", source_addr: "BASLIK", custom_id: "job-9", messages: [{ msg: "Merhaba", dest: "905550000000" }] });
    respond = () => ({ status: 400, body: "INVALID_SOURCE_ADDRESS" });
    expect(await vr.send("905550000000", "x", "B", { username: "u", password: "p" }, "r").catch((e) => e)).toMatchObject({ permanent: true, message: "Verimor: HTTP 400 INVALID_SOURCE_ADDRESS" });
    respond = () => ({ status: 503, body: "" });
    expect(await vr.send("905550000000", "x", "B", { username: "u", password: "p" }, "r").catch((e) => e)).toMatchObject({ permanent: false });
  });
});

describe("Kişinin kendi bildirim telefonu", () => {
  it("herkes yalnız kendi telefonunu girer; biçim doğrulanır; başka şirkete sızmaz", async () => {
    expect(expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/me/notify-phone"))).toEqual({ phone: null });
    expect((await call(w.app, "sales@a.test", A, "PUT", "/api/me/notify-phone", { phone: "0212 000 00 00" })).status).toBe(400);
    expect(expectOk(await call(w.app, "sales@a.test", A, "PUT", "/api/me/notify-phone", { phone: "0555 111 22 33" }))).toEqual({ phone: "905551112233" });
    expectOk(await call(w.app, M, A, "PUT", "/api/me/notify-phone", { phone: "5554445566" }));
    expect(expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/me/notify-phone"))).toEqual({ phone: null });
  });
});

describe("SMS kanalı", () => {
  it("ayar: yetki, canlı mod ön koşulu, erişim bilgisi şifreli ve yanıtta yok", async () => {
    expect(expectOk(await call(w.app, M, A, "GET", "/api/sms-channel"))).toMatchObject({ mode: "off", hasCredentials: false, providers: { netgsm: { verified: false }, verimor: { verified: false } } });
    expect((await call(w.app, "sales@a.test", A, "GET", "/api/sms-channel")).status).toBe(403);
    expect((await call(w.app, M, A, "PUT", "/api/sms-channel", { mode: "live", provider: "netgsm", sender: "FIRMA", topics: ["escalation"] })).status).toBe(400);
    expect((await call(w.app, M, A, "PUT", "/api/sms-channel", { mode: "test", provider: "netgsm", sender: "FIRMA", credentials: { username: "u" }, topics: [] })).status).toBe(400);
    expect((await call(w.app, M, A, "PUT", "/api/sms-channel", { mode: "test", provider: "netgsm", sender: "ÇOK<UZUN>BAŞLIK", topics: [] })).status).toBe(400);
    const s = expectOk(await call(w.app, M, A, "PUT", "/api/sms-channel", { mode: "test", provider: "netgsm", sender: "FIRMA A.S", credentials: { username: "8503000000", password: "ng-SECRET" }, topics: ["escalation", "customer_reminder", "mention"] }));
    expect(s).toMatchObject({ mode: "test", provider: "netgsm", hasCredentials: true });
    expect(JSON.stringify(s)).not.toContain("ng-SECRET");
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    expect((await w.owner.query(`select credentials_enc from sms_channels`)).rows[0].credentials_enc).not.toContain("ng-SECRET");
    expect(JSON.stringify((await w.owner.query(`select after_state from events where entity_type = 'sms_channel'`)).rows)).not.toContain("ng-SECRET");
    await w.owner.query(`select set_config('app.company_id', '', false)`);
  });

  it("test modu gönderilmez, kaydedilir; telefonu olmayan alıcı atlanır", async () => {
    expect(await processSmsJob(A, "7001", "notification.mention", { userId: ids["sales@a.test"], label: "PRD-1" })).toMatchObject({ status: "test" });
    expect(await processSmsJob(A, "7002", "notification.mention", { userId: ids["rd@a.test"], label: "PRD-1" })).toMatchObject({ status: "skipped" });
    expect(log).toHaveLength(0);
    const d = expectOk(await call(w.app, M, A, "GET", "/api/sms-deliveries"));
    expect(d.slice(0, 2).map((x: any) => `${x.status}:${x.recipient}`)).toEqual(["skipped:-", "test:905551112233"]);
  });

  it("canlı: yükseltme rol üyelerinin telefonuna; metin etiket + bağlantı (içerik yok); tekrar denemede çift gönderim yok", async () => {
    expectOk(await call(w.app, M, A, "PUT", "/api/sms-channel", { mode: "live", provider: "netgsm", sender: "FIRMA", topics: ["escalation", "customer_reminder", "mention"] }));
    await processSmsJob(A, "7003", "notification.escalation", { taskId: "t", toRole: "manager", title: "Onay bekliyor" });
    expect(log).toHaveLength(1);
    const body = JSON.parse(log[0]!.body);
    expect(body.messages[0].no).toBe("5554445566");
    expect(body.messages[0].msg).toMatch(/^Süresi geçen iş yükseltildi: Onay bekliyor/);
    await processSmsJob(A, "7003", "notification.escalation", { taskId: "t", toRole: "manager", title: "Onay bekliyor" });
    expect(log).toHaveLength(1);
  });

  it("müşteri hatırlatması varsayılan adres telefonuna; geçici hata yeniden deneme ister, kalıcı hata istemez", async () => {
    const customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "SMS-1", name: "SMS Müşterisi" })).id;
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/customers/${customerId}/addresses`, { label: "Merkez", recipient: "Alıcı", line1: "Cad. 1", city: "Ankara", phone: "0532 000 11 22", isDefault: true }));
    const payload = { invoiceId: "x", invoiceCode: "INV-9", customerId, email: null, message: "INV-9 faturanızın vadesi geçti." };
    await processSmsJob(A, "7004", "customer.reminder", payload);
    expect(JSON.parse(log.at(-1)!.body).messages[0]).toEqual({ msg: "INV-9 faturanızın vadesi geçti.", no: "5320001122" });
    respond = () => ({ status: 406, body: JSON.stringify({ code: "85" }) });
    await expect(processSmsJob(A, "7005", "customer.reminder", payload)).rejects.toThrow(/mükerrer/);
    respond = () => ({ status: 406, body: JSON.stringify({ code: "30" }) });
    await expect(processSmsJob(A, "7006", "customer.reminder", payload)).resolves.toMatchObject({ status: "live" });
    const d = expectOk(await call(w.app, M, A, "GET", "/api/sms-deliveries"));
    expect(d[0]).toMatchObject({ status: "failed", recipient: "905320001122" });
    expect(d[0].error).toContain("Netgsm 30");
  });

  it("deneme SMS'i yalnız kendi telefonuna; başka şirket teslim kayıtlarını görmez", async () => {
    respond = () => ({ body: JSON.stringify({ code: "00", jobid: "999" }) });
    const r = expectOk(await call(w.app, M, A, "POST", "/api/sms-channel/test", { to: "905000000000" }));
    expect(r).toEqual({ ok: true, to: "905554445566", error: null });
    expect(JSON.parse(log.at(-1)!.body).messages[0].no).toBe("5554445566");
    expect(expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/sms-deliveries"))).toEqual([]);
  });
});
