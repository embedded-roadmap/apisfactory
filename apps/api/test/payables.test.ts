/**
 * Oturum 14 (W24): tedarikçi faturası üç yönlü eşleştirme (sipariş – kalite kabulü – fatura), tolerans politikası,
 * fark onayı ve görev ayrılığı, faturadan lot maliyeti, ödeme kaydı (ödeme yapılmaz), yaşlandırma.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let revA: string;
let orderId: string;
let prId: string;
let mcu: string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const addDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "PO-1", name: "Alım kartı" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;PoSemi;MCU-P;1;MCU;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "p.csv", content: csv, mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  mcu = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bom}`)).lines[0].itemId;
  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revA}/handover`, { area, decision: "approve" }));
  }
  const customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "C-PO", name: "Alım Müşterisi" })).id;
  const o = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: addDays(30), lines: [{ productRevisionId: revA, qty: "100" }] }));
  orderId = o.id;
  expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${orderId}/confirm`));
  const prs = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchase-requests"));
  prId = prs.find((p: any) => p.sourceType === "production_need").id;
  expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-requests/${prId}/decision`, { decision: "approve" }));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

let sup: string;
let poId: string;
let lineId: string;
let lots: string[] = [];

describe("Tedarikçi faturası ve üç yönlü eşleştirme (W24)", () => {
  beforeAll(async () => {
    sup = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/suppliers", { code: "INV", name: "Faturalı Tedarikçi" })).id;
    const rfq = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/rfqs", { purchaseRequestId: prId }));
    const q = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfq.id}/quotes`, { supplierId: sup, unitPrice: "10.00", currency: "TRY", leadTimeDays: 5 }));
    poId = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfq.id}/award`, { quoteId: q.quotes[0].id })).poId;
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-orders/${poId}/send`));
    lineId = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/purchase-orders/${poId}`)).lines[0].id;
    // 50 geldi: 40 kabul, 10 ret; ikinci teslimat 50 (henüz kalite kararı yok)
    const r1 = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/receipts", { supplierName: "Faturalı Tedarikçi", purchaseOrderLineId: lineId, lines: [{ itemId: mcu, lotNo: "INV-1", qty: "50" }] }));
    lots.push(r1.lines[0].lotId);
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/receipt-lines/${r1.lines[0].id}/inspection`, { acceptedQty: "40", rejectedQty: "10", note: "10 adet hasarlı" }));
    const r2 = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/receipts", { supplierName: "Faturalı Tedarikçi", purchaseOrderLineId: lineId, lines: [{ itemId: mcu, lotNo: "INV-2", qty: "50" }] }));
    lots.push(r2.lines[0].lotId);
  });

  const inv = (no: string, qty: string, price: string, extra: Record<string, unknown> = {}) => {
    const amount = (Number(qty) * Number(price)).toFixed(2);
    return { supplierId: sup, invoiceNo: no, invoiceDate: addDays(0), currency: "TRY", netAmount: amount, taxAmount: (Number(amount) * 0.2).toFixed(2), lines: [{ poLineId: lineId, qty, unitPrice: price, amount }], ...extra };
  };

  it("yalnız muhasebe girer; kabul edilen miktardan fazlası ve fiyat farkı işaretlenir (önizleme yazmaz)", async () => {
    const buyer = await call(w.app, "purchasing@a.test", A, "POST", "/api/supplier-invoices", inv("F-1", "40", "10.00"));
    expect(buyer.status).toBe(403);
    const pv = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/supplier-invoices/preview", inv("F-1", "140", "10.50")));
    expect(pv.matched).toBe(false);
    expect(pv.lines[0].flags.map((f: any) => f.code).sort()).toEqual(["price_variance", "qty_over_accepted"]);
    expect(pv.lines[0]).toMatchObject({ accepted: 40, pendingInspection: 50, priceDeviationPct: 5 });
    const list = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/supplier-invoices"));
    expect(list).toHaveLength(0);
    const able = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/payables/invoiceable?supplierId=${sup}`));
    expect(able[0]).toMatchObject({ invoiceableQty: "40" });
  });

  let okId: string;
  it("tolerans içindeki fatura otomatik onaylanır, vade tedarikçi şartından, lotlara fatura maliyeti yazılır; mükerrer fatura reddedilir", async () => {
    const f = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/supplier-invoices", inv("F-1", "40", "10.15"), { "idempotency-key": "inv-1" }));
    okId = f.id;
    expect(f).toMatchObject({ status: "approved", grossAmount: "487.20", dueDate: addDays(30), lotCostsWritten: 2 });
    const again = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/supplier-invoices", inv("F-1", "40", "10.15"), { "idempotency-key": "inv-1" }));
    expect(again.id).toBe(okId);
    const dup = await call(w.app, "accounting@a.test", A, "POST", "/api/supplier-invoices", inv("F-1", "1", "10.00"));
    expect(dup.body.error.code).toBe("duplicate_invoice");
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    const lc = await w.owner.query(`select unit_cost::float8 as c, source, reference from lot_costs where lot_id = any($1) order by id`, [lots]);
    expect(lc.rows.every((r) => r.source === "invoice" && r.c === 10.15)).toBe(true);
    // Kabul edilen 40'ın tamamı faturalandı: 50'lik teslimat kalite kararı olmadan faturalanamaz
    const more = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/supplier-invoices/preview", inv("F-2", "10", "10.00")));
    expect(more.lines[0].flags[0].code).toBe("qty_over_accepted");
  });

  let varId: string;
  it("farklı fatura onaya düşer; giren onaylayamaz, gerekçeli onay başka kişiden; toplam uyuşmazlığı ve siparişsiz satır da fark", async () => {
    const lines2 = await w.owner.query(`select id from goods_receipt_lines where lot_id = $1`, [lots[1]]);
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/receipt-lines/${lines2.rows[0].id}/inspection`, { acceptedQty: "50", rejectedQty: "0" }));
    const body = inv("F-2", "50", "11.00");
    body.lines.push({ description: "Nakliye", qty: "1", unitPrice: "75.00", amount: "75.00" } as any);
    body.netAmount = "600.00"; // 550 + 75 = 625 → toplam uyuşmuyor
    body.taxAmount = "0";
    const f = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/supplier-invoices", body));
    varId = f.id;
    expect(f.status).toBe("variance");
    expect(f.matchResult.headerFlags[0].code).toBe("total_mismatch");
    expect(f.matchResult.lines[1].flags[0].code).toBe("po_missing");
    const tasks = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/tasks/mine"));
    expect(tasks.some((t: any) => t.kind === "invoice_variance" && t.entityId === varId)).toBe(true);
    const self = await call(w.app, "accounting@a.test", A, "POST", `/api/supplier-invoices/${varId}/decision`, { decision: "approve", note: "Nakliye sözleşmede var" });
    expect(self.body.error.code).toBe("segregation_of_duties");
    const pay = await call(w.app, "accounting@a.test", A, "POST", `/api/supplier-invoices/${varId}/payments`, { amount: "10.00", paidOn: addDays(0), reference: "EFT-1" });
    expect(pay.body.error.code).toBe("not_payable");
    const ok = expectOk(await call(w.app, "manager@a.test", A, "POST", `/api/supplier-invoices/${varId}/decision`, { decision: "approve", note: "Nakliye sözleşmede var; fiyat artışı yazılı teyitli" }));
    expect(ok).toMatchObject({ status: "approved", decidedBy: "A manager" });
    expect(expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/tasks/mine")).some((t: any) => t.entityId === varId)).toBe(false);
  });

  it("ödeme yalnız kayıt: açık bakiyeyi aşamaz, tamamı girilince kapanır; yaşlandırma ve plan", async () => {
    const over = await call(w.app, "accounting@a.test", A, "POST", `/api/supplier-invoices/${okId}/payments`, { amount: "2000.00", paidOn: addDays(0), reference: "EFT-2" });
    expect(over.body.error.code).toBe("overpayment");
    const p1 = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/supplier-invoices/${okId}/payments`, { amount: "200.00", paidOn: addDays(0), reference: "EFT-3" }));
    expect(p1).toMatchObject({ status: "approved", open: "287.20" });
    const aging = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/payables/aging"));
    expect(aging.buckets[0]).toMatchObject({ currency: "TRY", total: "887.20" });
    const p2 = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/supplier-invoices/${okId}/payments`, { amount: "287.20", paidOn: addDays(0), reference: "EFT-4" }));
    expect(p2).toMatchObject({ status: "paid", open: "0.00" });
    expect(p2.payments).toHaveLength(2);
    await expect(w.owner.query(`update supplier_payments set amount = 1`)).rejects.toThrow(/append/i);
    const cancel = await call(w.app, "accounting@a.test", A, "POST", `/api/supplier-invoices/${okId}/cancel`, { reason: "Hatalı" });
    expect(cancel.body.error.code).toBe("invalid_transition");
    const other = await call(w.app, "all@b.test", w.b.companyId, "GET", `/api/supplier-invoices/${okId}`);
    expect(other.status).toBe(404); // başka şirketin faturası görünmez
  });

  it("tolerans politikası sürümlü; toleransı yükseltince aynı fark eşleşir", async () => {
    const buyer = await call(w.app, "purchasing@a.test", A, "POST", "/api/payables/policy", { priceTolerancePct: 10, qtyTolerancePct: 0, amountTolerance: 0, note: "deneme" });
    expect(buyer.status).toBe(403);
    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/payables/policy", { priceTolerancePct: 12, qtyTolerancePct: 0, amountTolerance: 0, note: "Kur dalgalanması dönemi" }));
    const pv = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/supplier-invoices/preview", { ...inv("F-9", "1", "11.00"), lines: [{ poLineId: lineId, qty: "1", unitPrice: "11.00", amount: "11.00" }], netAmount: "11.00" }));
    expect(pv).toMatchObject({ policyVersion: 1 });
    expect(pv.lines[0].flags.map((f: any) => f.code)).toEqual(["qty_over_accepted"]); // fiyat artık tolerans içinde
  });
});
