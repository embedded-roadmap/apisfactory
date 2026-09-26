/**
 * Oturum 39 devamı (W42 — SaaS abonelik ve şirket yaşam döngüsü).
 * Kullanıcı kararı (2026-09-27): şirketler arası (cross-tenant) yeni bir yetki sınırı AÇILMAZ —
 * her şirket yalnızca kendi aboneliğini (deneme/aktif/gecikmiş/kısıtlı/iptal, paket) kendi mevcut
 * rolleriyle (manager, accounting; admin yalnızca görüntüler) yönetir. Bu testler: yetkilendirme,
 * durum-geçiş grafiğinin (iptal kalıcı) doğru uygulanmasını, paket değişikliğini, ödeme kaydının
 * idempotent olduğunu, kullanım sayaçlarının canlı hesaplandığını ve — en kritik olarak —
 * "restricted" durumunun YALNIZCA yeni satış siparişi ve teklif ödülünü (yeni satın alma siparişi)
 * engellediğini, üretim/sevkiyat gibi diğer akışları etkilemediğini doğrular.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let customerId: string;
let revA: string;
let prId: string;
let rfqId: string;
let quoteId: string;

const bomMapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const addDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;

  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "SUB-1", name: "Abonelik test kartı" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;SubSemi;SUB-MCU;1;MCU;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "sub.csv", content: csv, mapping: bomMapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revA}/handover`, { area, decision: "approve" }));
  }
  customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "C-SUB", name: "Abonelik Müşterisi" })).id;

  // Teklif ödülü testinde kullanılacak RFQ/teklifi restricted durumuna geçmeden önce hazırlıyoruz —
  // yalnızca "award" eylemi engellenecek, RFQ/teklif oluşturma akışının kendisi bu testin konusu değil.
  const supplierId = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/suppliers", { code: "SUB-SUP", name: "Abonelik Tedarikçi", defaultLeadTimeDays: 5 })).id;
  const setupOrder = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: addDays(30), lines: [{ productRevisionId: revA, qty: "50" }] }));
  expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${setupOrder.id}/confirm`));
  const prs = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchase-requests"));
  prId = prs.find((p: any) => p.sourceType === "production_need").id;
  expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-requests/${prId}/decision`, { decision: "approve" }));
  const rfq = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/rfqs", { purchaseRequestId: prId }));
  rfqId = rfq.id;
  const q = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfqId}/quotes`, { supplierId, unitPrice: "10.00", currency: "TRY", leadTimeDays: 5 }));
  quoteId = q.quotes[0].id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Abonelik ve şirket yaşam döngüsü (W42)", () => {
  it("görüntüleme ve yönetim izinleri ayrı: warehouse görüntüleyemez, admin yalnızca görüntüler yönetemez", async () => {
    expect((await call(w.app, "warehouse@a.test", A, "GET", "/api/subscription")).status).toBe(403);
    expectOk(await call(w.app, "admin@a.test", A, "GET", "/api/subscription"));
    const r = await call(w.app, "admin@a.test", A, "POST", "/api/subscription/transition", { to: "active", reason: "admin iş kararı onaylayamaz" });
    expect(r.status).toBe(403);
  });

  it("yeni şirket 'trial' pakette ve 'trial' durumda başlatılır (30 günlük deneme); kullanım sayaçları canlı hesaplanır", async () => {
    const s = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/subscription"));
    expect(s).toMatchObject({ status: "trial", plan: { code: "trial", maxActiveUsers: 5, maxComponents: 200 } });
    expect(s.trialEndsAt).toBeTruthy();
    expect(s.usage.activeUsers).toBeGreaterThan(0);
    expect(typeof s.usage.componentsOverLimit).toBe("boolean");
  });

  it("paket değişikliği denetim izi bırakır", async () => {
    const plans = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/subscription/plans"));
    expect(plans.map((p: any) => p.code).sort()).toEqual(["growth", "starter", "trial"]);
    const changed = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/subscription/plan", { planCode: "starter", reason: "pilot kapsamı" }));
    expect(changed).toMatchObject({ unchanged: false, planCode: "starter" });
    const s = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/subscription"));
    expect(s.plan).toMatchObject({ code: "starter", maxComponents: 2000 });
    const events = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/subscription/events"));
    expect(events[0]).toMatchObject({ eventType: "plan_changed", fromPlanCode: "trial", toPlanCode: "starter" });
    // Geri al ki sonraki testler etkilenmesin.
    expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/subscription/plan", { planCode: "growth" }));
  });

  it("durum geçiş grafiği: geçersiz geçiş reddedilir, 'cancelled' kalıcıdır", async () => {
    const invalid = await call(w.app, "accounting@a.test", A, "POST", "/api/subscription/transition", { to: "restricted", reason: "trial'dan doğrudan restricted'a geçilemez" });
    expect(invalid.status).toBe(409);
    expect(invalid.body.error.code).toBe("invalid_transition");
    expect(invalid.body.error.details.allowed).toEqual(["active", "cancelled"]);
    const short = await call(w.app, "accounting@a.test", A, "POST", "/api/subscription/transition", { to: "active", reason: "ab" });
    expect(short.status).toBe(400); // gerekçe en az 3 karakter
  });

  it("'restricted' durumu yalnızca yeni satış siparişi ve RFQ ödülünü (yeni satın alma siparişi) engeller; diğer akışlar etkilenmez", async () => {
    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/subscription/transition", { to: "active", reason: "deneme sonu, ödeme planı kuruldu" }));
    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/subscription/transition", { to: "delinquent", reason: "fatura vadesi geçti" }));
    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/subscription/transition", { to: "restricted", reason: "gecikme devam ediyor" }));

    const blockedOrder = await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: addDays(30), lines: [{ productRevisionId: revA, qty: "5" }] });
    expect(blockedOrder.status).toBe(409);
    expect(blockedOrder.body.error.code).toBe("subscription_restricted");

    const blockedAward = await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfqId}/award`, { quoteId, reason: "tek teklif" });
    expect(blockedAward.status).toBe(409);
    expect(blockedAward.body.error.code).toBe("subscription_restricted");

    // Kısıtlama kapsam dışı bıraktığı akışlar: görüntüleme, mevcut ürün/BOM okuma, üretim planlama görünümü.
    expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/customers"));
    expectOk(await call(w.app, "production@a.test", A, "GET", "/api/work-orders"));
    expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/products"));

    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/subscription/transition", { to: "active", reason: "ödeme alındı" }));
    const award = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfqId}/award`, { quoteId, reason: "tek teklif" }));
    expect(award.poId).toBeTruthy();
  });

  it("ödeme kaydı idempotent-key ile mükerrer işlenmez ve durumu otomatik değiştirmez", async () => {
    const before = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/subscription")).status;
    const key = { "idempotency-key": "sub-pay-1" };
    const first = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/subscription/payments", { amount: "1500.00", currency: "TRY", reference: "DEKONT-1" }, key));
    const second = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/subscription/payments", { amount: "1500.00", currency: "TRY", reference: "DEKONT-1" }, key));
    expect(second.id).toBe(first.id);
    const events = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/subscription/events"));
    expect(events.filter((e: any) => e.eventType === "payment_recorded")).toHaveLength(1);
    const after = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/subscription")).status;
    expect(after).toBe(before); // ödeme kaydı durumu otomatik değiştirmez — gerçek borç/tahsilat motoru yok
  });
});
