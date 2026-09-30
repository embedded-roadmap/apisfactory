/**
 * Oturum 41 devamı — dış bağımlılık 1a/2a: API adaptörü olmayan sağlayıcılar için elle çalışan resmi yollar.
 *  - E-belge PORTAL modu: XML indir → entegratör portalına yükle → portalın ETTN'si girilir → belge CANLI.
 *  - Kargo ELLE modu: firmanın kendi sistemindeki takip no girilir, durum elle işaretlenir, takip sayfası şablonu.
 *  - Listede olmayan entegratör / kargo firması şirket tarafından eklenir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let shipmentId: string;
let invoiceId: string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
const W = "warehouse@a.test";
const S = "sales@a.test";
const ACC = "accounting@a.test";
const MGR = "manager@a.test";

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "PM-1", name: "Portal kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "pm.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;MCU-P;1;MCU;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  const rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  for (const area of ["rd", "production", "quality"]) expectOk(await call(w.app, `${area}@a.test`, A, "POST", `/api/revisions/${rev}/handover`, { area, decision: "approve" }));
  const customerId = expectOk(await call(w.app, S, A, "POST", "/api/customers", { code: "M-PM", name: "Portal Müşterisi" })).id;
  expectOk(await call(w.app, S, A, "POST", `/api/customers/${customerId}/addresses`, { label: "Merkez", recipient: "Alıcı", line1: "Deneme Cad. No:5", city: "Ankara", isDefault: true }));
  expectOk(await call(w.app, MGR, A, "POST", "/api/company/tax-profile", { legalName: "Şirket A Elektronik A.Ş.", taxNo: "1234567890", taxOffice: "Kadıköy", addressLine: "Sanayi Cad. No:1", city: "İstanbul", postalCode: "34700" }));
  expectOk(await call(w.app, ACC, A, "POST", `/api/customers/${customerId}/tax-identity`, { legalName: "Portal Müşterisi Ltd.", taxNo: "10000000146", taxOffice: "Çankaya" }));
  const sp = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: "kod,miktar,lot,konum,rev\nPM-1,5,PM-LOT,BTM,A", mapping: stockMapping }));
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  const o = expectOk(await call(w.app, S, A, "POST", "/api/sales-orders", { customerId, requestedDate: "2026-12-01", lines: [{ productRevisionId: rev, qty: "2", unitPrice: "100", currency: "TRY" }] }));
  expectOk(await call(w.app, S, A, "POST", `/api/sales-orders/${o.id}/confirm`));
  shipmentId = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o.id}/shipments`, { lines: [{ lineId: o.lines[0].id, qty: "2" }] })).id;
  const pkg = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${shipmentId}`)).packages[0].id;
  expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg}/items`, { code: "PM-LOT", qty: "2" }));
  expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg}/close`, { checklist: { box: true, accessories: true, label: true, inspection: true } }));
  expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/pack-complete`));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Listede olmayan sağlayıcı", () => {
  it("şirket kendi entegratörünü ve kargo firmasını ekler; aynı ad reddedilir; yetkisiz ekleyemez", async () => {
    const e = expectOk(await call(w.app, ACC, A, "POST", "/api/einvoice-connectors/custom", { name: "Bizim Entegratör", reason: "Anlaşmalı entegratörümüz" }));
    expect(e).toMatchObject({ name: "Bizim Entegratör", mode: "not_connected", isCustom: true });
    expect(e.key).toMatch(/^custom_[0-9a-f]{12}$/);
    expect((await call(w.app, ACC, A, "POST", "/api/einvoice-connectors/custom", { name: "bizim entegratör", reason: "Tekrar" })).body.error.code).toBe("duplicate_name");
    expect((await call(w.app, W, A, "POST", "/api/einvoice-connectors/custom", { name: "X Entegratör", reason: "Deneme" })).status).toBe(403);
    const c = expectOk(await call(w.app, W, A, "POST", "/api/cargo-connectors/custom", { name: "Mahalle Kurye", reason: "Yerel kurye" }));
    expect(c).toMatchObject({ isCustom: true, mode: "not_connected" });
    const list = expectOk(await call(w.app, W, A, "GET", "/api/cargo-connectors"));
    expect(list.at(-1)).toMatchObject({ name: "Mahalle Kurye", isCustom: true, adapterAvailable: false });
    expect(expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/cargo-connectors")).some((x: any) => x.name === "Mahalle Kurye")).toBe(false);
  });
});

describe("Kargo ELLE modu", () => {
  it("takip no zorunlu; kayıt elle açılır, taşıyıcı ve takip bağlantısı gelir, durum elle güncellenir", async () => {
    const c = expectOk(await call(w.app, W, A, "GET", "/api/cargo-connectors")).find((x: any) => x.name === "Mahalle Kurye");
    expect((await call(w.app, W, A, "POST", `/api/cargo-connectors/${c.id}`, { mode: "live", reason: "Canlı deneme" })).status).toBe(409);
    expectOk(await call(w.app, W, A, "POST", `/api/cargo-connectors/${c.id}`, { mode: "manual", reason: "Kurye kendi fişini kesiyor" }));
    const bad = await call(w.app, W, A, "POST", `/api/cargo-connectors/${c.id}/tracking-url`, { template: "http://kurye.test/t?no={no}", reason: "Takip sayfası" });
    expect(bad.status).toBe(400);
    expect((await call(w.app, W, A, "POST", `/api/cargo-connectors/${c.id}/tracking-url`, { template: "https://kurye.test/t", reason: "Takip sayfası" })).status).toBe(400);
    expectOk(await call(w.app, W, A, "POST", `/api/cargo-connectors/${c.id}/tracking-url`, { template: "https://kurye.test/t?no={no}", reason: "Takip sayfası" }));

    // kargo kaydı yokken elle durum girilemez
    expect((await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/cargo-status`, { status: "delivered" })).body.error.code).toBe("not_manual");
    expect((await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/cargo-label`, { connectorId: c.id })).status).toBe(400);
    const r = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/cargo-label`, { connectorId: c.id, trackingNo: "MK-778899" }));
    expect(r).toMatchObject({ carrier: "Mahalle Kurye", trackingNo: "MK-778899", labelMode: "manual", testData: false });
    let s = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${shipmentId}`));
    expect(s).toMatchObject({ cargoLabelMode: "manual", cargoStatus: "created", trackingUrl: "https://kurye.test/t?no=MK-778899", carrier: "Mahalle Kurye" });

    // canlı sorgu yok; elle durum
    expect((await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/cargo-track`)).body.error.code).toBe("not_live");
    expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/cargo-status`, { status: "in_transit", note: "Kurye teslim aldı" }));
    s = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${shipmentId}`));
    expect(s).toMatchObject({ cargoStatus: "in_transit", cargoStatusRaw: "Kurye teslim aldı" });
    expect((await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/cargo-status`, { status: "unknown" })).status).toBe(400);

    // taşıyıcı ve takip no etiketten gelir
    expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipmentId}/ship`, {}, { "idempotency-key": "pm-ship-1" }));
    s = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${shipmentId}`));
    expect(s).toMatchObject({ status: "shipped", carrier: "Mahalle Kurye", trackingNo: "MK-778899" });
  });
});

describe("E-belge PORTAL modu", () => {
  it("hazırla → XML aynı ETTN ile iner → portal ETTN'si girilince CANLI; ikinci gönderim yok", async () => {
    invoiceId = expectOk(await call(w.app, ACC, A, "POST", "/api/customer-invoices/from-shipment", { shipmentId })).id;
    expectOk(await call(w.app, ACC, A, "POST", `/api/customer-invoices/${invoiceId}/issue`, {}));
    const c = expectOk(await call(w.app, ACC, A, "GET", "/api/einvoice-connectors")).find((x: any) => x.name === "Bizim Entegratör");
    expectOk(await call(w.app, ACC, A, "POST", `/api/einvoice-connectors/${c.id}`, { mode: "portal", reason: "Entegratör portalını kullanıyoruz" }));

    const p = expectOk(await call(w.app, ACC, A, "POST", `/api/customer-invoices/${invoiceId}/send-einvoice`, { connectorId: c.id, kind: "e_fatura" }));
    expect(p).toMatchObject({ einvoiceStatus: "portal_pending", testData: false });
    const u1 = expectOk(await call(w.app, ACC, A, "GET", `/api/customer-invoices/${invoiceId}/ubl?kind=e_fatura`));
    const u2 = expectOk(await call(w.app, ACC, A, "GET", `/api/customer-invoices/${invoiceId}/ubl?kind=e_fatura`));
    expect(u1.uuid).toBe(p.einvoiceEttn);
    expect(u2.uuid).toBe(u1.uuid);
    expect(u1.xml).toContain(`<cbc:UUID>${p.einvoiceEttn}</cbc:UUID>`);

    let inv = expectOk(await call(w.app, ACC, A, "GET", `/api/customer-invoices/${invoiceId}`));
    expect(inv).toMatchObject({ einvoiceStatus: "portal_pending", documentMode: "draft", einvoiceSentAt: null });
    expect((await call(w.app, ACC, A, "POST", `/api/customer-invoices/${invoiceId}/send-einvoice`, { connectorId: c.id, kind: "e_fatura" })).body.error.code).toBe("portal_pending");

    // iptal → yeniden hazırlanabilir (yeni ETTN)
    expectOk(await call(w.app, ACC, A, "POST", `/api/customer-invoices/${invoiceId}/einvoice-portal`, { outcome: "cancelled", reason: "Yanlış tür seçildi" }));
    const p2 = expectOk(await call(w.app, ACC, A, "POST", `/api/customer-invoices/${invoiceId}/send-einvoice`, { connectorId: c.id, kind: "e_fatura" }));
    expect(p2.einvoiceEttn).not.toBe(p.einvoiceEttn);

    expect((await call(w.app, ACC, A, "POST", `/api/customer-invoices/${invoiceId}/einvoice-portal`, { outcome: "uploaded", ettn: "abc" })).status).toBe(400);
    expect((await call(w.app, ACC, A, "POST", `/api/customer-invoices/${invoiceId}/einvoice-portal`, { outcome: "uploaded", ettn: p2.einvoiceEttn, number: "AB-1" })).status).toBe(400);
    expect((await call(w.app, W, A, "POST", `/api/customer-invoices/${invoiceId}/einvoice-portal`, { outcome: "uploaded", ettn: p2.einvoiceEttn })).status).toBe(403);
    const done = expectOk(await call(w.app, ACC, A, "POST", `/api/customer-invoices/${invoiceId}/einvoice-portal`, { outcome: "uploaded", ettn: p2.einvoiceEttn.toUpperCase(), number: "abc2026000000001" }));
    expect(done).toMatchObject({ einvoiceStatus: "sent", documentMode: "live", einvoiceEttn: p2.einvoiceEttn, einvoiceNumber: "ABC2026000000001" });
    inv = expectOk(await call(w.app, ACC, A, "GET", `/api/customer-invoices/${invoiceId}`));
    expect(inv).toMatchObject({ documentMode: "live", einvoiceNumber: "ABC2026000000001", einvoiceConnector: "Bizim Entegratör" });
    expect(inv.einvoiceSentAt).toBeTruthy();
    expect((await call(w.app, ACC, A, "POST", `/api/customer-invoices/${invoiceId}/send-einvoice`, { connectorId: c.id, kind: "e_fatura" })).body.error.code).toBe("already_sent");
    expect((await call(w.app, ACC, A, "POST", `/api/customer-invoices/${invoiceId}/einvoice-portal`, { outcome: "cancelled", reason: "Geç kaldı" })).body.error.code).toBe("not_portal_pending");

    const ev = expectOk(await call(w.app, ACC, A, "GET", `/api/history/customer_invoice/${invoiceId}`));
    const types = (Array.isArray(ev) ? ev : ev.events ?? []).map((e: any) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(["einvoice.portal_prepared", "einvoice.portal_cancelled", "einvoice.portal_uploaded"]));
  });

  it("şema: portal modu yalnız e-belgede, elle mod yalnız kargoda", async () => {
    const e = expectOk(await call(w.app, ACC, A, "GET", "/api/einvoice-connectors"))[0];
    expect((await call(w.app, ACC, A, "POST", `/api/einvoice-connectors/${e.id}`, { mode: "manual", reason: "Yanlış mod" })).status).toBe(400);
    const c = expectOk(await call(w.app, W, A, "GET", "/api/cargo-connectors"))[0];
    expect((await call(w.app, W, A, "POST", `/api/cargo-connectors/${c.id}`, { mode: "portal", reason: "Yanlış mod" })).status).toBe(400);
  });
});
