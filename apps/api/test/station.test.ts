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
let woId: string;
let S: string[] = [];

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
  const wo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: revA, qty: "5" }));
  woId = wo.id;
  const rel = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${woId}/release`));
  S = rel.devices.map((d: any) => d.serial);
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("MCU7-A"), qty: "5" }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("CAP7-A"), qty: "10" }));
  for (const op of rel.operations.slice(0, 4)) {
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${op.id}/start`, {}));
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${op.id}/complete`, {}));
  }
  expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${rel.operations[4].id}/start`, {}));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

const MAP = {
  serial: "SerialNo", runId: "RunID", timestamp: "Time", result: "Result", firmware: "FW", decimal: ",",
  measurements: [{ column: "V3V3_mV", name: "V3V3", scale: 0.001 }, { column: "Iidle_mA", name: "I_idle", scale: 0.001 }, { column: "RSSI", name: "RSSI", scale: 1 }],
};
let conn: string;
let batchId: string;
const csvRow = (serial: string, run: string, v: string, i: string, res: string, fw = FW) => `${serial};${run};2026-09-23 10:${run.slice(-2)}:00;${v};${i};-60;${res};${fw}`;
const HEAD = "SerialNo;RunID;Time;V3V3_mV;Iidle_mA;RSSI;Result;FW";

