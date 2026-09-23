/**
 * Üretim, son kalite, sevkiyat, iptal ve kullanıcı yönetimi senaryoları.
 * Kod eşlemesi: T06, T09, T10, T12 (yanlış parça), karantina malı üretimde kullanılamaz, sipariş iptali, yetki değişikliği.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, login, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let productId: string;
let revA: string;
let bomV1: string;
let customerId: string;
const items: Record<string, string> = {};
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };

async function importBom(content: string, fileName: string) {
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName, content, mapping }));
  const c = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {}));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${c.bomVersionId}/publish`));
  return c.bomVersionId as string;
}

async function releaseRevision(rev: string) {
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "rd", decision: "approve" }));
  expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "production", decision: "approve" }));
  expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "quality", decision: "approve" }));
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "GW-1", name: "Gateway" })).id;
  bomV1 = await importBom(
    ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;TestSemi;MCU-1;1;MCU;", "C1,C2;TestPassive;CAP-1;2;Kondansatör;"].join("\n"),
    "gw_v1.csv",
  );
  const bom = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bomV1}`));
  for (const l of bom.lines) items[l.mpn] = l.itemId;
  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bomV1 })).id;
  await releaseRevision(revA);
  customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "C1", name: "Müşteri" })).id;
  const csv = "kod,miktar,lot,konum,rev\nCMP-TESTSEMI-MCU-1,100,MCU-A,STK,\nCMP-TESTPASSIVE-CAP-1,200,CAP-A,STK,\nCMP-TESTSEMI-MCU-1,50,MCU-Q,KRN,";
  const prev = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: csv, mapping: stockMapping }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {}));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

async function lotId(lotNo: string): Promise<string> {
  const r = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/lots/lookup?code=${lotNo}`));
  return r[0].id;
}

describe("Satıştan üretime, son kaliteye ve sevkiyata", () => {
  let orderId: string;
  let lineId: string;
  let woId: string;
  let wo: any;

  it("kesin siparişin üretim ihtiyacından iş emri açılır ve BOM sürümü sabitlenir", async () => {
    const o = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: "2026-12-01", lines: [{ productRevisionId: revA, qty: "3" }] }));
    orderId = o.id;
    lineId = o.lines[0].id;
    const res = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${orderId}/confirm`));
    expect(res.lines[0].productionNeedQty).toBe("3");
    const needs = expectOk(await call(w.app, "production@a.test", A, "GET", "/api/production-needs"));
    const need = needs.find((n: any) => n.salesOrderCode === o.code);
    const tech = await call(w.app, "technician@a.test", A, "POST", "/api/work-orders", { productionNeedId: need.id });
    expect(tech.status).toBe(403);
    wo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productionNeedId: need.id }));
    woId = wo.id;
    expect(wo.bomVersionId).toBe(bomV1);
    expect(wo.operations).toHaveLength(6);
    wo = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${woId}/release`));
    expect(wo.devices).toHaveLength(3);
  });

  it("T06: yeni revizyon yayımlansa da açık iş emrinin BOM'u değişmez", async () => {
    const v2 = await importBom(
      ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;TestSemi;MCU-1;1;MCU;", "C1,C2;TestPassive;CAP-1;2;Kondansatör;", "U9;TestSemi;NEW-9;1;Yeni;"].join("\n"),
      "gw_v2.csv",
    );
    const revB = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "B", bomVersionId: v2 })).id;
    await releaseRevision(revB);
    const after = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/work-orders/${woId}`));
    expect(after.bomVersionId).toBe(bomV1);
    expect(after.materials.map((m: any) => m.itemCode).sort()).toEqual(["CMP-TESTPASSIVE-CAP-1", "CMP-TESTSEMI-MCU-1"]);
  });

  it("malzeme çıkışı: karantina lotu ve yanlış parça engellenir, fazla çıkış yapılamaz (T12)", async () => {
    const quarantine = await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("MCU-Q"), qty: "3" });
    expect(quarantine.status).toBe(409);
    expect(quarantine.body.error.code).toBe("lot_not_usable");
    // Yanlış parça: sabitlenmiş BOM'da olmayan kalem
    const csv = "kod,miktar,lot,konum,rev\nCMP-TESTSEMI-NEW-9,10,NEW-A,STK,";
    const prev = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "n.csv", content: csv, mapping: stockMapping }));
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {}));
    const wrong = await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("NEW-A"), qty: "1" });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("wrong_part");
    const over = await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("MCU-A"), qty: "4" });
    expect(over.body.error.code).toBe("over_issue");
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("MCU-A"), qty: "3" }, { "idempotency-key": "iss-1" }));
    // Aynı istek tekrar gelirse ikinci çıkış olmaz
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("MCU-A"), qty: "3" }, { "idempotency-key": "iss-1" }));
    const now = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/work-orders/${woId}`));
    expect(now.materials.find((m: any) => m.itemCode === "CMP-TESTSEMI-MCU-1").issued).toBe("3");
  });

  it("sıra atlanamaz; malzeme tamamlanmadan hazırlık kapanmaz", async () => {
    const ops = wo.operations;
    const skip = await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${ops[1].id}/start`);
    expect(skip.body.error.code).toBe("sequence");
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${ops[0].id}/start`));
    const early = await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${ops[0].id}/complete`);
    expect(early.body.error.code).toBe("materials_incomplete");
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${woId}/issue`, { lotId: await lotId("CAP-A"), qty: "6" }));
    const noReason = await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${ops[0].id}/pause`, {});
    expect(noReason.body.error.code).toBe("reason_required");
    for (const op of ops.slice(0, 4)) {
      if (op.seq !== 10) expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${op.id}/start`));
      expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${op.id}/complete`));
    }
  });

  it("T09 ve T10: ilk test başarısızlığı korunur, FPY yükselmez; son kaliteden geçmeyen sevk edilemez", async () => {
    const ops = wo.operations;
    const serials: string[] = wo.devices.map((d: any) => d.serial);
    const testOp = ops.find((o: any) => o.isQualityGate);
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${testOp.id}/start`));

    const m = (v: number) => [{ name: "3V3", value: v, unit: "V", low: 3.2, high: 3.4 }];
    const lying = await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { result: "pass", measurements: m(2.9) });
    expect(lying.body.error.code).toBe("measurement_out_of_limit");
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { result: "fail", measurements: m(2.9), externalRunId: "st1-001" }));
    // İstasyonun tekrar gönderdiği aynı çalışma ikinci kayıt oluşturmaz
    const dup = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { result: "fail", measurements: m(2.9), externalRunId: "st1-001" }));
    expect(dup.duplicate).toBe(true);
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[1]}/test`, { result: "pass", measurements: m(3.3) }));
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[2]}/test`, { result: "fail", measurements: m(3.6) }));

    // Kalite kapısı açık cihaz varken kapanmaz
    const gate = await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${testOp.id}/complete`);
    expect(gate.body.error.code).toBe("quality_gate");
    const techDecides = await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/disposition`, { decision: "rework", note: "C1 soğuk lehim" });
    expect(techDecides.status).toBe(403);
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/devices/${serials[0]}/disposition`, { decision: "rework", note: "C1 soğuk lehim" }));
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/devices/${serials[2]}/disposition`, { decision: "scrap", note: "Regülatör hasarlı" }));
    const retest = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/devices/${serials[0]}/test`, { result: "pass", measurements: m(3.31) }));
    expect(retest.runNo).toBe(2);

    const st = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/work-orders/${woId}`)).stats;
    expect(st.first_tested).toBe(3);
    expect(st.first_passed).toBe(1);
    expect(st.firstPassYield).toBeCloseTo(1 / 3, 3);
    expect(st.passed).toBe(2);
    expect(st.scrapped).toBe(1);

    // T10: serbest bırakılmadan sevkiyat yapılamaz
    const noAddr = await call(w.app, "warehouse@a.test", A, "POST", `/api/sales-orders/${orderId}/shipments`, { lines: [{ lineId, qty: "1" }] });
    expect(noAddr.body.error.code).toBe("address_required");
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/customers/${customerId}/addresses`, { label: "Merkez", recipient: "Depo sorumlusu", line1: "Organize Sanayi 1. Cad. No:5", city: "Kocaeli" }));
    const early = await call(w.app, "warehouse@a.test", A, "POST", `/api/sales-orders/${orderId}/shipments`, { lines: [{ lineId, qty: "1" }] });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("not_releasable");
    const tooEarlyRelease = await call(w.app, "quality@a.test", A, "POST", `/api/work-orders/${woId}/release-to-stock`);
    expect(tooEarlyRelease.body.error.code).toBe("quality_gate");

    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${testOp.id}/complete`));
    const released = expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/work-orders/${woId}/release-to-stock`));
    expect(released.stats.released).toBe(2);

    // Serbest bırakılan 2 adet satıra ayrıldı; 3 istenirse reddedilir, 2 sevk edilir
    const tooMany = await call(w.app, "warehouse@a.test", A, "POST", `/api/sales-orders/${orderId}/shipments`, { lines: [{ lineId, qty: "3" }] });
    expect(tooMany.body.error.code).toBe("not_releasable");
    const sh = expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/sales-orders/${orderId}/shipments`, { lines: [{ lineId, qty: "2" }] }, { "idempotency-key": "ship-1" }));
    const again = expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/sales-orders/${orderId}/shipments`, { lines: [{ lineId, qty: "2" }] }, { "idempotency-key": "ship-1" }));
    expect(again.code).toBe(sh.code);
    // Hurdaya ayrılan cihaz pakete giremez
    const scrap = await call(w.app, "warehouse@a.test", A, "POST", `/api/packages/${sh.packages[0].id}/items`, { code: serials[2] });
    expect(scrap.body.error.code).toBe("not_released");
    for (const sn of [serials[0], serials[1]]) expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/packages/${sh.packages[0].id}/items`, { code: sn }));
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/packages/${sh.packages[0].id}/close`, { checklist: { box: true, accessories: true, label: true, inspection: true } }));
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/shipments/${sh.id}/pack-complete`));
    const shipped = expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/shipments/${sh.id}/ship`, { carrier: "Test kargo" }));
    expect(shipped.status).toBe("shipped");
    expect(shipped.documentMode).toBe("draft");
    const list = expectOk(await call(w.app, "sales@a.test", A, "GET", `/api/sales-orders/${orderId}/shipments`));
    expect(list).toHaveLength(1);
  });

  it("iş emri kapanışı: operasyonlar ve cihazlar uzlaşmadan kapanmaz; kapanışta malzeme tüketilir", async () => {
    const early = await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${woId}/complete`);
    expect(early.body.error.code).toBe("operations_open");
    const last = wo.operations[5];
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${last.id}/start`));
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${woId}/operations/${last.id}/complete`));
    const done = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${woId}/complete`));
    expect(done.status).toBe("completed");
    const mcu = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/stock/availability/${items["MCU-1"]}`));
    // 100 stok + 50 karantina − 3 tüketildi
    expect(mcu.physical).toBe("147");
    expect(mcu.quarantine).toBe("50");
    // Cihaz geçmişi: seri → BOM sürümü, gerçek lotlar, testler
    const dev = expectOk(await call(w.app, "quality@a.test", A, "GET", `/api/devices/${wo.devices[0].serial}`));
    expect(dev.status).toBe("shipped");
    expect(dev.testRuns.map((t: any) => t.result)).toEqual(["fail", "pass"]);
    expect(dev.materialLots.map((l: any) => l.lotNo).sort()).toEqual(["CAP-A", "MCU-A"]);
  });
});

describe("Rezerve malzeme", () => {
  it("başka işe ayrılmış malzeme stok için açılan iş emrine çıkılamaz", async () => {
    const o = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: "2026-12-01", lines: [{ productRevisionId: revA, qty: "60" }] }));
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o.id}/confirm`));
    // MCU-A kullanılabilir 97; 60'ı siparişe ayrıldı → serbest 37
    const stockWo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: revA, qty: "40" }));
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${stockWo.id}/release`));
    const blocked = await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${stockWo.id}/issue`, { lotId: await lotId("MCU-A"), qty: "40" });
    expect(blocked.body.error.code).toBe("reserved_for_other");
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/work-orders/${stockWo.id}/issue`, { lotId: await lotId("MCU-A"), qty: "37" }));
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o.id}/cancel`, { reason: "Test temizliği" }));
  });
});

describe("Sipariş iptali", () => {
  it("iptal rezervasyonu bırakır, başlamamış ihtiyacı ve açık talebi iptal eder; fiziksel hareket silinmez", async () => {
    const o = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: "2026-12-01", lines: [{ productRevisionId: revA, qty: "500" }] }));
    const res = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o.id}/confirm`));
    const pr = res.lines[0].materials.find((m: any) => m.purchaseRequestId);
    expect(pr).toBeTruthy();
    const before = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/stock/availability/${items["CAP-1"]}`));
    expect(Number(before.reserved)).toBeGreaterThan(0);
    const noReason = await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o.id}/cancel`, {});
    expect(noReason.status).toBe(400);
    const c = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o.id}/cancel`, { reason: "Müşteri vazgeçti" }));
    expect(c.impact.cancelledNeeds).toBe(1);
    expect(c.impact.cancelledPurchaseRequests).toBeGreaterThan(0);
    const after = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/stock/availability/${items["CAP-1"]}`));
    expect(after.reserved).toBe("0");
    expect(after.physical).toBe(before.physical);
    const prs = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchase-requests"));
    expect(prs.find((p: any) => p.id === pr.purchaseRequestId).status).toBe("cancelled");
  });
});

describe("Kullanıcı ve rol yönetimi", () => {
  it("yönetici kullanıcı davet eder; kimse kendi rolünü değiştiremez; askıya alınan kullanıcı erişemez", async () => {
    const created = expectOk(await call(w.app, "admin@a.test", A, "POST", "/api/admin/users", { email: "yeni@a.test", name: "Yeni Teknisyen", roles: ["technician"] }));
    expect(created.temporaryPassword).toBeTruthy();
    const r = await w.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "yeni@a.test", password: created.temporaryPassword } });
    expect(r.statusCode).toBe(200);
    const users = expectOk(await call(w.app, "admin@a.test", A, "GET", "/api/admin/users"));
    const self = users.find((u: any) => u.email === "admin@a.test");
    const escalate = await call(w.app, "admin@a.test", A, "POST", `/api/admin/users/${self.membershipId}/roles`, { roles: ["admin", "manager", "sales"] });
    expect(escalate.body.error.code).toBe("self_change");
    const notAdmin = await call(w.app, "manager@a.test", A, "GET", "/api/admin/users");
    expect(notAdmin.status).toBe(403);
    expectOk(await call(w.app, "admin@a.test", A, "POST", `/api/admin/users/${created.membershipId}/status`, { status: "suspended", reason: "Görev değişikliği" }));
    const token = r.json().token;
    const blocked = await w.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}`, "x-company-id": A } });
    expect(blocked.statusCode).toBe(403);
    const hist = expectOk(await call(w.app, "admin@a.test", A, "GET", `/api/events?entityType=membership`));
    expect(hist.map((e: any) => e.eventType)).toEqual(expect.arrayContaining(["created", "status.suspended"]));
  });

  it("parola değişikliği diğer oturumları sonlandırır", async () => {
    await login(w.app, "sales@a.test");
    const other = await w.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "sales@a.test", password: "test-password-1" } });
    const otherToken = other.json().token;
    const mine = await w.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "sales@a.test", password: "test-password-1" } });
    const myToken = mine.json().token;
    const ch = await w.app.inject({ method: "POST", url: "/api/auth/password", headers: { authorization: `Bearer ${myToken}` }, payload: { current: "test-password-1", next: "yeni-parola-12345" } });
    expect(ch.statusCode).toBe(200);
    const o = await w.app.inject({ method: "GET", url: "/api/companies", headers: { authorization: `Bearer ${otherToken}` } });
    expect(o.statusCode).toBe(401);
    const m = await w.app.inject({ method: "GET", url: "/api/companies", headers: { authorization: `Bearer ${myToken}` } });
    expect(m.statusCode).toBe(200);
  });
});
