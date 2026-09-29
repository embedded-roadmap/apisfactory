/**
 * R32/R34 (ana talimat §18): prototip/pilot/seri ayrımı ve ürün karmaşıklığı — metrikler aşamaya göre süzülür, ekip
 * raporu operasyon/testleri aşama ve karmaşıklığa göre ayırır (puan değildir).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let rev: string;
let productId: string;
const W = "warehouse@a.test";
const T = "technician@a.test";
const M = "manager@a.test";
const today = new Date().toISOString().slice(0, 10);
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };

async function produce(qty: string, pass: number, productionStage?: string) {
  const wo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: rev, qty, productionStage }));
  const rel = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo.id}/release`));
  const lot = expectOk(await call(w.app, W, A, "GET", "/api/lots/lookup?code=PS-L1"))[0].id;
  expectOk(await call(w.app, W, A, "POST", `/api/work-orders/${wo.id}/issue`, { lotId: lot, qty }));
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
  return wo;
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "PS-1", name: "Aşama kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "p.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;PS-MCU;1;MCU;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]] as [string, string][]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${rev}/handover`, { area, decision: "approve" }));
  }
  const sp = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", {
    fileName: "s.csv", content: "kod,miktar,lot,konum\nCMP-TESTSEMI-PS-MCU,10,PS-L1,STK", mapping: { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum" },
  }));
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Üretim aşaması ve ürün karmaşıklığı", () => {
  it("iş emri aşaması varsayılan seri; pilot seçilebilir", async () => {
    const s = await produce("2", 1);
    const p = await produce("2", 0, "pilot");
    expect(expectOk(await call(w.app, M, A, "GET", `/api/work-orders/${s.id}`)).productionStage).toBe("series");
    expect(expectOk(await call(w.app, M, A, "GET", `/api/work-orders/${p.id}`)).productionStage).toBe("pilot");
    expect((await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: rev, qty: "1", productionStage: "mass" })).status).toBe(400);
  });

  it("metrikler aşamaya göre süzülür; filtresiz kapsam notu tüm aşamaları söyler", async () => {
    const m = async (stage?: string) => expectOk(await call(w.app, M, A, "GET", `/api/metrics?from=${today}&to=${today}${stage ? `&stage=${stage}` : ""}`));
    const scrap = (r: any) => r.metrics.find((x: any) => x.key === "scrap_rate");
    expect(scrap(await m("series"))).toMatchObject({ numerator: 1, denominator: 2 });
    expect(scrap(await m("pilot"))).toMatchObject({ numerator: 2, denominator: 2 });
    const all = await m();
    expect(scrap(all)).toMatchObject({ numerator: 3, denominator: 4 });
    expect(all.scope).toContain("tümü");
    const src = expectOk(await call(w.app, M, A, "GET", `/api/metrics/scrap_rate/sources?from=${today}&to=${today}&stage=pilot`));
    expect(src.rows).toHaveLength(2);
  });

  it("ürün karmaşıklığı yetkiyle; ekip raporu aşama ve karmaşıklık kırılımı verir", async () => {
    expect((await call(w.app, "sales@a.test", A, "PUT", `/api/products/${productId}/complexity`, { complexity: "high", reason: "deneme" })).status).toBe(403);
    expectOk(await call(w.app, "rd@a.test", A, "PUT", `/api/products/${productId}/complexity`, { complexity: "high", reason: "Çok katmanlı, BGA" }));
    expect(expectOk(await call(w.app, M, A, "GET", `/api/products/${productId}`)).complexity).toBe("high");
    const r = expectOk(await call(w.app, M, A, "GET", `/api/reports/team?from=${today}&to=${today}`));
    const tech = r.rows.find((x: any) => x.name === "A technician");
    expect(tech.operationsByStage.series).toBeGreaterThan(0);
    expect(tech.operationsByStage.pilot).toBe(tech.operationsByStage.series);
    expect(tech.operationsByComplexity).toEqual({ high: tech.operationsCompleted });
    expect(tech.testsByStage).toEqual({ series: 2, pilot: 2 });
  });
});
