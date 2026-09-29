/**
 * R14: teklif talebinde onaylı alternatif — RFQ istenen kalemin onaylı alternatiflerini listeler; tedarikçi genel kapsamlı
 * onaylı alternatif için teklif verebilir; ödülde sipariş satırı alternatif kalemle açılır ve gerekçe istenir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
const P = "purchasing@a.test";
const items: Record<string, string> = {};
let rfqId: string;
let supplierId: string;

async function approvedAlternate(itemId: string, altId: string, productId?: string) {
  const a = expectOk(await call(w.app, P, A, "POST", "/api/alternates", { itemId, alternateItemId: altId, productId, reason: "Tedarik riski için ikinci kaynak", pinCompatible: true, footprintSame: true, electricalEquivalent: true }));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/alternates/${a.id}/decision`, { area: "rd", decision: "approve", note: "Datasheet karşılaştırması eşdeğer" }));
  expectOk(await call(w.app, "production@a.test", A, "POST", `/api/alternates/${a.id}/decision`, { area: "production", decision: "approve", note: "Dizgi programı değişmiyor" }));
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  for (const [code, name] of [["RA-CAP", "Kondansatör 10uF 0603"], ["RA-CAP-B", "Kondansatör 10uF 0603 muadil"], ["RA-CAP-C", "Kondansatör 10uF 0603 ürüne özel"], ["RA-RES", "Direnç"]]) {
    items[code] = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code, name, kind: "component" })).id;
  }
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "RA-P", name: "Ürün" })).id;
  await approvedAlternate(items["RA-CAP"]!, items["RA-CAP-B"]!);
  await approvedAlternate(items["RA-CAP"]!, items["RA-CAP-C"]!, productId);
  const pr = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/purchase-requests", { itemId: items["RA-CAP"], qty: "100", note: "Stok tamamlama" }));
  expectOk(await call(w.app, P, A, "POST", `/api/purchase-requests/${pr.id}/decision`, { decision: "approve" }));
  supplierId = expectOk(await call(w.app, P, A, "POST", "/api/suppliers", { code: "RA-S", name: "Pasif Tedarikçi" })).id;
  rfqId = expectOk(await call(w.app, P, A, "POST", "/api/rfqs", { purchaseRequestId: pr.id })).id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Teklif talebinde onaylı alternatif (R14)", () => {
  it("RFQ onaylı alternatifleri kapsamıyla listeler", async () => {
    const r = expectOk(await call(w.app, P, A, "GET", `/api/rfqs/${rfqId}`));
    expect(r.approvedAlternates.map((a: any) => [a.code, a.general])).toEqual([["RA-CAP-B", true], ["RA-CAP-C", false]]);
  });

  it("alternatif teklifi: yalnız genel onaylı alternatif; aynı tedarikçi istenen kalem ve alternatif için ayrı teklif verir", async () => {
    const base = { supplierId, currency: "TRY", leadTimeDays: 10 };
    expect((await call(w.app, P, A, "POST", `/api/rfqs/${rfqId}/quotes`, { ...base, unitPrice: "1", offeredItemId: items["RA-RES"] })).body.error.code).toBe("not_approved_alternate");
    expect((await call(w.app, P, A, "POST", `/api/rfqs/${rfqId}/quotes`, { ...base, unitPrice: "1", offeredItemId: items["RA-CAP-C"] })).body.error.code).toBe("alternate_scope");
    expectOk(await call(w.app, P, A, "POST", `/api/rfqs/${rfqId}/quotes`, { ...base, unitPrice: "0.50" }));
    const r = expectOk(await call(w.app, P, A, "POST", `/api/rfqs/${rfqId}/quotes`, { ...base, unitPrice: "0.40", offeredItemId: items["RA-CAP-B"] }));
    expect(r.quotes).toHaveLength(2);
    // Güncelleme aynı (tedarikçi, kalem) teklifinin yerine geçer.
    const r2 = expectOk(await call(w.app, P, A, "POST", `/api/rfqs/${rfqId}/quotes`, { ...base, unitPrice: "0.45", offeredItemId: items["RA-CAP-B"] }));
    expect(r2.quotes).toHaveLength(2);
    expect(r2.quotes.find((q: any) => q.offeredItemCode === "RA-CAP-B")).toMatchObject({ unitPrice: "0.450000", cheapest: true });
  });

  it("alternatif teklif ödülü gerekçe ister; sipariş satırı alternatif kalemle açılır", async () => {
    const r = expectOk(await call(w.app, P, A, "GET", `/api/rfqs/${rfqId}`));
    const alt = r.quotes.find((q: any) => q.offeredItemId);
    const noReason = await call(w.app, P, A, "POST", `/api/rfqs/${rfqId}/award`, { quoteId: alt.id });
    expect(noReason.status).toBe(409);
    expect(JSON.stringify(noReason.body)).toContain("onaylı alternatif kalem");
    const ok = expectOk(await call(w.app, P, A, "POST", `/api/rfqs/${rfqId}/award`, { quoteId: alt.id, reason: "Birincil parçanın temini 16 hafta; onaylı muadil" }));
    const po = expectOk(await call(w.app, P, A, "GET", `/api/purchase-orders/${ok.poId}`));
    expect(po.lines[0]).toMatchObject({ itemCode: "RA-CAP-B" });
  });
});