describe("Test istasyonu adaptörü (W22)", () => {
  it("bağlayıcı yalnızca ekipman yetkisiyle ve test istasyonu türündeki ekipmana tanımlanır", async () => {
    const tech = await call(w.app, "technician@a.test", A, "POST", "/api/test-station/connectors", { code: "ICT1", name: "ICT", equipmentId: eqSt, mapping: MAP });
    expect(tech.status).toBe(403);
    const dmm = await call(w.app, "quality@a.test", A, "POST", "/api/test-station/connectors", { code: "DMM", name: "DMM", equipmentId: eqDmm, mapping: MAP });
    expect(dmm.body.error.code).toBe("equipment_kind");
    conn = expectOk(await call(w.app, "quality@a.test", A, "POST", "/api/test-station/connectors", { code: "ict1", name: "ICT hattı 1", equipmentId: eqSt, mapping: MAP })).id;
    const list = expectOk(await call(w.app, "technician@a.test", A, "GET", "/api/test-station/connectors"));
    expect(list[0]).toMatchObject({ code: "ICT1", mode: "test", equipmentCode: "ICT-1" });
    const integ = expectOk(await call(w.app, "technician@a.test", A, "GET", "/api/integrations"));
    expect(integ.find((i: any) => i.key === "test_station").mode).toBe("test");
    // Diğer şirket göremez
    expect(expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/test-station/connectors"))).toHaveLength(0);
  });

  it("CSV önizleme kayıt yazmaz; her satır gerçek kurallarla değerlendirilir", async () => {
    const bad = await call(w.app, "technician@a.test", A, "POST", `/api/test-station/connectors/${conn}/preview`, { content: "SerialNo;Result\nX;PASS" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.missing).toContain("V3V3_mV");
    const csv = [
      HEAD,
      csvRow(S[0]!, "R01", "3300", "20,5", "PASS"), // geçti (mV/mA → V/A ölçeklenir)
      csvRow(S[1]!, "R02", "3600", "20", "FAIL"), // limit dışı, istasyon da kaldı diyor
      csvRow("YOK-999", "R03", "3300", "20", "PASS"), // bilinmeyen seri
      csvRow(S[2]!, "R04", "3300", "20", "PASS", "1.3.0"), // yanlış firmware
      csvRow(S[3]!, "R05", "abc", "20", "PASS"), // sayı değil
      csvRow(S[0]!, "R06", "3300", "20", "PASS"), // aynı cihaz tekrar: geçmiş cihaz test alamaz
      csvRow(S[4]!, "R07", "3500", "20", "PASS"), // istasyon geçti diyor ama plan limiti dışında
    ].join("\n");
    const p = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/test-station/connectors/${conn}/preview`, { fileName: "ict_0923.csv", content: csv }));
    batchId = p.id;
    expect(p.status).toBe("preview");
    const st = p.rows.map((r: any) => [r.status, r.result ?? r.code]);
    expect(st).toEqual([
      ["ready", "pass"], ["ready", "fail"], ["unknown_serial", "unknown_serial"], ["rejected", "wrong_firmware"],
      ["invalid", "invalid"], ["rejected", "invalid_transition"], ["rejected", "measurement_out_of_limit"],
    ]);
    expect(p.rows[0].measurements).toEqual([{ name: "V3V3", value: 3.3 }, { name: "I_idle", value: 0.0205 }, { name: "RSSI", value: -60 }]);
    expect(p.rows[0].externalRunId).toBe("ICT1:R01");
    const dev = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/devices/${S[0]}`));
    expect(dev.testRuns).toHaveLength(0);
    expect(dev.status).toBe("in_process");
    // Aynı dosya ikinci kez: yeni yükleme açılmaz
    const again = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/test-station/connectors/${conn}/preview`, { fileName: "kopya.csv", content: csv }));
    expect(again).toMatchObject({ id: batchId, duplicateFile: true });
  });

  it("onay kaydeder; kaynak ve istasyon zamanı test kaydında, reddedilen satır olay defterinde", async () => {
    const c = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/test-station/batches/${batchId}/commit`));
    expect(c.status).toBe("committed");
    expect(c.summary).toMatchObject({ recorded: 2, rejected: 3, unknown_serial: 1, invalid: 1 });
    const d0 = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/devices/${S[0]}`));
    expect(d0.status).toBe("passed");
    expect(d0.testRuns).toHaveLength(1);
    expect(d0.testRuns[0]).toMatchObject({ source: "station_csv", station: "ICT1", equipmentCode: "ICT-1", externalRunId: "ICT1:R01", testPlanVersion: 1 });
    expect(new Date(d0.testRuns[0].measuredAt).toISOString()).toBe("2026-09-23T07:01:00.000Z"); // bölgesiz zaman +03:00 kabul edilir
    const d1 = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/devices/${S[1]}`));
    expect(d1.status).toBe("test_failed");
    const d2 = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/devices/${S[2]}`));
    const hist = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/history/device/${d2.id}`));
    expect(hist.map((e: any) => e.eventType)).toContain("test.rejected.wrong_firmware");
    // Tekrar onay: aynı sonuç, yeni kayıt yok
    const c2 = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/test-station/batches/${batchId}/commit`));
    expect(c2.summary.recorded).toBe(2);
    const list = expectOk(await call(w.app, "quality@a.test", A, "GET", "/api/test-station/batches"));
    expect(list[0]).toMatchObject({ recorded: 2, problems: 5, status: "committed" });
  });

  it("istasyon API'si: belirteçle, tekrar gönderimde çift kayıt yok, iptal/devre dışı çalışmaz", async () => {
    const none = await w.app.inject({ method: "POST", url: "/api/station/runs", payload: { runs: [{ SerialNo: S[2] }] } });
    expect(none.statusCode).toBe(401);
    const t1 = expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/test-station/connectors/${conn}/token`)).token as string;
    const t2 = expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/test-station/connectors/${conn}/token`)).token as string;
    const push = (token: string, runs: unknown[]) => w.app.inject({ method: "POST", url: "/api/station/runs", headers: { "x-station-token": token }, payload: { runs } });
    const run = { SerialNo: S[2], RunID: "R10", Time: "2026-09-23T11:00:00Z", V3V3_mV: "3310", Iidle_mA: 21, RSSI: -70, Result: "PASS", FW };
    expect((await push(t1, [run])).statusCode).toBe(401); // eski belirteç geçersiz
    const r = await push(t2, [run]);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mode: "test", replay: false, runs: [{ serial: S[2], status: "recorded", result: "pass" }] });
    const replay = (await push(t2, [run])).json();
    expect(replay.replay).toBe(true);
    const dup = (await push(t2, [{ ...run, Time: "2026-09-23T11:05:00Z" }])).json();
    expect(dup.runs[0].status).toBe("duplicate");
    const d2 = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/devices/${S[2]}`));
    expect(d2.testRuns).toHaveLength(1);
    expect(d2.testRuns[0]).toMatchObject({ source: "station_api", operator: null });
    const hist = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/history/device/${d2.id}`));
    expect(hist.find((e: any) => e.eventType === "test.pass").actorKind).toBe("api");
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/test-station/connectors/${conn}`, { status: "disabled", reason: "İstasyon bakımda" }));
    const off = await push(t2, [{ ...run, RunID: "R11" }]);
    expect(off.json().error.code).toBe("connector_disabled");
  });
});
