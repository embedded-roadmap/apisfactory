/**
 * Gerçek kullanımda (yerel bot testi, 2026-10-05) bulunan hata: satın almacı talebi kendisi açıp yönetici onayladıktan
 * sonra, teklif → seçim → sipariş taslağı akışının sonunda kendi siparişini GÖNDEREMİYORDU ("Kendi talebinizi
 * onaylayamazsınız"). Gönderimdeki ikinci kontrolün amacı yalnız parasal limittir; kendi talebini onaylama yasağı
 * talep onayında zaten uygulanmıştır.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let itemId: string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "OWN-1", name: "Kendi talebi kartı" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;OwnSemi;MCU-OWN;1;MCU;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "o.csv", content: csv, mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  itemId = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bom}`)).lines[0].itemId;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("satın almacının kendi açtığı talep", () => {
  it("kendisi onaylayamaz; yönetici onayından sonra teklif, seçim ve sipariş gönderimini kendisi yapabilir", async () => {
    const pr = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/purchase-requests", { itemId, qty: "50", note: "Pilot üretim için MCU" }));
    const self = await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-requests/${pr.id}/decision`, { decision: "approve" });
    expect(self.body.error.code).toBe("self_approval");
    expectOk(await call(w.app, "manager@a.test", A, "POST", `/api/purchase-requests/${pr.id}/decision`, { decision: "approve" }));

    const sup = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/suppliers", { code: "OWN-S", name: "Kendi Tedarikçi", defaultLeadTimeDays: 5 })).id;
    const rfq = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/rfqs", { purchaseRequestId: pr.id })).id;
    const q = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfq}/quotes`, { supplierId: sup, unitPrice: "185.50", currency: "TRY", leadTimeDays: 5 }));
    const poId = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfq}/award`, { quoteId: q.quotes[0].id })).poId;

    const sent = await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-orders/${poId}/send`);
    expect(sent.body.error?.code).toBeUndefined();
    expect(sent.body).toMatchObject({ status: "sent", sendMode: "test" });
  });
});
