/**
 * Oturum 9 (W22): test istasyonu adaptörü — CSV önizle/onayla ve istasyon API'si; seri eşleşmesi,
 * birim ölçekleme, aynı kurallar (firmware, ekipman, plan limitleri), tekrar koruması, belirteç.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let productId: string;
let revA: string;
let bomV1: string;
const items: Record<string, string> = {};
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
const FW = "1.4.2";
const SHA = "a".repeat(64);
let eqSt: string;
let eqDmm: string;

const today = new Date().toISOString().slice(0, 10);
const addDays = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function lotId(lotNo: string): Promise<string> {
  return expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/lots/lookup?code=${lotNo}`))[0].id;
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "SN-1", name: "Sensör" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;TestSemi;MCU-7;1;MCU;", "C1,C2;TestPassive;CAP-7;2;Kondansatör;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "sn.csv", content: csv, mapping }));
  bomV1 = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bomV1}/publish`));
  for (const l of expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bomV1}`)).lines) items[l.mpn] = l.itemId;
  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bomV1 })).id;
  const stock = "kod,miktar,lot,konum,rev\nCMP-TESTSEMI-MCU-7,10,MCU7-A,STK,\nCMP-TESTPASSIVE-CAP-7,100,CAP7-A,STK,";
  const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: stock, mapping: stockMapping }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  const plan = expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revA}/test-plans`, {
    limits: [{ name: "V3V3", unit: "V", low: 3.2, high: 3.4 }, { name: "I_idle", unit: "A", high: 0.05 }, { name: "RSSI", unit: "dBm", low: -90, required: false }],
  }));
  expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/test-plans/${plan.id}/publish`));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/firmware`, { version: FW, sha256: SHA }));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revA}/handover`, { area, decision: "approve" }));
  }
  eqSt = expectOk(await call(w.app, "quality@a.test", A, "POST", "/api/equipment", { code: "ICT-1", name: "Fonksiyon test istasyonu", kind: "test_station", calibrationDue: addDays(90) })).id;
  eqDmm = expectOk(await call(w.app, "quality@a.test", A, "POST", "/api/equipment", { code: "DMM-1", name: "Multimetre", kind: "measuring", calibrationDue: addDays(90) })).id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});


let wcs: Record<string, string> = {};
let r1: string;
const opsOf = (r: any) => r.operations.map((o: any) => ({ seq: o.seq, name: o.name, workCenterId: o.workCenterId, setupMinutes: o.setupMinutes, minutesPerUnit: o.minutesPerUnit, isQualityGate: o.isQualityGate, instructions: o.instructions }));

describe("Rota ve standart süre (W20)", () => {
  it("rotası olmayan revizyon varsayılan şablonu iş merkezi süreleriyle kullanır", async () => {
    for (const w0 of expectOk(await call(w.app, "production@a.test", A, "GET", "/api/work-centers"))) wcs[w0.code] = w0.id;
    expectOk(await call(w.app, "production@a.test", A, "PUT", "/api/work-centers/SMT", { dailyMinutes: 450, setupMinutes: 60, minutesPerUnit: 1 }));
    const r = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/revisions/${revA}/routings?qty=10`));
    expect(r.active.source).toBe("default");
    expect(r.versions).toHaveLength(0);
    expect(r.estimate.operations.find((o: any) => o.workCenter === "SMT").minutes).toBe(70);
  });

  it("taslak yalnızca yetkiyle; tek kalite kapısı kuralı; yayımlanan rota değişmez", async () => {
    const tech = await call(w.app, "technician@a.test", A, "POST", `/api/revisions/${revA}/routings`, {});
    expect(tech.status).toBe(403);
    const d = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${revA}/routings`, { note: "İlk rota" }));
    r1 = d.id;
    expect(d).toMatchObject({ versionNo: 1, status: "draft" });
    expect(d.operations).toHaveLength(6);
    const again = await call(w.app, "production@a.test", A, "POST", `/api/revisions/${revA}/routings`, {});
    expect(again.body.error.code).toBe("draft_exists");
    // LEH çıkar, SMT süresi, montaj talimatı; iki kalite kapısı → yayım reddi
    let ops = opsOf(d).filter((o: any) => o.name !== "Lehim / THT");
    ops = ops.map((o: any) => (o.name === "Dizgi (SMT)" ? { ...o, setupMinutes: 45, minutesPerUnit: 0.8 } : o.name === "Mekanik montaj" ? { ...o, minutesPerUnit: 3, instructions: "Kapak vidası 0,4 Nm", isQualityGate: true } : o));
    const two = expectOk(await call(w.app, "production@a.test", A, "PUT", `/api/routings/${r1}`, { operations: ops }));
    expect(two.errors.join(" ")).toContain("tam olarak bir kalite kapısı");
    const bad = await call(w.app, "production@a.test", A, "POST", `/api/routings/${r1}/publish`, { note: "yayım" });
    expect(bad.body.error.code).toBe("routing_invalid");
    ops = ops.map((o: any) => (o.name === "Mekanik montaj" ? { ...o, isQualityGate: false } : o));
    const dupSeq = await call(w.app, "production@a.test", A, "PUT", `/api/routings/${r1}`, { operations: [...ops, { ...ops[0], name: "Tekrar" }] });
    expect(dupSeq.status).toBe(409); // benzersiz sıra (veri tabanı)
    expectOk(await call(w.app, "production@a.test", A, "PUT", `/api/routings/${r1}`, { operations: ops }));
    const pub = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/routings/${r1}/publish`, { note: "SMT hattı iyileştirmesi, THT yok" }));
    expect(pub.status).toBe("published");
    expect(pub.operations).toHaveLength(5);
    const edit = await call(w.app, "production@a.test", A, "PUT", `/api/routings/${r1}`, { operations: ops });
    expect(edit.body.error.code).toBe("routing_published");
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await expect(w.owner.query(`update routing_operations set minutes_per_unit = 9 where routing_id = $1`, [r1])).rejects.toThrow(/routing_published/);
  });

  let wo1: string;
  it("iş emri yayımlanan rotayı ve planlı süreleri kopyalar; yeni sürüm açık işi değiştirmez", async () => {
    const w1 = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: revA, qty: "10" }));
    wo1 = w1.id;
    expect(w1.routingVersionNo).toBe(1);
    expect(w1.operations.map((o: any) => o.workCenter)).toEqual(["HAZ", "SMT", "PRG", "TST", "MON"]);
    expect(w1.operations.find((o: any) => o.workCenter === "SMT").plannedMinutes).toBe(53);
    expect(w1.operations.find((o: any) => o.workCenter === "MON")).toMatchObject /* hazırlık 10 + 10 × 3 */({ instructions: "Kapak vidası 0,4 Nm", plannedMinutes: 40 });
    // v2: SMT daha yavaş
    const d2 = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${revA}/routings`, { copyFrom: r1 }));
    expect(d2.versionNo).toBe(2);
    const ops = opsOf(d2).map((o: any) => (o.name === "Dizgi (SMT)" ? { ...o, minutesPerUnit: 2 } : o));
    expectOk(await call(w.app, "production@a.test", A, "PUT", `/api/routings/${d2.id}`, { operations: ops }));
    const pub = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/routings/${d2.id}/publish`, { note: "Yeni nozul, yavaş" }));
    expect(pub.openWorkOrdersUnchanged).toBe(1);
    const old = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/work-orders/${wo1}`));
    expect(old.routingVersionNo).toBe(1);
    expect(old.operations.find((o: any) => o.workCenter === "SMT").plannedMinutes).toBe(53);
    const list = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/revisions/${revA}/routings?qty=10`));
    expect(list.versions.map((v: any) => [v.versionNo, v.status])).toEqual([[2, "published"], [1, "archived"]]);
    expect(list.versions[1].workOrderCount).toBe(1);
    expect(list.active).toMatchObject({ source: "routing", versionNo: 2 });
    expect(list.estimate.operations.find((o: any) => o.workCenter === "SMT").minutes).toBe(65);
    const hist = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/history/product_revision/${revA}`));
    expect(hist.filter((e: any) => e.eventType === "routing.published")).toHaveLength(2);
    // Taslak açılıp vazgeçilebilir
    const d3 = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${revA}/routings`, {}));
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/routings/${d3.id}/discard`));
    expect(expectOk(await call(w.app, "production@a.test", A, "GET", `/api/revisions/${revA}/routings`)).versions).toHaveLength(2);
  });

  it("termin kapasitesi revizyon rotasından; kuyruk iş emrine kopyalanan sürelerden", async () => {
    const customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "C-R", name: "Rota Müşterisi" })).id;
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/items/${items["MCU-7"]}/lead-time`, { days: 7 }));
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/items/${items["CAP-7"]}/lead-time`, { days: 7 }));
    const o = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: addDays(40), lines: [{ productRevisionId: revA, qty: "20" }] }));
    const est = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o.id}/estimate`));
    expect(est.status).toBe("ok");
    expect(est.workCenters.map((c: any) => c.code)).toEqual(["HAZ", "SMT", "PRG", "TST", "MON"]); // LEH yok
    const smt = est.workCenters.find((c: any) => c.code === "SMT");
    expect(smt.ownMinutes).toBe(45 + 20 * 2);
    expect(smt.queueMinutes).toBe(53); // açık iş emri v1 süresiyle
    expect(est.assumptions.join(" ")).toContain("rota v2");
  });
});
