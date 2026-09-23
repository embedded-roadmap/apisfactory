/**
 * Oturum 18 (W36): e-fatura/e-arşiv ve kargo bağlayıcıları — yalnız TEST modu, gerçek entegrasyon yok.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let revA: string;
let customerId: string;
let shipmentId: string;
let invoiceId: string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
const ALL = { box: true, accessories: true, label: true, inspection: true };
const W = "warehouse@a.test";
const S = "sales@a.test";
const M = "accounting@a.test";

async function connectorId(url: string, key: string): Promise<string> {
  return expectOk(await call(w.app, "manager@a.test", A, "GET", url)).find((c: any) => c.key === key).id;
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "DS-1", name: "Dispatch kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "ds.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;MCU-D;1;MCU;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revA}/handover`, { area, decision: "approve" }));
  }
  customerId = expectOk(await call(w.app, S, A, "POST", "/api/customers", { code: "M-DS", name: "Dispatch Müşterisi" })).id;
  await call(w.app, S, A, "POST", `/api/customers/${customerId}/addresses`, { label: "Merkez", recipient: "Test Alıcı", line1: "Test Cad. No:1", city: "İstanbul", isDefault: true });
  const stock = "kod,miktar,lot,konum,rev\nDS-1,5,DS-LOT,BTM,A";
  const sp = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: stock, mapping: stockMapping }));
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  const o = expectOk(await call(w.app, S, A, "POST", "/api/sales-orders", { customerId, requestedDate: "2026-12-01", lines: [{ productRevisionId: revA, qty: "2", unitPrice: "100", currency: "TRY" }] }));
  expectOk(await call(w.app, S, A, "POST", `/api/sales-orders/${o.id}/confirm`));
  const sh = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o.id}/shipments`, { lines: [{ lineId: o.lines[0].id, qty: "2" }] }));
  shipmentId = sh.id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("E-fatura/e-arşiv ve kargo bağlayıcıları (W36)", () => {
  it("bağlayıcı listeleri BAĞLANMADI ile gelir; yetkisiz mod değiştiremez, gerekçe ister", async () => {
    const e = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/einvoice-connectors"));
    expect(e.map((c: any) => c.key).sort()).toEqual(["foriba", "gib_portal", "logo", "nesbilgi", "parasut", "uyumsoft"]);
    expect(e.every((c: any) => c.mode === "not_connected")).toBe(true);
    const c = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/cargo-connectors"));
    expect(c.map((x: any) => x.key).sort()).toEqual(["aras", "mng", "ptt", "surat", "ups", "yurtici"]);
    const denied = await call(w.app, W, A, "POST", `/api/einvoice-connectors/${e[0].id}`, { mode: "test", reason: "deneme" });
    expect(denied.status).toBe(403);
    const noReason = await call(w.app, M, A, "POST", `/api/einvoice-connectors/${e[0].id}`, { mode: "test" });
    expect(noReason.status).toBe(400);
  });

  it("kargo etiketi paketlenmeden önce/sonra üretilir, bağlı değilse reddedilir, aynı sevkiyata iki kez üretilmez", async () => {
    const cid = await connectorId("/api/cargo-connectors", "yurtici");
    const notReady = await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/cargo-label`, { connectorId: cid });
    expect(notReady.body.error.code).toBe("connector_not_ready");
    const denied = await call(w.app, M, A, "POST", `/api/cargo-connectors/${cid}`, { mode: "test", reason: "Test kataloğu ile deneme" });
    expect(denied.status).toBe(403);
    expectOk(await call(w.app, W, A, "POST", `/api/cargo-connectors/${cid}`, { mode: "test", reason: "Test kataloğu ile deneme" }));
    const label = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/cargo-label`, { connectorId: cid }));
    expect(label).toMatchObject({ carrier: "Yurtiçi Kargo", testData: true });
    expect(label.trackingNo).toMatch(/^YK\d{9}$/);
    const again = await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/cargo-label`, { connectorId: cid });
    expect(again.body.error.code).toBe("already_labeled");
    const full = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${shipmentId}`));
    const sh = expectOk(await call(w.app, W, A, "GET", `/api/sales-orders/${full.salesOrderId}/shipments`));
    expect(sh.find((x: any) => x.id === shipmentId).trackingNo).toBe(label.trackingNo);
  });

  it("etiketli sevkiyat taşıyıcı girilmeden sevk edilebilir (etiketten alınır)", async () => {
    const pkgs = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${shipmentId}`));
    const pkg = pkgs.packages[0].id;
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg}/items`, { code: "DS-LOT", qty: "2" }));
    expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg}/close`, { checklist: ALL }));
    expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/pack-complete`));
    const shipped = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/ship`, {}));
    expect(shipped.status).toBe("shipped");
    expect(shipped.carrier).toBe("Yurtiçi Kargo");
    expect(shipped.labelRef).toMatch(/^YURTICI-/);
  });

  it("kesilmiş fatura için sentetik e-belge: bağlı değilse reddedilir, gönderilince belge modu test olur, ikinci kez gönderilemez", async () => {
    const inv = expectOk(await call(w.app, M, A, "POST", "/api/customer-invoices/from-shipment", { shipmentId }));
    invoiceId = inv.id;
    const issued = expectOk(await call(w.app, M, A, "POST", `/api/customer-invoices/${invoiceId}/issue`, {}));
    expect(issued.status).toBe("issued");
    const cid = await connectorId("/api/einvoice-connectors", "uyumsoft");
    const notReady = await call(w.app, M, A, "POST", `/api/customer-invoices/${invoiceId}/send-einvoice`, { connectorId: cid, kind: "e_fatura" });
    expect(notReady.body.error.code).toBe("connector_not_ready");
    expectOk(await call(w.app, M, A, "POST", `/api/einvoice-connectors/${cid}`, { mode: "test", reason: "Test entegratörüyle deneme" }));
    const sent = expectOk(await call(w.app, M, A, "POST", `/api/customer-invoices/${invoiceId}/send-einvoice`, { connectorId: cid, kind: "e_fatura" }));
    expect(sent).toMatchObject({ documentMode: "test", einvoiceKind: "e_fatura", testData: true });
    expect(sent.einvoiceEttn).toMatch(/^[0-9a-f-]{36}$/);
    const again = await call(w.app, M, A, "POST", `/api/customer-invoices/${invoiceId}/send-einvoice`, { connectorId: cid, kind: "e_fatura" });
    expect(again.body.error.code).toBe("already_sent");
    const full = expectOk(await call(w.app, M, A, "GET", `/api/customer-invoices/${invoiceId}`));
    expect(full).toMatchObject({ documentMode: "test", einvoiceKind: "e_fatura", einvoiceConnector: "Uyumsoft" });
  });

  it("RLS: başka şirket bağlayıcıları ve gönderim izini göremez", async () => {
    const e = await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/einvoice-connectors");
    expect(expectOk(e).every((c: any) => c.mode === "not_connected")).toBe(true);
    const inv = await call(w.app, "all@b.test", w.b.companyId, "GET", `/api/customer-invoices/${invoiceId}`);
    expect(inv.status).toBe(404);
  });
});
