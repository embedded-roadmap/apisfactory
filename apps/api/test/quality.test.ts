/**
 * Oturum 3: test planı ve limit sürümleri, firmware sabitleme, ekipman kalibrasyonu (T12'nin kalanı),
 * mühendislik değişiklik talebi ve iş emri bekletme, termin tahmini ve müşteriye taahhüt.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { finishAfterWorkingDays, nextWorkingDay } from "../src/modules/leadtime";

let w: World;
let A: string;
let productId: string;
let revA: string;
let bomV1: string;
let customerId: string;
const items: Record<string, string> = {};
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
const FW = "1.4.2";
const SHA = "a".repeat(64);
let planV1: string;
let eqOk: string;
let eqExpired: string;

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
  customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "C9", name: "Müşteri" })).id;
  const stock = "kod,miktar,lot,konum,rev\nCMP-TESTSEMI-MCU-7,10,MCU7-A,STK,\nCMP-TESTPASSIVE-CAP-7,100,CAP7-A,STK,";
  const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: stock, mapping: stockMapping }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Test planı, firmware ve ekipman (T12)", () => {
  it("test planı sürümlüdür; yayımlanan plan değiştirilemez", async () => {
    const tech = await call(w.app, "technician@a.test", A, "POST", `/api/revisions/${revA}/test-plans`, { limits: [{ name: "V3V3", low: 3.2, high: 3.4 }] });
    expect(tech.status).toBe(403);
    const bad = await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revA}/test-plans`, { limits: [{ name: "V3V3", low: 3.5, high: 3.1 }] });
    expect(bad.body.error.code).toBe("invalid_limit");
    const p = expectOk(
      await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revA}/test-plans`, {
        limits: [
          { name: "V3V3", unit: "V", low: 3.2, high: 3.4 },
          { name: "I_idle", unit: "A", high: 0.05 },
          { name: "RSSI", unit: "dBm", low: -90, required: false },
        ],
      }),
    );
    planV1 = p.id;
    expect(p.versionNo).toBe(1);
    expect(p.status).toBe("draft");
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/test-plans/${planV1}/publish`));
    // Yayımlanmış planın limiti veri tabanı seviyesinde de değiştirilemez.
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await expect(w.owner.query(`update test_limits set high = 9 where test_plan_id = $1`, [planV1])).rejects.toThrow(/test_plan_published/);
  });

  it("firmware devirden önce girilir; yayımlanmış revizyonda değiştirilemez", async () => {
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/firmware`, { version: FW, sha256: SHA }));
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "rd", decision: "approve" }));
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "production", decision: "approve" }));
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "quality", decision: "approve" }));
    const late = await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/firmware`, { version: "9.9.9" });
    expect(late.body.error.code).toBe("revision_locked");
  });

  it("ekipman ve kalibrasyon kaydı yalnızca yetkili rolle", async () => {
    const tech = await call(w.app, "technician@a.test", A, "POST", "/api/equipment", { code: "X", name: "X", kind: "fixture" });
    expect(tech.status).toBe(403);
    eqOk = expectOk(await call(w.app, "quality@a.test", A, "POST", "/api/equipment", { code: "TST-A", name: "İstasyon A", kind: "test_station", calibrationDue: addDays(90) })).id;
    eqExpired = expectOk(await call(w.app, "quality@a.test", A, "POST", "/api/equipment", { code: "DMM-X", name: "Multimetre", kind: "measuring", calibrationDue: addDays(-3) })).id;
    const list = expectOk(await call(w.app, "technician@a.test", A, "GET", "/api/equipment"));
    expect(list.find((e: any) => e.code === "DMM-X").calibrationExpired).toBe(true);
  });

  let woId: string;
  let serials: string[];

  it("iş emri test planını ve firmware'i açıldığı andaki sürümle sabitler", async () => {
    const wo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: revA, qty: "3" }));
    woId = wo.id;
    expect(wo.testPlanId).toBe(planV1);
    expect(wo.firmwareVersion).toBe(FW);
    expect(wo.testPlan.limits).toHaveLength(3);
    const rel = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${woId}/release`));
    serials = rel.devices.map((d: any) => d.serial);
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("MCU7-A"), qty: "3" }));
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("CAP7-A"), qty: "6" }));
    for (const op of rel.operations.slice(0, 4)) {
      expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${op.id}/start`, {}));
      expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${op.id}/complete`, {}));
    }
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${rel.operations[4].id}/start`, {}));

    // Plan sonradan yeni sürümle değişse de açık iş eski sürümde kalır.
    const v2 = expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revA}/test-plans`, { limits: [{ name: "V3V3", low: 3.25, high: 3.35 }] }));
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/test-plans/${v2.id}/publish`));
    const again = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/work-orders/${woId}`));
    expect(again.testPlan.versionNo).toBe(1);
  });

  const good = [
    { name: "V3V3", value: 3.3 },
    { name: "I_idle", value: 0.02 },
  ];

  it("T12: yanlış firmware engellenir ve olay kaydı kalır", async () => {
    const none = await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { measurements: good, equipmentId: eqOk });
    expect(none.body.error.code).toBe("firmware_required");
    const wrong = await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { measurements: good, equipmentId: eqOk, firmwareVersion: "1.3.0" });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("wrong_firmware");
    const dev = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/devices/${serials[0]}`));
    expect(dev.testRuns).toHaveLength(0); // test kaydı oluşmadı
    const hist = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/history/device/${dev.id}`));
    expect(hist.map((e: any) => e.eventType)).toContain("test.rejected.wrong_firmware");
  });

  it("T12: kalibrasyonu geçmiş veya hizmet dışı ekipmanla test kaydı alınmaz", async () => {
    const noEq = await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { measurements: good, firmwareVersion: FW });
    expect(noEq.body.error.code).toBe("equipment_required");
    const exp = await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { measurements: good, firmwareVersion: FW, equipmentId: eqExpired });
    expect(exp.body.error.code).toBe("calibration_expired");
    // Kalibrasyon yenilenince kullanılabilir; kayıt değişmez (append-only).
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/equipment/${eqExpired}/calibration`, { calibratedOn: today, validUntil: addDays(365), certificate: "K-001" }));
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/equipment/${eqExpired}/status`, { status: "out_of_service", reason: "Düştü, kontrol edilecek" }));
    const oos = await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { measurements: good, firmwareVersion: FW, equipmentId: eqExpired });
    expect(oos.body.error.code).toBe("equipment_out_of_service");
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await expect(w.owner.query(`delete from calibration_records`)).rejects.toThrow(/append/i);
  });

  it("karar sunucuda plandan verilir: eksik zorunlu ölçüm reddedilir, istemci limiti dikkate alınmaz", async () => {
    const base = { firmwareVersion: FW, equipmentId: eqOk };
    const missing = await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { ...base, measurements: [{ name: "V3V3", value: 3.3 }] });
    expect(missing.body.error.code).toBe("measurement_missing");
    const fake = await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, {
      ...base,
      result: "pass",
      measurements: [{ name: "V3V3", value: 3.6, low: 0, high: 10 }, { name: "I_idle", value: 0.02 }],
    });
    expect(fake.body.error.code).toBe("measurement_out_of_limit");
    const auto = expectOk(
      await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { ...base, measurements: [{ name: "V3V3", value: 3.6 }, { name: "I_idle", value: 0.02 }] }),
    );
    expect(auto.result).toBe("fail");
    expect(auto.outOfLimit).toEqual(["V3V3"]);
    const pass = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[1]}/test`, { ...base, measurements: good }));
    expect(pass.result).toBe("pass");
    const dev = expectOk(await call(w.app, "technician@a.test", A, "GET", `/api/devices/${serials[1]}`));
    expect(dev.testRuns[0].equipmentCode).toBe("TST-A");
    expect(dev.testRuns[0].testPlanVersion).toBe(1);
    expect(dev.testRuns[0].measurements[0]).toMatchObject({ name: "V3V3", low: 3.2, high: 3.4 });
    // Ekipman sorunu çıkarsa etkilenen testler ve cihazlar listelenir.
    const affected = expectOk(await call(w.app, "quality@a.test", A, "GET", `/api/equipment/${eqOk}/affected-tests`));
    expect(affected.map((a: any) => a.serial).sort()).toEqual([serials[0], serials[1]].sort());
  });

  describe("Mühendislik değişiklik talebi (ECR)", () => {
    let crId: string;
    it("üretimi durdur talebi iş emrini bekletir; karar verilmeden devam edilemez", async () => {
      const cr = expectOk(
        await call(w.app, "technician@a.test", A, "POST", "/api/change-requests", {
          workOrderId: woId,
          deviceSerial: serials[0],
          title: "C1 footprint ters",
          description: "Kondansatör C1 polaritesi serigrafide ters; iki kartta gözlendi.",
          urgency: "high",
          stopProduction: true,
        }),
      );
      crId = cr.id;
      expect(cr.workOrderStatus).toBe("on_hold");
      const op = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/work-orders/${woId}`)).operations[4];
      const blocked = await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${op.id}/pause`, { reason: "x" });
      expect(blocked.body.error.code).toBe("work_order_on_hold");
      const test = await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[2]}/test`, { measurements: good, firmwareVersion: FW, equipmentId: eqOk });
      expect(test.body.error.code).toBe("work_order_on_hold");
      const resume = await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${woId}/resume`, { reason: "devam" });
      expect(resume.body.error.code).toBe("change_request_open");
    });

    it("karar yalnızca yetkili ve talebi açmayan kişiyle; açık iş emirleri için karar zorunlu; BOM değişmez", async () => {
      const tech = await call(w.app, "technician@a.test", A, "POST", `/api/change-requests/${crId}/decide`, { decision: "reject", note: "yok" });
      expect(tech.status).toBe(403);
      const undecided = await call(w.app, "rd@a.test", A, "POST", `/api/change-requests/${crId}/decide`, {
        decision: "approve", decisionType: "permanent_revision", effectivity: "Rev.B ile", note: "Serigrafi düzeltilecek",
      });
      expect(undecided.body.error.code).toBe("open_work_orders_undecided");
      const ok = expectOk(
        await call(w.app, "rd@a.test", A, "POST", `/api/change-requests/${crId}/decide`, {
          decision: "approve", decisionType: "permanent_revision", effectivity: "Rev.B ile", note: "Serigrafi düzeltilecek; mevcut kartlar montajda kontrol",
          openWorkOrders: [{ workOrderId: woId, action: "continue" }],
        }),
      );
      expect(ok.status).toBe("approved");
      expect(ok.workOrderStatus).toBe("in_progress");
      const wo = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/work-orders/${woId}`));
      expect(wo.bomVersionId).toBe(bomV1);
      const tasks = expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/tasks/mine"));
      expect(tasks.some((t: any) => t.title.includes("yeni revizyon"))).toBe(true);
      // Kendi talebine karar verilemez.
      const own = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/change-requests", { productRevisionId: revA, title: "Test", description: "Kendi talebim, karar veremem." }));
      const self = await call(w.app, "rd@a.test", A, "POST", `/api/change-requests/${own.id}/decide`, { decision: "reject", note: "hayır" });
      expect(self.body.error.code).toBe("self_approval");
    });

    it("elle bekletme ve devam: gerekçeli, olay kayıtlı", async () => {
      expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${woId}/hold`, { reason: "Ekipman arızası" }));
      const r = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${woId}/resume`, { reason: "Onarıldı" }));
      expect(r.status).toBe("in_progress");
      const hist = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/history/work_order/${woId}`));
      expect(hist.filter((e: any) => e.eventType === "status.on_hold")).toHaveLength(2);
    });
  });
});

describe("Termin tahmini ve taahhüt (W16)", () => {
  it("takvim: hafta sonu ve tatil atlanır", () => {
    const hol = new Set(["2026-10-29"]);
    expect(nextWorkingDay("2026-10-24", hol)).toBe("2026-10-26"); // Cumartesi → Pazartesi
    expect(finishAfterWorkingDays("2026-10-27", 3, hol)).toBe("2026-10-30"); // Salı, Çarşamba, (Perşembe tatil), Cuma
  });

  let orderId: string;
  it("temin süresi tanımsız eksik kalem varsa termin hesaplanamadı döner", async () => {
    const o = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: addDays(30), lines: [{ productRevisionId: revA, qty: "20" }] }));
    orderId = o.id;
    const est = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${orderId}/estimate`));
    expect(est.status).toBe("unknown");
    expect(est.earliest).toBeNull();
    expect(est.reasons.join(" ")).toContain("CMP-TESTSEMI-MCU-7");
    const promise = await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${orderId}/promise`, { date: addDays(20) });
    expect(promise.body.error.code).toBe("promise_before_estimate");
  });

  it("malzeme temin süresi ve iş merkezi yükü aralık olarak hesaplanır; taahhüt tahminden ayrı kaydedilir", async () => {
    const lt = await call(w.app, "sales@a.test", A, "POST", `/api/items/${items["MCU-7"]}/lead-time`, { days: 14 });
    expect(lt.status).toBe(403);
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/items/${items["MCU-7"]}/lead-time`, { days: 14 }));
    const est = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${orderId}/estimate`));
    expect(est.status).toBe("ok");
    expect(est.materialReadyDate).toBe(addDays(14));
    expect(est.earliest > est.materialReadyDate).toBe(true);
    expect(est.latest >= est.earliest).toBe(true);
    expect(est.workCenters).toHaveLength(6);
    // Açık iş emri (3 adet, beklemede değil) aynı merkezlerde kuyruk oluşturur.
    expect(est.workCenters.some((c: any) => c.queueMinutes > 0)).toBe(true);
    const mcu = est.materials.find((m: any) => m.itemCode === "CMP-TESTSEMI-MCU-7");
    expect(mcu.source).toContain("14");

    const prod = await call(w.app, "production@a.test", A, "POST", `/api/sales-orders/${orderId}/promise`, { date: est.latest });
    expect(prod.status).toBe(403);
    const early = await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${orderId}/promise`, { date: est.materialReadyDate, acceptRisk: true });
    expect(early.body.error.code).toBe("reason_required");
    const risky = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${orderId}/promise`, { date: est.materialReadyDate, acceptRisk: true, note: "Müşteri kısmi teslim kabul etti" }));
    expect(risky.risky).toBe(true);
    const safe = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${orderId}/promise`, { date: est.latest }));
    expect(safe.risky).toBe(false);
    const stored = expectOk(await call(w.app, "sales@a.test", A, "GET", `/api/sales-orders/${orderId}/estimate`));
    expect(stored.promisedDate).toBe(est.latest);
    expect(stored.estimate.latest).toBe(est.latest);
  });

  it("tatil eklenince termin kayar", async () => {
    const before = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${orderId}/estimate`));
    const tech = await call(w.app, "technician@a.test", A, "POST", "/api/holidays", { day: before.earliest, name: "Tatil" });
    expect(tech.status).toBe(403);
    expectOk(await call(w.app, "production@a.test", A, "POST", "/api/holidays", { day: before.earliest, name: "Tatil" }));
    const after = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${orderId}/estimate`));
    expect(after.earliest > before.earliest).toBe(true);
  });
});
