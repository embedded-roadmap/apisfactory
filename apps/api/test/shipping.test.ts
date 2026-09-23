/**
 * Oturum 4 (W23): teslim adresi, sevkiyat hazırlığı, okutmalı paketleme ve kontrol listesi, kısmi sevk,
 * tekrar korumalı sevk, teslim teyidi / sorunu, iptal kuralları. Hazır bitmiş stoktan (serisiz lot) satış yolu.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let revA: string;
let c1: string;
let c2: string;
let fgItem: string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
const ALL = { box: true, accessories: true, label: true, inspection: true };
const W = "warehouse@a.test";
const S = "sales@a.test";

async function importStock(csv: string) {
  const p = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", { fileName: `s${Math.random()}.csv`, content: csv, mapping: stockMapping }));
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${p.jobId}/commit`, {}));
}

async function firmOrder(customerId: string, qty: string) {
  const o = expectOk(await call(w.app, S, A, "POST", "/api/sales-orders", { customerId, requestedDate: "2026-12-01", lines: [{ productRevisionId: revA, qty }] }));
  const r = expectOk(await call(w.app, S, A, "POST", `/api/sales-orders/${o.id}/confirm`));
  return { id: o.id as string, lineId: o.lines[0].id as string, reserved: r.lines[0].reservedQty as string };
}

async function physical(): Promise<string> {
  return expectOk(await call(w.app, W, A, "GET", `/api/stock/availability/${fgItem}`)).physical;
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "KT-1", name: "Kontrol kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "kt.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;MCU-K;1;MCU;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "rd", decision: "approve" }));
  expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "production", decision: "approve" }));
  expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "quality", decision: "approve" }));
  c1 = expectOk(await call(w.app, S, A, "POST", "/api/customers", { code: "M1", name: "Müşteri Bir" })).id;
  c2 = expectOk(await call(w.app, S, A, "POST", "/api/customers", { code: "M2", name: "Müşteri İki" })).id;
  // Hazır bitmiş stok (serisiz lot) — bitmiş ürün deposunda
  await importStock("kod,miktar,lot,konum,rev\nKT-1,10,FG-1,BTM,A");
  fgItem = expectOk(await call(w.app, W, A, "GET", "/api/lots/lookup?code=FG-1"))[0].itemId;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

let addr1: string;
let addr1b: string;
let addr2: string;
let o1: Awaited<ReturnType<typeof firmOrder>>;
let o2: Awaited<ReturnType<typeof firmOrder>>;
let s1: any;

describe("Teslim adresi", () => {
  it("satış adres ekler; ilk adres varsayılan olur; depo adres ekleyemez", async () => {
    const wh = await call(w.app, W, A, "POST", `/api/customers/${c1}/addresses`, { label: "X", recipient: "X Y", line1: "Adres 1", city: "İstanbul" });
    expect(wh.status).toBe(403);
    const a = expectOk(await call(w.app, S, A, "POST", `/api/customers/${c1}/addresses`, { label: "Merkez", recipient: "Ali Veli", line1: "Sanayi Cad. No:1", district: "Pendik", city: "İstanbul", phone: "0216 000 00 00" }));
    addr1 = a.id;
    expect(a.isDefault).toBe(true);
    const b = expectOk(await call(w.app, S, A, "POST", `/api/customers/${c1}/addresses`, { label: "Şube", recipient: "Ayşe Kaya", line1: "OSB 3. Cad. No:7", city: "Kocaeli", isDefault: true }));
    addr1b = b.id;
    const list = expectOk(await call(w.app, W, A, "GET", `/api/customers/${c1}/addresses`));
    expect(list.filter((x: any) => x.isDefault).map((x: any) => x.id)).toEqual([addr1b]);
    addr2 = expectOk(await call(w.app, S, A, "POST", `/api/customers/${c2}/addresses`, { label: "Depo", recipient: "Can Er", line1: "Liman Yolu 9", city: "İzmir" })).id;
  });
});

describe("Sevkiyat hazırlığı ve paketleme", () => {
  it("hazır bitmiş stoktan kesin sipariş satıra ayrılır", async () => {
    o1 = await firmOrder(c1, "6");
    expect(o1.reserved).toBe("6");
    o2 = await firmOrder(c2, "3");
    expect(o2.reserved).toBe("3");
    // Kimseye ayrılmamış ikinci lot
    await importStock("kod,miktar,lot,konum,rev\nKT-1,2,FG-2,BTM,A");
  });

  it("kısmi teslim kapalıyken eksik sevkiyat reddedilir; başka müşterinin adresi seçilemez", async () => {
    expectOk(await call(w.app, S, A, "POST", `/api/sales-orders/${o1.id}/delivery`, { allowPartial: false, addressId: addr1 }));
    const partial = await call(w.app, W, A, "POST", `/api/sales-orders/${o1.id}/shipments`, { lines: [{ lineId: o1.lineId, qty: "4" }] });
    expect(partial.body.error.code).toBe("partial_not_allowed");
    expectOk(await call(w.app, S, A, "POST", `/api/sales-orders/${o1.id}/delivery`, { allowPartial: true }));
    const wrong = await call(w.app, W, A, "POST", `/api/sales-orders/${o1.id}/shipments`, { addressId: addr2, lines: [{ lineId: o1.lineId, qty: "4" }] });
    expect(wrong.body.error.code).toBe("wrong_address");
    const over = await call(w.app, W, A, "POST", `/api/sales-orders/${o1.id}/shipments`, { lines: [{ lineId: o1.lineId, qty: "7" }] });
    expect(over.body.error.code).toBe("not_releasable");
  });

  it("okutma: yanlış kod, başka siparişe ayrılmamış lot ve fazla miktar reddedilir, olay kaydı kalır", async () => {
    s1 = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o1.id}/shipments`, { lines: [{ lineId: o1.lineId, qty: "4" }] }, { "idempotency-key": "s1" }));
    expect(s1.status).toBe("preparing");
    expect(s1.address.id).toBe(addr1); // siparişin teslim adresi
    const pkg = s1.packages[0].id;
    // İkinci sevkiyat aynı miktarı tekrar ayıramaz
    const dbl = await call(w.app, W, A, "POST", `/api/sales-orders/${o1.id}/shipments`, { lines: [{ lineId: o1.lineId, qty: "3" }] });
    expect(dbl.body.error.code).toBe("not_releasable");
    const unknown = await call(w.app, W, A, "POST", `/api/packages/${pkg}/items`, { code: "YOK-123" });
    expect(unknown.body.error.code).toBe("unknown_code");
    const other = await call(w.app, W, A, "POST", `/api/packages/${pkg}/items`, { code: "FG-2", qty: "1" });
    expect(other.body.error.code).toBe("not_reserved_for_order");
    const noQty = await call(w.app, W, A, "POST", `/api/packages/${pkg}/items`, { code: "FG-1" });
    expect(noQty.body.error.code).toBe("qty_required");
    const tooMuch = await call(w.app, W, A, "POST", `/api/packages/${pkg}/items`, { code: "FG-1", qty: "5" });
    expect(tooMuch.body.error.code).toBe("over_pack");
    const hist = expectOk(await call(w.app, W, A, "GET", `/api/history/shipment/${s1.id}`));
    expect(hist.map((e: any) => e.eventType)).toEqual(expect.arrayContaining(["pack.rejected.unknown_code", "pack.rejected.not_reserved_for_order", "pack.rejected.over_pack"]));
  });

  it("paket kontrol listesi tamamlanmadan paket kapanmaz; paketlenmeden sevk edilmez", async () => {
    const pkg = s1.packages[0].id;
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg}/items`, { code: "FG-1", qty: "3" }));
    const p2 = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${s1.id}/packages`));
    const pkg2 = p2.packages[1].id;
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg2}/items`, { code: "FG-1", qty: "1" }));
    const shipEarly = await call(w.app, W, A, "POST", `/api/shipments/${s1.id}/ship`, { carrier: "Test kargo" });
    expect(shipEarly.body.error.code).toBe("invalid_transition");
    const notClosed = await call(w.app, W, A, "POST", `/api/shipments/${s1.id}/pack-complete`);
    expect(notClosed.body.error.code).toBe("packages_open");
    const bad = await call(w.app, W, A, "POST", `/api/packages/${pkg}/close`, { checklist: { ...ALL, label: false } });
    expect(bad.body.error.code).toBe("checklist_incomplete");
    expect(bad.body.error.details.missing).toEqual(["label"]);
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg}/close`, { checklist: ALL, weightKg: 2.4 }));
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg2}/close`, { checklist: ALL }));
    const closedAdd = await call(w.app, W, A, "POST", `/api/packages/${pkg}/items`, { code: "FG-1", qty: "1" });
    expect(closedAdd.body.error.code).toBe("package_closed");
    const packed = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${s1.id}/pack-complete`));
    expect(packed.status).toBe("packed");
    // Açık sevkiyatın adresi pasife alınamaz
    const inUse = await call(w.app, S, A, "POST", `/api/addresses/${addr1}/deactivate`);
    expect(inUse.body.error.code).toBe("address_in_use");
  });

  it("sevk: tekrar gelen istek ikinci stok hareketi oluşturmaz; kısmi sevkte sipariş açık kalır", async () => {
    const before = await physical();
    expect(before).toBe("12");
    const a = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${s1.id}/ship`, { carrier: "Test kargo", trackingNo: "TK-1" }, { "idempotency-key": "ship-s1" }));
    const b = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${s1.id}/ship`, { carrier: "Test kargo", trackingNo: "TK-1" }, { "idempotency-key": "ship-s1" }));
    const c = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${s1.id}/ship`, { carrier: "Test kargo" }));
    expect([a.status, b.status, c.status]).toEqual(["shipped", "shipped", "shipped"]);
    expect(a.documentMode).toBe("draft");
    expect(await physical()).toBe("8");
    const st = expectOk(await call(w.app, S, A, "GET", `/api/sales-orders/${o1.id}/shippable`));
    expect(st.status).toBe("firm");
    expect(st.lines[0]).toMatchObject({ shipped: "4", remaining: "2", shippableNow: "2" });
    // Sevk edilmiş sevkiyat iptal edilemez; sevkiyatı olan sipariş iptal edilemez
    expect((await call(w.app, W, A, "POST", `/api/shipments/${s1.id}/cancel`, { reason: "deneme" })).body.error.code).toBe("invalid_transition");
    expect((await call(w.app, S, A, "POST", `/api/sales-orders/${o1.id}/cancel`, { reason: "deneme" })).body.error.code).toBe("already_shipped");
  });

  it("adres sonradan pasife alınsa da sevk edilmiş belgenin adresi değişmez", async () => {
    expectOk(await call(w.app, S, A, "POST", `/api/addresses/${addr1}/deactivate`));
    const s = expectOk(await call(w.app, S, A, "GET", `/api/shipments/${s1.id}`));
    expect(s.address.line1).toBe("Sanayi Cad. No:1");
    expect(s.address.active).toBe(true); // sevk anındaki kopya
    const again = await call(w.app, W, A, "POST", `/api/sales-orders/${o1.id}/shipments`, { addressId: addr1, lines: [{ lineId: o1.lineId, qty: "2" }] });
    expect(again.body.error.code).toBe("address_inactive");
  });

  it("eksik paketlenen sevkiyat tamamlanamaz; iptal edilince kalan yeniden sevk edilir ve sipariş kapanır", async () => {
    const s2 = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o1.id}/shipments`, { addressId: addr1b, lines: [{ lineId: o1.lineId, qty: "2" }] }));
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${s2.packages[0].id}/items`, { code: "FG-1", qty: "1" }));
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${s2.packages[0].id}/close`, { checklist: ALL }));
    const short = await call(w.app, W, A, "POST", `/api/shipments/${s2.id}/pack-complete`);
    expect(short.body.error.code).toBe("not_fully_packed");
    const cancelled = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${s2.id}/cancel`, { reason: "Kutu hasarlı, yeniden hazırlanacak" }));
    expect(cancelled.status).toBe("cancelled");
    const s3 = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o1.id}/shipments`, { addressId: addr1b, lines: [{ lineId: o1.lineId, qty: "2" }] }));
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${s3.packages[0].id}/items`, { code: "FG-1", qty: "2" }));
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${s3.packages[0].id}/close`, { checklist: ALL }));
    expectOk(await call(w.app, W, A, "POST", `/api/shipments/${s3.id}/pack-complete`));
    expectOk(await call(w.app, W, A, "POST", `/api/shipments/${s3.id}/ship`, { carrier: "Test kargo" }));
    const st = expectOk(await call(w.app, S, A, "GET", `/api/sales-orders/${o1.id}/shippable`));
    expect(st.status).toBe("shipped");
    expect(await physical()).toBe("6");

    // Teslim sorunu ve teyidi
    expect((await call(w.app, "technician@a.test", A, "POST", `/api/shipments/${s3.id}/delivery`, { outcome: "delivered" })).status).toBe(403);
    expectOk(await call(w.app, W, A, "POST", `/api/shipments/${s3.id}/tracking`, { trackingNo: "TK-3" }));
    const prob = expectOk(await call(w.app, S, A, "POST", `/api/shipments/${s3.id}/delivery`, { outcome: "problem", kind: "damage", note: "Bir kutu ezik teslim edildi" }));
    expect(prob.status).toBe("problem");
    const del = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${s3.id}/delivery`, { outcome: "delivered", note: "Müşteri tutanakla teslim aldı" }));
    expect(del.status).toBe("delivered");
    expect(del.trackingNo).toBe("TK-3");
  });

  it("açık sevkiyatı olan sipariş iptal edilemez", async () => {
    const s = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o2.id}/shipments`, { lines: [{ lineId: o2.lineId, qty: "3" }] }));
    expect(s.address.id).toBe(addr2); // müşterinin varsayılan adresi
    const c = await call(w.app, S, A, "POST", `/api/sales-orders/${o2.id}/cancel`, { reason: "Müşteri vazgeçti" });
    expect(c.body.error.code).toBe("open_shipment");
    const list = expectOk(await call(w.app, W, A, "GET", "/api/shipments?status=preparing"));
    expect(list.map((x: any) => x.id)).toContain(s.id);
  });
});
