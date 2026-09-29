/**
 * Oturum 5 (W34): müşteri iadesi, garanti ve saha arızası. T17'nin iade kısmı.
 * İade malı otomatik sağlam stoğa girmez; seri → müşteri, sevkiyat, test, iade geçmişi.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let revA: string;
let lotRev: string;
let fgItem: string;
let lotItem: string;
let c1: string;
let c2: string;
let serials: string[] = [];
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
const ALL = { box: true, accessories: true, label: true, inspection: true };
const W = "warehouse@a.test";
const S = "sales@a.test";
const Q = "quality@a.test";

async function releasedProduct(code: string, mpn: string) {
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code, name: code })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: `${code}.csv`, content: `Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;${mpn};1;MCU;`, mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  const rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "rd", decision: "approve" }));
  expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "production", decision: "approve" }));
  expectOk(await call(w.app, Q, A, "POST", `/api/revisions/${rev}/handover`, { area: "quality", decision: "approve" }));
  return { productId, rev };
}

async function importStock(csv: string) {
  const p = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", { fileName: `s${Math.random()}.csv`, content: csv, mapping: stockMapping }));
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${p.jobId}/commit`, {}));
}

async function sellAndShip(customerId: string, rev: string, qty: string, codes: { code: string; qty?: string }[]) {
  const o = expectOk(await call(w.app, S, A, "POST", "/api/sales-orders", { customerId, requestedDate: "2026-12-01", lines: [{ productRevisionId: rev, qty }] }));
  expectOk(await call(w.app, S, A, "POST", `/api/sales-orders/${o.id}/confirm`));
  const sh = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o.id}/shipments`, { lines: [{ lineId: o.lines[0].id, qty }] }));
  for (const c of codes) expectOk(await call(w.app, W, A, "POST", `/api/packages/${sh.packages[0].id}/items`, c));
  expectOk(await call(w.app, W, A, "POST", `/api/packages/${sh.packages[0].id}/close`, { checklist: ALL }));
  expectOk(await call(w.app, W, A, "POST", `/api/shipments/${sh.id}/pack-complete`));
  expectOk(await call(w.app, W, A, "POST", `/api/shipments/${sh.id}/ship`, { carrier: "Test kargo" }));
  return { orderId: o.id as string, shipmentId: sh.id as string };
}

const avail = async (itemId: string) => expectOk(await call(w.app, W, A, "GET", `/api/stock/availability/${itemId}`));
const deviceStatus = async (serial: string | undefined) => expectOk(await call(w.app, Q, A, "GET", `/api/devices/${serial}`)).status;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  revA = (await releasedProduct("SR-1", "MCU-R")).rev;
  const lp = await releasedProduct("LT-1", "MCU-L");
  lotRev = lp.rev;
  c1 = expectOk(await call(w.app, S, A, "POST", "/api/customers", { code: "R1", name: "Müşteri Bir" })).id;
  c2 = expectOk(await call(w.app, S, A, "POST", "/api/customers", { code: "R2", name: "Müşteri İki" })).id;
  for (const c of [c1, c2]) expectOk(await call(w.app, S, A, "POST", `/api/customers/${c}/addresses`, { label: "Merkez", recipient: "Teslim Alan", line1: "Sanayi Cad. 1", city: "İstanbul" }));
  await importStock("kod,miktar,lot,konum,rev\nCMP-TESTSEMI-MCU-R,10,MR-1,STK,\nLT-1,20,LOT-FG,BTM,A");
  lotItem = expectOk(await call(w.app, W, A, "GET", "/api/lots/lookup?code=LOT-FG"))[0].itemId;

  // Serili üretim: 4 cihaz, hepsi testten geçer ve son kaliteden serbest bırakılır (stok için iş emri).
  const wo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: revA, qty: "4" }));
  const rel = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo.id}/release`));
  serials = rel.devices.map((d: any) => d.serial);
  const mr = expectOk(await call(w.app, W, A, "GET", "/api/lots/lookup?code=MR-1"))[0].id;
  expectOk(await call(w.app, W, A, "POST", `/api/work-orders/${wo.id}/issue`, { lotId: mr, qty: "4" }));
  for (const op of rel.operations.slice(0, 5)) {
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/start`));
    if (op.isQualityGate) for (const s of serials) expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/devices/${s}/test`, { result: "pass" }));
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`));
  }
  expectOk(await call(w.app, Q, A, "POST", `/api/work-orders/${wo.id}/release-to-stock`));
  fgItem = expectOk(await call(w.app, W, A, "GET", `/api/lots/lookup?code=${wo.code}`))[0].itemId;
  // 3 cihaz müşteri 1'e sevk edilir; 4. cihaz stokta kalır (değişim için)
  await sellAndShip(c1, revA, "3", serials.slice(0, 3).map((code) => ({ code })));
  // Serisiz lot: 5 adet müşteri 2'ye
  await sellAndShip(c2, lotRev, "5", [{ code: "LOT-FG", qty: "5" }]);
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

let rma1: any;

describe("İade açma", () => {
  it("seri sorgusu müşteriyi, sevkiyatı ve garantiyi bulur; müşteride olmayan cihaza iade açılmaz", async () => {
    const l = expectOk(await call(w.app, S, A, "GET", `/api/rma-lookup?code=${serials[0]}`));
    expect(l.customerId).toBe(c1);
    expect(l.inWarranty).toBe(true);
    expect(l.shipmentCode).toMatch(/^SVK-/);
    const stockDev = await call(w.app, S, A, "POST", "/api/rmas", { code: serials[3], kind: "return", complaint: "Stoktaki cihaz iadesi denemesi" });
    expect(stockDev.body.error.code).toBe("not_shipped");
    const wrong = await call(w.app, S, A, "POST", "/api/rmas", { code: serials[0], customerId: c2, kind: "return", complaint: "Başka müşteri adına iade denemesi" });
    expect(wrong.body.error.code).toBe("wrong_customer");
    const tech = await call(w.app, "technician@a.test", A, "POST", "/api/rmas", { code: serials[0], kind: "warranty", complaint: "Cihaz açılmıyor" });
    expect(tech.status).toBe(403);
  });

  it("garanti iadesi açılır; aynı seri için ikinci açık iade olmaz", async () => {
    rma1 = expectOk(await call(w.app, S, A, "POST", "/api/rmas", { code: serials[0], kind: "warranty", complaint: "Cihaz 2 gün sonra açılmıyor, LED yanmıyor" }, { "idempotency-key": "rma-1" }));
    expect(rma1).toMatchObject({ status: "open", inWarranty: true, customerId: c1, serial: serials[0] });
    const again = expectOk(await call(w.app, S, A, "POST", "/api/rmas", { code: serials[0], kind: "warranty", complaint: "Cihaz 2 gün sonra açılmıyor, LED yanmıyor" }, { "idempotency-key": "rma-1" }));
    expect(again.id).toBe(rma1.id);
    const dup = await call(w.app, S, A, "POST", "/api/rmas", { code: serials[0], kind: "return", complaint: "İkinci iade denemesi" });
    expect(dup.body.error.code).toBe("rma_open");
  });

  it("serisiz lot: müşteri ve miktar zorunlu; sevk edilenden fazla iade açılmaz", async () => {
    expect((await call(w.app, S, A, "POST", "/api/rmas", { code: "LOT-FG", kind: "return", complaint: "Lot iadesi müşterisiz" })).body.error.code).toBe("customer_required");
    expect((await call(w.app, S, A, "POST", "/api/rmas", { code: "LOT-FG", customerId: c1, qty: "1", kind: "return", complaint: "Bu müşteriye sevk yok" })).body.error.code).toBe("over_return");
    expect((await call(w.app, S, A, "POST", "/api/rmas", { code: "LOT-FG", customerId: c2, qty: "6", kind: "return", complaint: "Fazla iade" })).body.error.code).toBe("over_return");
  });
});

describe("Teslim alma, inceleme ve karar", () => {
  it("teslim alınan ürün iade kabul alanına girer; satılabilir stok değişmez", async () => {
    const before = await avail(fgItem);
    const r = expectOk(await call(w.app, W, A, "POST", `/api/rmas/${rma1.id}/receive`, { note: "Kutusu açılmış" }));
    expect(r.status).toBe("received");
    const after = await avail(fgItem);
    expect(after.returns).toBe("1");
    expect(after.usable).toBe(before.usable);
    expect(await deviceStatus(serials[0])).toBe("returned");
    expect((await call(w.app, W, A, "POST", `/api/rmas/${rma1.id}/receive`, {})).body.error.code).toBe("invalid_transition");
  });

  it("inceleme kalite yetkisiyle; tasarım kaynaklı bulguda Ar-Ge'ye değişiklik talebi açılır", async () => {
    expect((await call(w.app, S, A, "POST", `/api/rmas/${rma1.id}/inspect`, { finding: "x".repeat(10), cause: "design" })).status).toBe(403);
    const i = expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${rma1.id}/inspect`, { finding: "Güç girişindeki TVS diyot ters polariteye dayanıksız", cause: "design", openChangeRequest: true }));
    expect(i.status).toBe("inspected");
    expect(i.changeRequestCode).toMatch(/^DT-/);
    const tasks = expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/tasks/mine"));
    expect(tasks.some((t: any) => t.title.includes(i.changeRequestCode))).toBe(true);
  });

  it("stoğa alma yalnızca arıza bulunamadığında; tamir başarısızsa yeniden karar ve değişim", async () => {
    const restock = await call(w.app, Q, A, "POST", `/api/rmas/${rma1.id}/decide`, { disposition: "restock", note: "Stoğa al", retestPassed: true });
    expect(restock.body.error.code).toBe("restock_not_allowed");
    const rep = expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${rma1.id}/decide`, { disposition: "repair", note: "TVS değişimi" }));
    expect(rep.deviceStatus).toBe("in_repair");
    // Tamir edilen ürün testten geçmeden gönderilemez
    expect((await call(w.app, W, A, "POST", `/api/rmas/${rma1.id}/ship-back`, { carrier: "Test kargo" })).body.error.code).toBe("retest_required");
    const failed = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/rmas/${rma1.id}/repair`, { note: "TVS değişti, 3V3 hattı hâlâ kısa devre", retestPassed: false }));
    expect(failed.retestPassed).toBe(false);
    // Değişim: stoktaki serbest seri gider, iade gelen karantinaya
    const notFree = await call(w.app, Q, A, "POST", `/api/rmas/${rma1.id}/decide`, { disposition: "replace", note: "Değişim", replacementCode: serials[1] });
    expect(notFree.body.error.code).toBe("not_released");
    const rep2 = expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${rma1.id}/decide`, { disposition: "replace", note: "Tamir edilemedi, değişim", replacementCode: serials[3], creditNote: false }));
    expect(rep2.replacementSerial).toBe(serials[3]);
    expect(await deviceStatus(serials[0])).toBe("quarantined");
    const a = await avail(fgItem);
    expect(a.returns).toBe("0");
    expect(a.quarantine).toBe("1");
  });

  it("geri gönderim: değişim cihazı stoktan düşer; tekrar istek ikinci hareket oluşturmaz", async () => {
    const before = await avail(fgItem);
    const s1 = expectOk(await call(w.app, W, A, "POST", `/api/rmas/${rma1.id}/ship-back`, { carrier: "Test kargo", trackingNo: "RMA-1" }, { "idempotency-key": "sb-1" }));
    const s2 = expectOk(await call(w.app, W, A, "POST", `/api/rmas/${rma1.id}/ship-back`, { carrier: "Test kargo", trackingNo: "RMA-1" }));
    expect([s1.status, s2.status]).toEqual(["closed", "closed"]);
    expect(s1.outboundAddress.city).toBe("İstanbul");
    const after = await avail(fgItem);
    expect(Number(before.physical) - Number(after.physical)).toBe(1);
    expect(await deviceStatus(serials[3])).toBe("shipped");
  });

  it("arıza bulunamadı + tekrar test geçti → stoğa alınır ve kullanılabilir olur", async () => {
    const r = expectOk(await call(w.app, S, A, "POST", "/api/rmas", { code: serials[1], kind: "return", complaint: "Müşteri yanlış ürün sipariş etmiş" }));
    expectOk(await call(w.app, W, A, "POST", `/api/rmas/${r.id}/receive`, {}));
    expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/inspect`, { finding: "Görsel ve fonksiyon kontrol temiz", cause: "no_fault_found" }));
    expect((await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition: "restock", note: "Stoğa al" })).body.error.code).toBe("retest_required");
    const before = await avail(fgItem);
    const d = expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition: "restock", note: "Tekrar test geçti, stoğa al", retestPassed: true }));
    expect(d.status).toBe("closed");
    expect(await deviceStatus(serials[1])).toBe("released");
    const after = await avail(fgItem);
    expect(Number(after.usable) - Number(before.usable)).toBe(1);
  });

  it("müşteri kaynaklı hasarda alacak belgesi talebi açılamaz; olduğu gibi iade edilir", async () => {
    const r = expectOk(await call(w.app, S, A, "POST", "/api/rmas", { code: serials[2], kind: "return", complaint: "Kutu içinde hasar var" }));
    expectOk(await call(w.app, W, A, "POST", `/api/rmas/${r.id}/receive`, {}));
    expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/inspect`, { finding: "Kutu içinde sıvı teması izi", cause: "customer_damage" }));
    expect((await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition: "return_as_is", note: "Müşteri hasarı", creditNote: true })).body.error.code).toBe("customer_damage");
    expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition: "return_as_is", note: "Garanti dışı kullanım; olduğu gibi iade" }));
    const c = expectOk(await call(w.app, W, A, "POST", `/api/rmas/${r.id}/ship-back`, { carrier: "Test kargo" }));
    expect(c.status).toBe("closed");
    expect(await deviceStatus(serials[2])).toBe("shipped");
    expect((await avail(fgItem)).returns).toBe("0");
  });

  it("serisiz lot iadesi hurdaya ayrılır; garanti içinde alacak belgesi görevi muhasebeye düşer", async () => {
    const r = expectOk(await call(w.app, S, A, "POST", "/api/rmas", { code: "LOT-FG", customerId: c2, qty: "2", kind: "warranty", complaint: "İki adet çalışmıyor" }));
    expectOk(await call(w.app, W, A, "POST", `/api/rmas/${r.id}/receive`, {}));
    expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/inspect`, { finding: "Regülatör hasarlı", cause: "component" }));
    expect((await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition: "repair", note: "Tamir" })).body.error.code).toBe("serial_required");
    const before = await avail(lotItem);
    const d = expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition: "scrap", note: "Tamir ekonomik değil", creditNote: true }));
    expect(d.status).toBe("closed");
    const after = await avail(lotItem);
    expect(Number(before.physical) - Number(after.physical)).toBe(2);
    expect(after.returns).toBe("0");
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    const task = await w.owner.query(`select title from tasks where kind = 'credit_note' and entity_id = $1 and assignee_role = 'accounting' and status = 'open'`, [r.id]);
    expect(task.rowCount).toBe(1);
    // Kalan iade edilebilir miktar 3
    const l = expectOk(await call(w.app, S, A, "GET", `/api/rma-lookup?code=LOT-FG&customerId=${c2}`));
    expect(l.returnableQty).toBe("3");
  });

  it("garanti süresi geçmişse alacak belgesi talebi açılamaz", async () => {
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await w.owner.query(`update shipments set shipped_at = now() - interval '3 years' where status = 'shipped' and id in (select pk.shipment_id from packages pk join package_items pi on pi.package_id = pk.id where pi.device_id is null)`);
    const r = expectOk(await call(w.app, S, A, "POST", "/api/rmas", { code: "LOT-FG", customerId: c2, qty: "1", kind: "warranty", complaint: "Garanti sonrası arıza" }));
    expect(r.inWarranty).toBe(false);
    expectOk(await call(w.app, W, A, "POST", `/api/rmas/${r.id}/receive`, {}));
    expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/inspect`, { finding: "Yaşlanma", cause: "component" }));
    expect((await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition: "scrap", note: "Hurda", creditNote: true })).body.error.code).toBe("out_of_warranty");
    // İptal yalnızca teslim alınmadan
    expect((await call(w.app, S, A, "POST", `/api/rmas/${r.id}/cancel`, { reason: "vazgeçildi" })).body.error.code).toBe("invalid_transition");
  });

  it("cihaz geçmişi: sevkiyat, iade ve değişim ilişkisi görünür", async () => {
    const d0 = expectOk(await call(w.app, Q, A, "GET", `/api/devices/${serials[0]}`));
    expect(d0.shipments).toHaveLength(1);
    expect(d0.shipments[0].customerName).toBe("Müşteri Bir");
    expect(d0.rmas.map((r: any) => r.disposition)).toEqual(["replace"]);
    const d3 = expectOk(await call(w.app, Q, A, "GET", `/api/devices/${serials[3]}`));
    expect(d3.rmas.map((r: any) => r.code)).toEqual([rma1.code]); // değişim olarak gönderildi
    const hist = expectOk(await call(w.app, Q, A, "GET", `/api/history/device/${d0.id}`));
    expect(hist.map((e: any) => e.eventType)).toEqual(expect.arrayContaining(["rma.opened", "rma.inspected", "rma.repair", "rma.repair_failed", "rma.replace"]));
  });
});

describe("İade maliyeti: tamir, hurda ve değişim (oturum 41, kalan işler 7b)", () => {
  const M = "manager@a.test";
  const P = "purchasing@a.test";
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  let repairRma: any;
  const lotOf = async (code: string) => expectOk(await call(w.app, W, A, "GET", `/api/lots/lookup?code=${code}`))[0];

  it("maliyet girdileri: politika, lot maliyetleri (biri USD) ve kur", async () => {
    expectOk(await call(w.app, M, A, "POST", "/api/cost-policies", { validFrom: "2026-01-01", currency: "TRY", laborRatePerHour: "600", overheadPerLaborHour: "100", note: "İade maliyeti testi" }));
    const fg = expectOk(await call(w.app, Q, A, "GET", `/api/devices/${serials[3]}`));
    const fgLot = await lotOf(fg.finishedLotNo);
    expect(fgLot).toBeTruthy();
    expectOk(await call(w.app, P, A, "POST", `/api/lots/${fgLot.id}/cost`, { unitCost: "500", currency: "TRY", source: "manual", reference: "Stok değeri" }));
    expectOk(await call(w.app, P, A, "POST", `/api/lots/${(await lotOf("MR-1")).id}/cost`, { unitCost: "12.5", currency: "TRY", source: "invoice", reference: "FTR-MR" }));
    expectOk(await call(w.app, P, A, "POST", `/api/lots/${(await lotOf("LOT-FG")).id}/cost`, { unitCost: "20", currency: "USD", source: "manual", reference: "İthal lot" }));
    expect((await call(w.app, W, A, "POST", "/api/exchange-rates", { baseCurrency: "USD", quoteCurrency: "TRY", rate: "40", rateDate: today, source: "TCMB" })).status).toBe(403);
    expect((await call(w.app, M, A, "POST", "/api/exchange-rates", { baseCurrency: "USD", quoteCurrency: "USD", rate: "1", rateDate: today, source: "TCMB" })).status).toBe(400);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await call(w.app, M, A, "POST", "/api/exchange-rates", { baseCurrency: "USD", quoteCurrency: "TRY", rate: "40", rateDate: tomorrow, source: "TCMB" })).body.error.code).toBe("future_rate");
  });

  it("kur yoksa veya politikadaki azami yaştan eskiyse dönüştürülmez; eksik olarak görünür", async () => {
    const scrapRma = expectOk(await call(w.app, M, A, "GET", "/api/rmas")).find((r: any) => r.disposition === "scrap");
    let c = expectOk(await call(w.app, M, A, "GET", `/api/rmas/${scrapRma.id}/cost`));
    expect(c.scrap).toMatchObject({ qty: "2", unitCost: "20", cost: null });
    expect(c.gaps.join(" ")).toMatch(/USD→TRY kuru yok/);
    expectOk(await call(w.app, M, A, "POST", "/api/exchange-rates", { baseCurrency: "USD", quoteCurrency: "TRY", rate: "39", rateDate: daysAgo(10), source: "TCMB" }));
    c = expectOk(await call(w.app, M, A, "GET", `/api/rmas/${scrapRma.id}/cost`));
    expect(c.gaps.join(" ")).toMatch(/7 günden eski/);
    // Aynı gün için düzeltme: son girilen geçerli, önceki iz olarak kalır.
    expectOk(await call(w.app, M, A, "POST", "/api/exchange-rates", { baseCurrency: "USD", quoteCurrency: "TRY", rate: "41", rateDate: daysAgo(1), source: "TCMB" }));
    const fix = expectOk(await call(w.app, M, A, "POST", "/api/exchange-rates", { baseCurrency: "USD", quoteCurrency: "TRY", rate: "40", rateDate: daysAgo(1), source: "TCMB", note: "Yanlış girilmişti" }));
    expect(fix.corrected).toBe(true);
    c = expectOk(await call(w.app, M, A, "GET", `/api/rmas/${scrapRma.id}/cost`));
    expect(c.scrap).toMatchObject({ qty: "2", cost: "1600", fx: `1 USD = 40 TRY (${daysAgo(1)}, TCMB)` });
    expect(c.totals.total).toBe("1600");
    expect(c.complete).toBe(true);
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await expect(w.owner.query(`update exchange_rates set rate = 1`)).rejects.toThrow(/append/i);
  });

  it("tamir: işçilik saati × politika ücreti + genel gider + stoktan düşülen parça; her deneme değişmez", async () => {
    repairRma = expectOk(await call(w.app, S, A, "POST", "/api/rmas", { code: serials[2], kind: "warranty", complaint: "Tekrar arıza" }));
    expectOk(await call(w.app, W, A, "POST", `/api/rmas/${repairRma.id}/receive`, {}));
    expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${repairRma.id}/inspect`, { finding: "MCU arızalı", cause: "component" }));
    expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${repairRma.id}/decide`, { disposition: "repair", note: "MCU değişimi" }));
    const mr = await lotOf("MR-1");
    const tooMany = await call(w.app, "technician@a.test", A, "POST", `/api/rmas/${repairRma.id}/repair`, { note: "MCU değişti", retestPassed: true, laborHours: "1.5", parts: [{ itemId: mr.itemId, lotId: mr.id, qty: "100" }] });
    expect(tooMany.body.error.code).toBe("negative_stock");
    const before = await avail(mr.itemId);
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/rmas/${repairRma.id}/repair`, { note: "MCU değişti, test geçti", retestPassed: true, laborHours: "1.5", parts: [{ itemId: mr.itemId, lotId: mr.id, qty: "1" }] }));
    expect(Number(before.physical) - Number((await avail(mr.itemId)).physical)).toBe(1);

    let c = expectOk(await call(w.app, M, A, "GET", `/api/rmas/${repairRma.id}/cost`));
    expect(c.repair.attempts).toHaveLength(1); // reddedilen deneme geri alındı, iz bırakmadı
    expect(c.repair.attempts[0]).toMatchObject({ attemptNo: 1, laborHours: "1.5", labor: "900", overhead: "150", partsCost: "12.5", total: "1062.5", retestPassed: true });
    expect(c.totals).toEqual({ repair: "1062.5", scrap: "0", replacement: "0", total: "1062.5" });
    expect(c.complete).toBe(false); // henüz geri gönderilmedi
    expect(c.gaps.join(" ")).toContain("ara maliyet");
    expectOk(await call(w.app, W, A, "POST", `/api/rmas/${repairRma.id}/ship-back`, { carrier: "Test kargo" }));
    c = expectOk(await call(w.app, M, A, "GET", `/api/rmas/${repairRma.id}/cost`));
    expect(c.complete).toBe(true);
    await expect(w.owner.query(`update rma_repair_attempts set labor_hours = 0`)).rejects.toThrow(/append/i);
    expect((await call(w.app, W, A, "GET", `/api/rmas/${repairRma.id}/cost`)).status).toBe(403);
  });

  it("değişim: giden cihazın lot maliyeti; başarısız ilk tamir denemesi de maliyette", async () => {
    const c = expectOk(await call(w.app, M, A, "GET", `/api/rmas/${rma1.id}/cost`));
    expect(c.repair.attempts).toEqual([expect.objectContaining({ attemptNo: 1, laborHours: "0", total: "0", retestPassed: false })]);
    expect(c.replacement).toMatchObject({ qty: "1", unitCost: "500", cost: "500" });
    expect(c.totals.total).toBe("500");
  });

  it("kâr raporu iade maliyetini brüt kârdan düşmeden ayrı gösterir", async () => {
    const r = expectOk(await call(w.app, M, A, "GET", `/api/reports/margin?from=${today}&to=${today}`));
    expect(r.returns.costs).toEqual([{ currency: "TRY", repair: "1062.5", scrap: "1600", replacement: "500", total: "3162.5" }]);
    expect(r.returns.costIncomplete).toBe(0);
  });
});
