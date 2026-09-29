/**
 * Oturum 41 — dış bağımlılık maddesi 6: iyzico Abonelik ile abonelik ücreti tahsilatı.
 * iyzico HTTP'si `iyzicoDeps.fetch` ile SAHTE yanıtlanır: giden istekler (IYZWSv2 imzası, uç nokta, gövde) ve
 * yanıtların işlenişi (bağlama, tahsilat kaydı, otomatik durum geçişleri) sınanır. Gerçek iyzico sandbox
 * doğrulaması IYZICO_API_KEY / IYZICO_SECRET_KEY tanımlanınca yapılır.
 */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool, type Db } from "../src/db/pool";
import { iyzicoAuthHeaders, iyzicoDeps } from "../src/lib/iyzico";
import { runSubscriptionLifecycle } from "../src/modules/billing";

let w: World;
let A: string;
const M = "manager@a.test";
type Req = { method: string; url: string; headers: Headers; body: string };
let log: Req[] = [];
const routes: ((r: Req) => { status?: number; json?: unknown } | undefined)[] = [];
const realFetch = iyzicoDeps.fetch;
const SANDBOX = "https://sandbox-api.iyzipay.com";
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const customer = { name: "Ayşe", surname: "Yılmaz", email: "ayse@a.test", gsmNumber: "+905551112233", identityNumber: "11111111111", address: "Sanayi Cad. 1", city: "İstanbul", country: "Turkey", zipCode: "34700" };
let priceId: string;
let unpayablePriceId: string;

function route(fn: (r: Req) => { status?: number; json?: unknown } | undefined) {
  routes.unshift(fn);
}
async function owner<T>(companyId: string, fn: (db: Db) => Promise<T>) {
  await w.owner.query("begin");
  await w.owner.query(`select set_config('app.company_id', $1, true)`, [companyId]);
  try {
    const r = await fn(w.owner as unknown as Db);
    await w.owner.query("commit");
    return r;
  } catch (e) {
    await w.owner.query("rollback");
    throw e;
  }
}
const company = (id = A) => owner(id, async (db) => (await db.query(`select subscription_status as s, grace_until::text as g, provider_subscription_ref as ref, subscription_status_reason as reason from companies where id = $1`, [id])).rows[0]);
const subscriptionDetail = (orders: unknown[], status = "ACTIVE") => ({ json: { status: "success", data: { referenceCode: "sub-1", subscriptionStatus: status, orders } } });

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  iyzicoDeps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r: Req = { method: init?.method ?? "GET", url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    log.push(r);
    for (const fn of routes) {
      const out = fn(r);
      if (out) return new Response(JSON.stringify(out.json ?? { status: "success" }), { status: out.status ?? 200 });
    }
    return new Response(JSON.stringify({ status: "failure", errorMessage: "unrouted" }), { status: 400 });
  }) as typeof fetch;
  const plan = (await w.owner.query(`select id from subscription_plans where code = 'starter'`)).rows[0].id;
  priceId = (await w.owner.query(`insert into subscription_prices (plan_id, billing_interval, currency, amount, provider_plan_ref) values ($1, 'monthly', 'USD', 49, 'plan-ref-m-usd') returning id`, [plan])).rows[0].id;
  unpayablePriceId = (await w.owner.query(`insert into subscription_prices (plan_id, billing_interval, currency, amount) values ($1, 'yearly', 'EUR', 490) returning id`, [plan])).rows[0].id;
  await owner(A, (db) => db.query(`update companies set subscription_status = 'trial', trial_ends_at = $2 where id = $1`, [A, day(20)]));
});

beforeEach(() => {
  log = [];
});

