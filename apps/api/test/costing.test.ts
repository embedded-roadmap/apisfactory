/**
 * Oturum 6 (W25): lot maliyeti, sürümlü politika, deterministik ve sürümlü iş emri maliyeti, geç gelen fatura,
 * sıfır sağlam adet, satış kârlılığı, metrik sözlüğü ve kaynak kayıtlar (prompt §18).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, PASSWORD, setupWorld, type World } from "./helpers";
import { createUser } from "../src/db/seed";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let rev: string;
let productId: string;
let customerId: string;
let wo1: any;
let wo2: any;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
const ALL = { box: true, accessories: true, label: true, inspection: true };
const M = "manager@a.test";
const P = "purchasing@a.test";
const W = "warehouse@a.test";
const T = "technician@a.test";
const today = new Date().toISOString().slice(0, 10);
const plus = (n: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lotId = async (lotNo: string) => expectOk(await call(w.app, W, A, "GET", `/api/lots/lookup?code=${lotNo}`))[0].id as string;

async function produce(qty: string, pass: number) {
  const wo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: rev, qty }));
  const rel = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo.id}/release`));
  expectOk(await call(w.app, W, A, "POST", `/api/work-orders/${wo.id}/issue`, { lotId: await lotId("MCU-C1"), qty }));
  expectOk(await call(w.app, W, A, "POST", `/api/work-orders/${wo.id}/issue`, { lotId: await lotId("CAP-C1"), qty: String(Number(qty) * 2) }));
  for (const op of rel.operations) {
    expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/start`));
    if (op.isQualityGate) {
      for (const [i, d] of rel.devices.entries()) {
        expectOk(await call(w.app, T, A, "POST", `/api/devices/${d.serial}/test`, { result: i < pass ? "pass" : "fail" }));
        if (i >= pass) expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/devices/${d.serial}/disposition`, { decision: "scrap", note: "Kısa devre" }));
      }
      expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`));
      if (pass > 0) expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/work-orders/${wo.id}/release-to-stock`));
    } else expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`));
  }
  return expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo.id}/complete`));
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "MK-1", name: "Maliyet kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "mk.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;MCU-C;1;MCU;\nC1,C2;TestPassive;CAP-C;2;Kondansatör;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "rd", decision: "approve" }));
  expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "production", decision: "approve" }));
  expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "quality", decision: "approve" }));
  customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "MC", name: "Kârlılık Müşterisi" })).id;
  expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/customers/${customerId}/addresses`, { label: "Merkez", recipient: "Teslim Alan", line1: "Cad. 1", city: "Ankara" }));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Lot maliyeti", () => {
  it("maliyet sütunu yalnızca maliyet yetkisiyle içe aktarılır; depo fiyat giremez", async () => {
    const csv = "kod,miktar,lot,konum,rev,maliyet\nCMP-TESTSEMI-MCU-C,10,MCU-C1,STK,,12.5\nCMP-TESTPASSIVE-CAP-C,100,CAP-C1,STK,,0.1";
    const p = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", { fileName: "c.csv", content: csv, mapping: { ...stockMapping, unitCost: "maliyet" } }));
    expect(p.summary.errors).toBe(2);
    expect(p.rows[0].messages.join(" ")).toContain("maliyet kayıt yetkisi");
    const plain = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", { fileName: "c2.csv", content: csv, mapping: stockMapping }));
    expectOk(await call(w.app, W, A, "POST", `/api/imports/${plain.jobId}/commit`, {}));
    const items = expectOk(await call(w.app, W, A, "GET", "/api/lots/lookup?code=MCU-C1"));
    const rec = await call(w.app, W, A, "POST", "/api/receipts", { supplierName: "X", lines: [{ itemId: items[0].itemId, qty: "1", lotNo: "MCU-C9", unitCost: "1" }] });
    expect(rec.status).toBe(403);
    expect((await call(w.app, W, A, "GET", `/api/lots/${items[0].id}/costs`)).status).toBe(403);
  });
});

describe("İş emri maliyeti", () => {
  it("üretim: 4 adetten 3 sağlam; 1 adetlik ikinci iş hurda", async () => {
    wo1 = await produce("4", 3);
    wo2 = await produce("1", 0);
    expect(wo1.status).toBe("completed");
    // Operasyon süreleri (testte anlık geçtiği için): her operasyon 30 dk
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await w.owner.query(`update work_order_operations set worked_seconds = 1800 where work_order_id = any($1)`, [[wo1.id, wo2.id]]);
  });

  it("politika ve lot maliyeti yokken hesap eksik işaretlenir ve bitmiş lota yazılmaz", async () => {
    expect((await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo1.id}/costs`)).status).toBe(403);
    const c = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo1.id}/costs`));
    expect(c.versionNo).toBe(1);
    expect(c.complete).toBe(false);
    expect(c.gaps.join(" ")).toContain("politikası yok");
    expect(c.gaps.join(" ")).toContain("lot maliyeti yok");
    const fg = expectOk(await call(w.app, W, A, "GET", `/api/lots/lookup?code=${wo1.code}`))[0].id;
    expect(expectOk(await call(w.app, M, A, "GET", `/api/lots/${fg}/costs`))).toHaveLength(0);
  });

  it("politika sürümlüdür; fatura maliyeti yeni kayıt olarak girilir", async () => {
    expect((await call(w.app, "sales@a.test", A, "POST", "/api/cost-policies", { validFrom: "2026-01-01", currency: "TRY", laborRatePerHour: "600", note: "x".repeat(5) })).status).toBe(403);
    const p = expectOk(await call(w.app, M, A, "POST", "/api/cost-policies", { validFrom: "2026-01-01", currency: "TRY", laborRatePerHour: "600", overheadPerLaborHour: "100", overheadPctOfMaterial: "10", note: "2026 politikası" }));
    expect(p.versionNo).toBe(1);
    // Gelecek tarihli sürüm bugünkü hesabı etkilemez
    expectOk(await call(w.app, M, A, "POST", "/api/cost-policies", { validFrom: plus(400), currency: "TRY", laborRatePerHour: "900", note: "Gelecek yıl" }));
    expectOk(await call(w.app, P, A, "POST", `/api/lots/${await lotId("MCU-C1")}/cost`, { unitCost: "12.5", currency: "TRY", source: "invoice", reference: "FTR-001" }));
    expectOk(await call(w.app, P, A, "POST", `/api/lots/${await lotId("CAP-C1")}/cost`, { unitCost: "0.1", currency: "TRY", source: "invoice", reference: "FTR-002" }));
  });

  it("maliyet: malzeme + işçilik + genel gider; birim maliyet sağlam adede; aynı girdiyle yeni sürüm açılmaz", async () => {
    const c = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo1.id}/costs`));
    expect(c.versionNo).toBe(2);
    expect(c.complete).toBe(true);
    expect(c.policy.versionNo).toBe(1);
    // malzeme 4×12.5 + 8×0.1 = 50.8; işçilik 3 saat × 600 = 1800; genel gider 3×100 + 50.8×%10 = 305.08
    expect(c.totals).toEqual({ material: "50.8", labor: "1800", overhead: "305.08", external: "0", total: "2155.88" });
    expect(c.devices).toMatchObject({ started: 4, good: 3, scrapped: 1 });
    expect(c.unitCost).toBe("718.626667");
    expect(c.materials.find((m: any) => m.itemCode === "CMP-TESTSEMI-MCU-C")).toMatchObject({ unitCost: "12.5", costSource: "invoice", costReference: "FTR-001" });
    const again = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo1.id}/costs`));
    expect(again).toMatchObject({ unchanged: true, versionNo: 2 });
  });

  it("geç gelen fatura yeni sürüm açar; eski sürüm değişmez; bitmiş lot maliyeti güncellenir", async () => {
    expectOk(await call(w.app, P, A, "POST", `/api/lots/${await lotId("MCU-C1")}/cost`, { unitCost: "13", currency: "TRY", source: "invoice", reference: "FTR-001-FARK" }));
    const c = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo1.id}/costs`));
    expect(c.versionNo).toBe(3);
    expect(c.totals.total).toBe("2158.08");
    expect(c.unitCost).toBe("719.36");
    const versions = expectOk(await call(w.app, M, A, "GET", `/api/work-orders/${wo1.id}/costs`));
    expect(versions.map((v: any) => [v.versionNo, v.result.totals.total])).toEqual([[3, "2158.08"], [2, "2155.88"], [1, "0"]]);
    await expect(w.owner.query(`update cost_runs set complete = false`)).rejects.toThrow();
    const history = expectOk(await call(w.app, M, A, "GET", `/api/lots/${await lotId("MCU-C1")}/costs`));
    expect(history.map((h: any) => h.unitCost)).toEqual(["13", "12.5"]);
    const fg = expectOk(await call(w.app, W, A, "GET", `/api/lots/lookup?code=${wo1.code}`))[0].id;
    const fgCost = expectOk(await call(w.app, M, A, "GET", `/api/lots/${fg}/costs`));
    expect(fgCost[0]).toMatchObject({ unitCost: "719.36", source: "production" });
  });

  it("sıfır sağlam adette birim maliyet hesaplanmaz; toplam kayıp gösterilir", async () => {
    const c = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo2.id}/costs`));
    expect(c.unitCost).toBeNull();
    expect(c.unitCostNote).toContain("toplam kayıp");
    expect(Number(c.totals.total)).toBeGreaterThan(0);
  });

  it("dış hizmet (fason) maliyeti: bir iş emrine bağlı tamamlanmış fason iş, iş emri maliyetine 'dış hizmet' kalemi olarak yansır", async () => {
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    const role = (await w.owner.query(`select id from roles where company_id = $1 and code = 'subcontractor'`, [A])).rows[0];
    const subUserId = await createUser(w.owner, { email: "fason@costing.test", name: "Maliyet Fasonu", password: PASSWORD, companyId: A, roles: ["subcontractor"], roleIds: { subcontractor: role.id } });
    await w.owner.query(`update memberships set is_external = true where company_id = $1 and user_id = $2`, [A, subUserId]);

    const jobId = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/subcontract-jobs", {
      subcontractorUserId: subUserId, kind: "dizgi", scope: "iş emrine bağlı dış hizmet maliyeti testi", qty: "1",
      price: "250", workOrderId: wo2.id,
    })).id;
    // Henüz tamamlanmadı: iş emri maliyetinde eksik olarak işaretlenir, tutara sayılmaz
    const cPending = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo2.id}/costs`));
    const baseTotal = Number(cPending.totals.total);
    expect(cPending.totals.external).toBe("0");
    expect(cPending.gaps.join(" ")).toContain("henüz tamamlanmadı");
    expect(cPending.externals.find((e: any) => e.jobCode)).toMatchObject({ status: "proposed", cost: null });

    expectOk(await call(w.app, "fason@costing.test", A, "POST", `/api/subcontract-jobs/${jobId}/decision`, { decision: "accept" }));
    expectOk(await call(w.app, "fason@costing.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "prep" }));
    expectOk(await call(w.app, "fason@costing.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "in_production" }));
    expectOk(await call(w.app, "fason@costing.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "testing" }));
    expectOk(await call(w.app, "fason@costing.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "ready_to_ship" }));
    expectOk(await call(w.app, "fason@costing.test", A, "POST", `/api/subcontract-jobs/${jobId}/declare`, { goodQty: "1", scrapQty: "0", unusedQty: "0", note: "tamam" }));
    const capItemId = expectOk(await call(w.app, W, A, "GET", "/api/lots/lookup?code=CAP-C1"))[0].itemId;
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/subcontract-jobs/${jobId}/accept-output`, { itemId: capItemId, lotNo: "COSTING-SJ-OUT-1", qty: "1" }));

    const c = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo2.id}/costs`));
    expect(c.totals.external).toBe("250");
    expect(Number(c.totals.total)).toBeCloseTo(baseTotal + 250, 6);
    expect(c.externals).toContainEqual(expect.objectContaining({ status: "completed", price: "250", cost: "250", note: null }));
    expect(c.gaps.join(" ")).not.toContain("henüz tamamlanmadı");
  });
});

describe("Satış kârlılığı ve metrikler", () => {
  let orderId: string;
  it("yalnızca sevk edilen miktar için gelir ve satılan malın maliyeti", async () => {
    const o = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: plus(30), lines: [{ productRevisionId: rev, qty: "3", unitPrice: "1000" }] }));
    orderId = o.id;
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o.id}/confirm`));
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o.id}/estimate`));
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o.id}/promise`, { date: plus(10), acceptRisk: true, note: "Stoktan" }));
    let r = expectOk(await call(w.app, M, A, "GET", `/api/reports/margin?from=${today}&to=${plus(1)}`));
    expect(r.rows).toHaveLength(0); // sevk yok → kâr yok
    const sh = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o.id}/shipments`, { lines: [{ lineId: o.lines[0].id, qty: "3" }] }));
    const serials = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/work-orders/${wo1.id}`)).devices.filter((d: any) => d.status === "released").map((d: any) => d.serial);
    for (const s of serials) expectOk(await call(w.app, W, A, "POST", `/api/packages/${sh.packages[0].id}/items`, { code: s }));
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${sh.packages[0].id}/close`, { checklist: ALL }));
    expectOk(await call(w.app, W, A, "POST", `/api/shipments/${sh.id}/pack-complete`));
    expectOk(await call(w.app, W, A, "POST", `/api/shipments/${sh.id}/ship`, { carrier: "Test kargo" }));
    expect((await call(w.app, "sales@a.test", A, "GET", `/api/reports/margin?from=${today}&to=${plus(1)}`)).status).toBe(403);
    r = expectOk(await call(w.app, M, A, "GET", `/api/reports/margin?from=${today}&to=${plus(1)}`));
    expect(r.rows[0]).toMatchObject({ qty: "3", revenue: "3000", cogs: "2158.08", grossProfit: "841.92", grossMargin: 0.28064, costSource: "production" });
    expect(r.totals).toEqual([{ currency: "TRY", revenue: "3000", cogs: "2158.08", grossProfit: "841.92", grossMargin: 0.28064 }]);
    expect(r.incompleteLines).toBe(0);
  });

  it("metrikler tanım, pay ve paydayla döner; kaynak kayıtlar açılabilir", async () => {
    const m = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/metrics?from=${plus(-1)}&to=${plus(30)}`));
    const by = Object.fromEntries(m.metrics.map((x: any) => [x.key, x]));
    expect(by.scrap_rate).toMatchObject({ numerator: 2, denominator: 5, value: 0.4 });
    expect(by.first_pass_yield).toMatchObject({ numerator: 3, denominator: 5, value: 0.6 });
    expect(by.rework_rate).toMatchObject({ numerator: 0, denominator: 5, value: 0 });
    expect(by.component_scrap).toMatchObject({ numerator: 0, denominator: 15 });
    expect(by.on_time_delivery).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(by.return_rate).toMatchObject({ numerator: 0, denominator: 3, value: 0 });
    expect(by.budget_variance.value).toBeNull();
    expect(by.budget_variance.reason).toContain("bütçe");
    expect(by.first_pass_yield.definition).toContain("Tekrar testler");
    const src = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/metrics/scrap_rate/sources?from=${plus(-1)}&to=${plus(30)}`));
    expect(src.rows).toHaveLength(5);
    expect(src.rows.filter((r: any) => r.scrappedInProduction)).toHaveLength(2);
    // Ürün filtresi ve boş kapsam: payda sıfırsa hesaplanamaz
    const empty = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/metrics?from=2020-01-01&to=2020-01-31`));
    expect(empty.metrics.find((x: any) => x.key === "scrap_rate")).toMatchObject({ value: null, reason: "Payda sıfır: hesaplanamaz" });
    expect((await call(w.app, T, A, "GET", `/api/metrics?from=${today}&to=${today}`)).status).toBe(403);
    void orderId;
  });
});

describe("Kur ve bütçe sapması (oturum 41, kalan işler 7b)", () => {
  it("iş emri maliyeti: farklı para birimindeki lot maliyeti kayıt tarihindeki kurla çevrilir; kur yoksa eksik", async () => {
    // Kondansatör lotuna USD maliyet (bugün): 2 adet × 0,01 USD
    expectOk(await call(w.app, P, A, "POST", `/api/lots/${await lotId("CAP-C1")}/cost`, { unitCost: "0.01", currency: "USD", source: "invoice", reference: "FTR-USD" }));
    let c = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo2.id}/costs`));
    const cap = () => c.materials.find((m: any) => m.itemCode === "CMP-TESTPASSIVE-CAP-C");
    expect(cap()).toMatchObject({ currency: "USD", cost: null });
    expect(cap().note).toMatch(/USD→TRY kuru yok/);
    expect(c.complete).toBe(false);

    expect((await call(w.app, "warehouse@a.test", A, "GET", "/api/exchange-rates")).status).toBe(403);
    expectOk(await call(w.app, M, A, "POST", "/api/exchange-rates", { baseCurrency: "USD", quoteCurrency: "TRY", rate: "40", rateDate: plus(-2), source: "TCMB döviz alış" }));
    c = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo2.id}/costs`));
    expect(cap()).toMatchObject({ currency: "USD", unitCost: "0.01", cost: "0.8", fx: `1 USD = 40 TRY (${plus(-2)}, TCMB döviz alış)` });
    expect(c.totals.material).toBe("13.8"); // MCU 1 × 13 TRY + kondansatör 2 × 0,01 USD × 40
    const list = expectOk(await call(w.app, M, A, "GET", "/api/exchange-rates?currency=USD"));
    expect(list[0]).toMatchObject({ baseCurrency: "USD", quoteCurrency: "TRY", source: "TCMB döviz alış" });
  });

  it("bütçe sapması: açık Ar-Ge projesinde (gerçekleşen − onaylı baz bütçe) / baz; bütçe revizyonu yeni sürüm", async () => {
    const p = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/rd-projects", { name: "Bütçeli proje", budgetAmount: "5000", currency: "TRY" }));
    expectOk(await call(w.app, M, A, "POST", `/api/rd-projects/${p.id}/cost-allocations`, { amount: "100", currency: "EUR", description: "Avrupa laboratuvarı", reason: "Tamamı bu projeye", category: "test" }));
    let m = expectOk(await call(w.app, M, A, "GET", `/api/metrics?from=${today}&to=${today}`));
    let bv = m.metrics.find((x: any) => x.key === "budget_variance");
    expect(bv.value).toBeNull();
    const src = expectOk(await call(w.app, M, A, "GET", `/api/metrics/budget_variance/sources?from=${today}&to=${today}`));
    expect(src.rows[0]).toMatchObject({ baseline: "5000", actual: null });
    expect(src.rows[0].note).toMatch(/EUR→TRY kuru yok/);

    // Ters çift: 1 TRY = 0,025 EUR → 1 EUR = 40 TRY
    expectOk(await call(w.app, M, A, "POST", "/api/exchange-rates", { baseCurrency: "TRY", quoteCurrency: "EUR", rate: "0.025", rateDate: today, source: "Banka" }));
    m = expectOk(await call(w.app, M, A, "GET", `/api/metrics?from=${today}&to=${today}`));
    bv = m.metrics.find((x: any) => x.key === "budget_variance");
    expect(bv).toMatchObject({ numerator: -1000, denominator: 5000, value: -0.2 });

    expect((await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${p.id}/budget`, { amount: "3000", currency: "TRY", reason: "Kapsam daraldı" })).status).toBe(403);
    expectOk(await call(w.app, M, A, "POST", `/api/rd-projects/${p.id}/budget`, { amount: "3000", currency: "TRY", reason: "Kapsam daraldı" }));
    const d = expectOk(await call(w.app, M, A, "GET", `/api/rd-projects/${p.id}`));
    expect(d.budgetVersions.map((v: any) => [v.versionNo, v.amount])).toEqual([[2, "3000.00"], [1, "5000.00"]]);
    expect(d.budgetStatus).toMatchObject({ budgetAmount: "3000.00" });
    m = expectOk(await call(w.app, M, A, "GET", `/api/metrics?from=${today}&to=${today}`));
    bv = m.metrics.find((x: any) => x.key === "budget_variance");
    expect(bv).toMatchObject({ numerator: 1000, denominator: 3000 });
    expect(bv.value).toBeCloseTo(0.3333, 4);
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await expect(w.owner.query(`update rd_project_budgets set amount = 1`)).rejects.toThrow(/append/i);
  });
});
