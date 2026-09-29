/**
 * R16/R17/R18: giriş, ara ve son kontrol listeleri (ana talimat §15, §16).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let rev: string;
let mcuItem: string;
const Q = "quality@a.test";
const P = "production@a.test";
const T = "technician@a.test";
const W = "warehouse@a.test";
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const plans: Record<string, string> = {};
const record = (planId: string, contextType: string, contextId: string, results: { key: string; value: unknown }[], user = T) =>
  call(w.app, user, A, "POST", "/api/check-records", { planId, contextType, contextId, results });

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "CK-1", name: "Kontrol kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "c.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;CK-MCU;1;MCU;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${rev}/handover`, { area, decision: "approve" }));
  }
  const sp = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", {
    fileName: "s.csv", content: "kod,miktar,lot,konum\nCMP-TESTSEMI-CK-MCU,10,CK-L1,STK", mapping: { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum" },
  }));
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  mcuItem = expectOk(await call(w.app, W, A, "GET", "/api/lots/lookup?code=CK-L1"))[0].itemId;
  await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Kontrol listeleri", () => {
  it("plan yalnız kaliteyle; ölçüm sınırı zorunlu; plan sürümlü ve değişmez", async () => {
    const smt = { code: "SMT-KL", name: "SMT ara kontrol", stage: "in_process", workCenterCode: "SMT", note: "İlk sürüm",
      items: [{ key: "lehim", label: "Lehim görsel kontrol", kind: "check" }, { key: "v3v3", label: "3V3 hattı", kind: "measure", unit: "V", low: 3.2, high: 3.4 }] };
    expect((await call(w.app, T, A, "POST", "/api/check-plans", smt)).status).toBe(403);
    expect((await call(w.app, Q, A, "POST", "/api/check-plans", { ...smt, code: "BAD-1", items: [{ key: "x", label: "Sınırsız", kind: "measure" }] })).body.error.code).toBe("invalid_limit");
    plans.smt = expectOk(await call(w.app, Q, A, "POST", "/api/check-plans", smt)).id;
    plans.incoming = expectOk(await call(w.app, Q, A, "POST", "/api/check-plans", { code: "GK-MCU", name: "MCU giriş kontrolü", stage: "incoming", itemId: mcuItem, note: "Ambalaj",
      items: [{ key: "ambalaj", label: "ESD ambalaj sağlam", kind: "check" }, { key: "not", label: "Not", kind: "text", required: false }] })).id;
    plans.final = expectOk(await call(w.app, Q, A, "POST", "/api/check-plans", { code: "SON-1", name: "Son kontrol", stage: "final", productRevisionId: rev, note: "Etiket",
      items: [{ key: "etiket", label: "Seri etiketi okunuyor", kind: "check" }] })).id;
    await expect(w.owner.query(`update check_plans set items = '[]'`)).rejects.toThrow(/append/i);
  });

  let wo: any;
  it("ara kontrol: kayıt yokken ve başarısızken operasyon kapanmaz; başarısız kayıt kalır", async () => {
    wo = expectOk(await call(w.app, P, A, "POST", "/api/work-orders", { productRevisionId: rev, qty: "1" }));
    const rel = expectOk(await call(w.app, P, A, "POST", `/api/work-orders/${wo.id}/release`));
    wo = { ...wo, ...rel };
    expectOk(await call(w.app, W, A, "POST", `/api/work-orders/${wo.id}/issue`, { lotId: (await call(w.app, W, A, "GET", "/api/lots/lookup?code=CK-L1")).body[0].id, qty: "1" }));
    const ops = rel.operations;
    const prep = ops[0];
    expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${prep.id}/start`));
    expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${prep.id}/complete`)); // HAZ: plan yok
    const smtOp = ops.find((o: any) => o.workCenter === "SMT");
    expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${smtOp.id}/start`));
    expect((await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${smtOp.id}/complete`)).body.error.code).toBe("checklist_required");

    const bad = expectOk(await record(plans.smt!, "operation", smtOp.id, [{ key: "lehim", value: true }, { key: "v3v3", value: 3.6 }]));
    expect(bad.passed).toBe(false);
    expect(bad.findings.join(" ")).toContain("üst sınır 3.4");
    expect((await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${smtOp.id}/complete`)).body.error.code).toBe("checklist_failed");
    expect(expectOk(await record(plans.smt!, "operation", smtOp.id, [{ key: "lehim", value: true }])).findings.join(" ")).toContain("zorunlu");
    expect(expectOk(await record(plans.smt!, "operation", smtOp.id, [{ key: "lehim", value: true }, { key: "v3v3", value: 3.31 }])).passed).toBe(true);
    expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${smtOp.id}/complete`));

    const all = await w.owner.query(`select passed from check_records where context_id = $1 order by recorded_at`, [smtOp.id]);
    expect(all.rows.map((r) => r.passed)).toEqual([false, false, true]); // ilk başarısız kayıt silinmedi
    await expect(w.owner.query(`update check_records set passed = true`)).rejects.toThrow(/append/i);
    expect((await call(w.app, "sales@a.test", A, "POST", "/api/check-records", { planId: plans.smt, contextType: "operation", contextId: smtOp.id, results: [] })).status).toBe(403);
  });

  it("plan yeni sürüme geçince eski sürüme kayıt yapılamaz; son kontrol stoğa bırakmayı engeller", async () => {
    const v2 = expectOk(await call(w.app, Q, A, "POST", "/api/check-plans", { code: "SMT-KL", name: "SMT ara kontrol", stage: "in_process", workCenterCode: "SMT", note: "Sınır daraldı",
      items: [{ key: "lehim", label: "Lehim görsel kontrol", kind: "check" }, { key: "v3v3", label: "3V3 hattı", kind: "measure", unit: "V", low: 3.25, high: 3.35 }] }));
    expect(v2.versionNo).toBe(2);
    const smtOp = wo.operations.find((o: any) => o.workCenter === "SMT");
    expect((await record(plans.smt!, "operation", smtOp.id, [{ key: "lehim", value: true }, { key: "v3v3", value: 3.3 }])).body.error.code).toBe("plan_not_applicable");
    expect((await call(w.app, Q, A, "POST", "/api/check-plans", { code: "SMT-KL", name: "Aşama denemesi", stage: "final", note: "aşama", items: [{ key: "a", label: "aa", kind: "check" }] })).body.error.code).toBe("stage_change");

    // Kalan operasyonlar (plansız) ve kalite kapısı
    for (const op of wo.operations.filter((o: any) => o.seq > smtOp.seq)) {
      expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/start`));
      if (op.isQualityGate) {
        for (const d of wo.devices) expectOk(await call(w.app, T, A, "POST", `/api/devices/${d.serial}/test`, { result: "pass" }));
        expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`));
        expect((await call(w.app, Q, A, "POST", `/api/work-orders/${wo.id}/release-to-stock`)).body.error.code).toBe("checklist_required");
        expectOk(await record(plans.final!, "work_order", wo.id, [{ key: "etiket", value: true }], Q));
        expectOk(await call(w.app, Q, A, "POST", `/api/work-orders/${wo.id}/release-to-stock`));
      } else expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`));
    }
    const st = expectOk(await call(w.app, P, A, "GET", `/api/check-status?contextType=work_order&contextId=${wo.id}`));
    expect(st).toEqual([expect.objectContaining({ code: "SON-1", last: expect.objectContaining({ passed: true }) })]);
  });

  it("giriş kontrolü: kabul için geçmiş kayıt gerekir; tamamen ret her zaman mümkün", async () => {
    const r1 = expectOk(await call(w.app, W, A, "POST", "/api/receipts", { supplierName: "X", lines: [{ itemId: mcuItem, lotNo: "CK-IN-1", qty: "5" }] }));
    const line1 = r1.lines[0].id;
    expect((await call(w.app, Q, A, "POST", `/api/receipt-lines/${line1}/inspection`, { acceptedQty: "5", rejectedQty: "0" })).body.error.code).toBe("checklist_required");
    expect(expectOk(await record(plans.incoming!, "receipt_line", line1, [{ key: "ambalaj", value: false }])).passed).toBe(false);
    expect((await call(w.app, Q, A, "POST", `/api/receipt-lines/${line1}/inspection`, { acceptedQty: "5", rejectedQty: "0" })).body.error.code).toBe("checklist_failed");
    expectOk(await call(w.app, Q, A, "POST", `/api/receipt-lines/${line1}/inspection`, { acceptedQty: "0", rejectedQty: "5", note: "Ambalaj hasarlı" }));

    const r2 = expectOk(await call(w.app, W, A, "POST", "/api/receipts", { supplierName: "X", lines: [{ itemId: mcuItem, lotNo: "CK-IN-2", qty: "3" }] }));
    expectOk(await record(plans.incoming!, "receipt_line", r2.lines[0].id, [{ key: "ambalaj", value: true }, { key: "not", value: "Tamam" }]));
    expectOk(await call(w.app, Q, A, "POST", `/api/receipt-lines/${r2.lines[0].id}/inspection`, { acceptedQty: "3", rejectedQty: "0" }));
  });
});