afterAll(async () => {
  iyzicoDeps.fetch = realFetch;
  delete process.env.IYZICO_API_KEY;
  delete process.env.IYZICO_SECRET_KEY;
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("iyzico kimlik doğrulama (IYZWSv2)", () => {
  it("imza = hex(HMAC-SHA256(secret, randomKey + path + body)); başlık biçimi belgeyle aynı", () => {
    process.env.IYZICO_API_KEY = "api-k";
    process.env.IYZICO_SECRET_KEY = "sec-k";
    const h = iyzicoAuthHeaders("/v2/subscription/checkoutform/initialize", '{"a":1}', "123456789");
    const sig = createHmac("sha256", "sec-k").update('123456789/v2/subscription/checkoutform/initialize{"a":1}').digest("hex");
    expect(h["x-iyzi-rnd"]).toBe("123456789");
    expect(h.authorization.startsWith("IYZWSv2 ")).toBe(true);
    expect(Buffer.from(h.authorization.slice(8), "base64").toString("utf8")).toBe(`apiKey:api-k&randomKey:123456789&signature:${sig}`);
    delete process.env.IYZICO_API_KEY;
    delete process.env.IYZICO_SECRET_KEY;
  });
});

describe("Ödeme başlatma ve dönüş", () => {
  it("fiyat listesi ve yapılandırma durumu görünür; iyzico planı olmayan fiyat ve yapılandırılmamış sağlayıcı reddedilir", async () => {
    const b = expectOk(await call(w.app, M, A, "GET", "/api/subscription/billing"));
    expect(b).toMatchObject({ configured: false, graceDays: 14 });
    expect(b.prices).toEqual(expect.arrayContaining([expect.objectContaining({ id: priceId, interval: "monthly", currency: "USD", payable: true }), expect.objectContaining({ id: unpayablePriceId, payable: false })]));
    expect((await call(w.app, M, A, "POST", "/api/subscription/checkout", { priceId: unpayablePriceId, customer })).body.error.code).toBe("price_not_payable");
    expect((await call(w.app, M, A, "POST", "/api/subscription/checkout", { priceId, customer })).body.error.code).toBe("billing_not_configured");
    expect((await call(w.app, "sales@a.test", A, "POST", "/api/subscription/checkout", { priceId, customer })).status).toBe(403);
  });

  it("ödeme formu başlatılır: imzalı istek, doğru plan ve müşteri; kart bilgisi istenmez; form sayfası sunulur", async () => {
    Object.assign(process.env, { IYZICO_API_KEY: "api-k", IYZICO_SECRET_KEY: "sec-k", PUBLIC_API_BASE: "https://api.example.test" });
    route((r) => (r.url === `${SANDBOX}/v2/subscription/checkoutform/initialize` ? { json: { status: "success", token: "tok-1", checkoutFormContent: '<script>/*iyzico-form*/</script>' } } : undefined));
    const r = expectOk(await call(w.app, M, A, "POST", "/api/subscription/checkout", { priceId, customer }));
    expect(r).toEqual({ pageUrl: "/api/subscription/checkout-page/tok-1" });
    const req = log[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toMatch(/^IYZWSv2 /);
    const rnd = req.headers.get("x-iyzi-rnd")!;
    const sig = createHmac("sha256", "sec-k").update(rnd + "/v2/subscription/checkoutform/initialize" + req.body).digest("hex");
    expect(Buffer.from(req.headers.get("authorization")!.slice(8), "base64").toString()).toContain(`&signature:${sig}`);
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ pricingPlanReferenceCode: "plan-ref-m-usd", subscriptionInitialStatus: "ACTIVE", callbackUrl: "https://api.example.test/api/subscription/iyzico/callback", customer: { name: "Ayşe", email: "ayse@a.test", gsmNumber: "+905551112233", billingAddress: { city: "İstanbul", contactName: "Ayşe Yılmaz" } } });
    expect(JSON.stringify(body)).not.toMatch(/card/i);
    const page = await w.app.inject({ method: "GET", url: "/api/subscription/checkout-page/tok-1" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="iyzipay-checkout-form"');
    expect(page.body).toContain("/*iyzico-form*/");
    expect((await w.app.inject({ method: "GET", url: "/api/subscription/checkout-page/uydurma" })).statusCode).toBe(404);
  });

  it("iyzico dönüşü: sonuç API'den okunur, abonelik şirkete bağlanır, durum aktif olur, ilk tahsilat faturalanacak listesine düşer", async () => {
    route((r) => (r.url === `${SANDBOX}/v2/subscription/checkoutform/tok-1` ? { json: { status: "success", data: { referenceCode: "sub-1", customerReferenceCode: "cus-1", subscriptionStatus: "ACTIVE" } } } : undefined));
    route((r) => (r.url === `${SANDBOX}/v2/subscription/subscriptions/sub-1` ? subscriptionDetail([{ referenceCode: "ord-1", orderStatus: "SUCCESS", price: 49, currencyCode: "USD", startPeriod: Date.parse("2026-09-28"), endPeriod: Date.parse("2026-10-28") }]) : undefined));
    const res = await w.app.inject({ method: "POST", url: "/api/subscription/iyzico/callback", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "token=tok-1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("http://localhost:5173/subscription?payment=success");
    expect(await company()).toMatchObject({ s: "active", ref: "sub-1" });
    const pays = expectOk(await call(w.app, M, A, "GET", "/api/subscription/provider-payments"));
    expect(pays).toEqual([expect.objectContaining({ orderRef: "ord-1", status: "success", currency: "USD", invoiceStatus: "to_invoice", periodStart: "2026-09-28", periodEnd: "2026-10-28" })]);
    expect(Number(pays[0].amount)).toBe(49);
    expect(expectOk(await call(w.app, M, A, "GET", "/api/subscription"))).toMatchObject({ status: "active", plan: { code: "starter" } });
    expect((await w.app.inject({ method: "GET", url: "/api/subscription/checkout-page/tok-1" })).statusCode).toBe(404); // form tek kullanımlık
    // Aynı dönüş tekrar gelirse tahsilat iki kez kaydedilmez
    await w.app.inject({ method: "POST", url: "/api/subscription/iyzico/callback", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "token=tok-1" });
    expect(expectOk(await call(w.app, M, A, "GET", "/api/subscription/provider-payments"))).toHaveLength(1);
  });

  it("tanınmayan token ile dönüş başarısız sayfaya yönlenir, hiçbir şey değişmez", async () => {
    const res = await w.app.inject({ method: "POST", url: "/api/subscription/iyzico/callback", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "token=baskasi" });
    expect(res.headers.location).toMatch(/payment=failed$/);
    expect(log).toEqual([]);
  });
});

describe("Bildirim, mutabakat ve 14 gün ek süre", () => {
  it("bildirim içeriğine güvenilmez: gerçek durum iyzico'dan okunur; başarısız tahsilat → gecikmiş + 14 gün", async () => {
    route((r) => (r.url === `${SANDBOX}/v2/subscription/subscriptions/sub-1` ? subscriptionDetail([
      { referenceCode: "ord-1", orderStatus: "SUCCESS", price: 49, currencyCode: "USD", startPeriod: Date.parse("2026-09-28"), endPeriod: Date.parse("2026-10-28") },
      { referenceCode: "ord-2", orderStatus: "FAILED", price: 49, currencyCode: "USD", startPeriod: Date.parse("2026-10-28"), endPeriod: Date.parse("2026-11-28") },
    ], "UNPAID") : undefined));
    // Bildirim "başarılı" dese bile karar API'den okunan duruma göre verilir
    const res = await w.app.inject({ method: "POST", url: "/api/subscription/iyzico/webhook", payload: { subscriptionReferenceCode: "sub-1", iyziEventType: "subscription.order.success" } });
    expect(res.json()).toEqual({ received: true });
    expect(await company()).toMatchObject({ s: "delinquent", g: day(14) });
    const pays = expectOk(await call(w.app, M, A, "GET", "/api/subscription/provider-payments"));
    expect(pays.find((p: any) => p.orderRef === "ord-2")).toMatchObject({ status: "failed", invoiceStatus: "not_applicable" });
  });

  it("tanınmayan referans yok sayılır; iyzico erişilemezse 503 (iyzico yeniden dener)", async () => {
    expect((await w.app.inject({ method: "POST", url: "/api/subscription/iyzico/webhook", payload: { subscriptionReferenceCode: "yok" } })).json()).toEqual({ received: true, ignored: true });
    route((r) => (r.url.endsWith("/subscriptions/sub-1") ? { status: 500, json: { status: "failure" } } : undefined));
    expect((await w.app.inject({ method: "POST", url: "/api/subscription/iyzico/webhook", payload: { subscriptionReferenceCode: "sub-1" } })).statusCode).toBe(503);
  });

  it("ek süre dolunca otomatik 'kısıtlı': yeni satış siparişi engellenir", async () => {
    await owner(A, (db) => db.query(`update companies set grace_until = $2 where id = $1`, [A, day(-1)]));
    const r = await owner(A, (db) => runSubscriptionLifecycle(db, A));
    expect(r.transitions).toEqual(["restricted"]);
    expect((await company()).reason).toMatch(/14 günlük ek süre/);
    const cust = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "K-1", name: "Kısıt Müşterisi" })).id;
    // Kısıtlama kontrolü ürün doğrulamasından önce çalışır; biçimce geçerli bir satır yeterli.
    const so = await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId: cust, requestedDate: day(30), lines: [{ productRevisionId: "00000000-0000-0000-0000-000000000001", qty: "1" }] });
    expect(so.body.error.code).toBe("subscription_restricted");
  });

  it("ödeme tekrar başarılı olunca (elle senkron) otomatik aktif, ek süre temizlenir", async () => {
    route((r) => (r.url === `${SANDBOX}/v2/subscription/subscriptions/sub-1` ? subscriptionDetail([
      { referenceCode: "ord-2", orderStatus: "FAILED", startPeriod: Date.parse("2026-10-28") },
      { referenceCode: "ord-3", orderStatus: "SUCCESS", price: 49, currencyCode: "USD", startPeriod: Date.parse("2026-10-29"), endPeriod: Date.parse("2026-11-28") },
    ]) : undefined));
    expect(expectOk(await call(w.app, M, A, "POST", "/api/subscription/sync"))).toMatchObject({ recorded: 1, transition: "active" });
    expect(await company()).toMatchObject({ s: "active", g: null });
  });

  it("deneme süresi ödeme yöntemi eklenmeden biterse otomatik gecikmiş; ek süre deneme bitişinden sayılır", async () => {
    const B = w.b.companyId;
    await owner(B, (db) => db.query(`update companies set subscription_status = 'trial', trial_ends_at = $2, provider_subscription_ref = null where id = $1`, [B, day(-3)]));
    const r = await owner(B, (db) => runSubscriptionLifecycle(db, B));
    expect(r).toEqual({ transitions: ["delinquent"], needsSync: false });
    expect(await company(B)).toMatchObject({ s: "delinquent", g: day(11) });
  });
});

