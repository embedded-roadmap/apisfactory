/**
 * Ar-Ge payının ürün maliyetine aktarımı (ana talimat §8, §18): devir raporu ÷ planlanan adet = birim pay; iş emri
 * maliyetine sağlam adet × birim pay eklenir; toplam aktarım plan tutarını aşmaz (aynı gider iki kez sayılmaz).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let rev: string;
let projectId: string;
const M = "manager@a.test";
const W = "warehouse@a.test";
const T = "technician@a.test";
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const lotId = async (lotNo: string) => expectOk(await call(w.app, W, A, "GET", `/api/lots/lookup?code=${lotNo}`))[0].id as string;

async function produce(qty: string, pass: number) {
  const wo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: rev, qty }));
  const rel = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo.id}/release`));
  expectOk(await call(w.app, W, A, "POST", `/api/work-orders/${wo.id}/issue`, { lotId: await lotId("AM-MCU-1"), qty }));
  for (const op of rel.operations) {
    expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/start`));
    if (op.isQualityGate) {
      for (const [i, d] of rel.devices.entries()) {
        expectOk(await call(w.app, T, A, "POST", `/api/devices/${d.serial}/test`, { result: i < pass ? "pass" : "fail" }));
        if (i >= pass) expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/devices/${d.serial}/disposition`, { decision: "scrap", note: "Hata" }));
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
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "AM-1", name: "Amortisman kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "a.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;AM-MCU;1;MCU;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  const sp = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", {
    fileName: "s.csv", content: "kod,miktar,lot,konum\nCMP-TESTSEMI-AM-MCU,20,AM-MCU-1,STK", mapping: { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum" },
  }));
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/lots/${await lotId("AM-MCU-1")}/cost`, { unitCost: "10", currency: "TRY", source: "invoice", reference: "FTR-AM" }));
  expectOk(await call(w.app, M, A, "POST", "/api/cost-policies", { validFrom: "2026-01-01", currency: "TRY", laborRatePerHour: "600", includeRdShare: true, note: "Ar-Ge payı dahil" }));

  projectId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/rd-projects", { name: "Amortisman projesi" })).id;
  expectOk(await call(w.app, M, A, "POST", `/api/rd-projects/${projectId}/cost-allocations`, { amount: "1000", currency: "TRY", description: "Tasarım hizmeti", reason: "Tamamı bu ürün", category: "external_service" }));
  expectOk(await call(w.app, "rd@a.test", A, "PUT", `/api/revisions/${rev}/rd-project`, { projectId, reason: "Ürün bu projeden" }));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${rev}/handover`, { area, decision: "approve" }));
  }
  await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Ar-Ge payı amortismanı", () => {
  let wo1: any;
  it("plan: devir raporu toplamı ÷ planlanan adet; yetki ve rapor zorunluluğu", async () => {
    const report = expectOk(await call(w.app, M, A, "GET", `/api/revisions/${rev}/rd-cost-reports`))[0];
    expect(report).toMatchObject({ versionNo: 1, status: "final" });
    expect((await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/rd-amortization`, { plannedUnits: 100, reason: "deneme" })).status).toBe(403);
    const plan = expectOk(await call(w.app, M, A, "POST", `/api/revisions/${rev}/rd-amortization`, { plannedUnits: 100, reason: "İlk yıl 100 adet" }));
    expect(plan).toMatchObject({ versionNo: 1, amount: "1000.00", currency: "TRY", plannedUnits: 100, reportStatus: "final" });
    const list = expectOk(await call(w.app, M, A, "GET", `/api/revisions/${rev}/rd-amortization`));
    expect(list[0]).toMatchObject({ perUnit: "10.000000" });
    await expect(w.owner.query(`update rd_amortization_plans set planned_units = 1`)).rejects.toThrow(/append/i);
  });

  it("iş emri maliyetine sağlam adet × birim pay eklenir; birim maliyete yansır", async () => {
    wo1 = await produce("4", 3);
    const c = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo1.id}/costs`));
    expect(c.totals.rdShare).toBe("30"); // 3 × 10
    expect(c.rdShareNote).toContain("birim 10 × 3 sağlam");
    expect(Number(c.totals.total)).toBeCloseTo(Number(c.totals.material) + Number(c.totals.labor) + Number(c.totals.overhead) + 30, 6);
  });

  it("plan revizyonu: toplam aktarım plan tutarını aşmaz; ikinci iş emrine kalan pay yoksa 0", async () => {
    expectOk(await call(w.app, M, A, "POST", `/api/revisions/${rev}/rd-amortization`, { plannedUnits: 2, reason: "Ürün ömrü kısaldı" }));
    const c1 = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo1.id}/costs`));
    expect(c1.totals.rdShare).toBe("1000"); // istenen 3 × 500 = 1500, plan 1000
    expect(c1.rdShareNote).toContain("plan tutarı doldu");
    const wo2 = await produce("2", 2);
    const c2 = expectOk(await call(w.app, M, A, "POST", `/api/work-orders/${wo2.id}/costs`));
    expect(c2.totals.rdShare).toBe("0");
    expect(c2.rdShareNote).toContain("diğer iş emirlerinde aktarılan 1000");
  });
});