describe("Fatura takibi ve iptal", () => {
  it("muhasebe başarılı tahsilatı fatura numarasıyla bir kez işaretler; başarısız tahsilat faturalanmaz", async () => {
    const pays = expectOk(await call(w.app, M, A, "GET", "/api/subscription/provider-payments"));
    const ok = pays.find((p: any) => p.orderRef === "ord-1");
    const failed = pays.find((p: any) => p.orderRef === "ord-2");
    expect(expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/subscription/provider-payments/${ok.id}/invoice`, { invoiceNo: "GIB2026000000123" }))).toMatchObject({ invoiceStatus: "invoiced" });
    expect((await call(w.app, "accounting@a.test", A, "POST", `/api/subscription/provider-payments/${ok.id}/invoice`, { invoiceNo: "X" })).body.error.code).toBe("not_invoiceable");
    expect((await call(w.app, "accounting@a.test", A, "POST", `/api/subscription/provider-payments/${failed.id}/invoice`, { invoiceNo: "X" })).body.error.code).toBe("not_invoiceable");
    const ev = expectOk(await call(w.app, M, A, "GET", "/api/subscription/events"));
    expect(ev.some((e: any) => e.eventType === "invoice_recorded" && e.reference === "GIB2026000000123")).toBe(true);
  });

  it("RLS: başka şirket bu şirketin tahsilatlarını görmez", async () => {
    expect(expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/subscription/provider-payments"))).toEqual([]);
  });

  it("kalıcı iptal iyzico'daki tekrarlı ödemeyi de durdurur", async () => {
    route((r) => (r.method === "POST" && r.url === `${SANDBOX}/v2/subscription/subscriptions/sub-1/cancel` ? { json: { status: "success" } } : undefined));
    expectOk(await call(w.app, M, A, "POST", "/api/subscription/transition", { to: "cancelled", reason: "Şirket kapanıyor" }));
    expect(log.some((x) => x.url.endsWith("/subscriptions/sub-1/cancel"))).toBe(true);
    expect((await company()).s).toBe("cancelled");
    expect((await call(w.app, M, A, "POST", "/api/subscription/checkout", { priceId, customer })).body.error.code).toBe("subscription_cancelled");
  });
});
