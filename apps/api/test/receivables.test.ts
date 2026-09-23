/**
 * Oturum 15: müşteri faturası (sevkiyattan taslak, kesilen fatura değişmez), tahsilat kaydı, alacak yaşlandırma,
 * kredi limiti ve vadesi geçmiş alacak engeli, gerekçeli serbest bırakma.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let revA: string;
let customerId: string;
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

  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revA}/handover`, { area, decision: "approve" }));
  }
  customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "C-AR", name: "Alacak Müşterisi" })).id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

async function firmOrder(qty: string, price?: string) {
  const o = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: addDays(30), lines: [{ productRevisionId: revA, qty, unitPrice: price }] }));
  return o.id as string;
}
/** Sevkiyat akışı (paketleme) bu testin konusu değil: sevk edilmiş sevkiyat doğrudan yazılır. */
async function shipped(orderId: string, qty: string) {
  await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
  const l = (await w.owner.query(`select id from sales_order_lines where order_id = $1`, [orderId])).rows[0];
  const code = `SV-T${Math.floor(Math.random() * 1e6)}`;
  const sh = await w.owner.query(`insert into shipments (company_id, code, sales_order_id, status, shipped_at) values ($1, $2, $3, 'shipped', now()) returning id`, [A, code, orderId]);
  await w.owner.query(`insert into shipment_lines (company_id, shipment_id, sales_order_line_id, qty) values ($1, $2, $3, $4)`, [A, sh.rows[0].id, l.id, qty]);
  return sh.rows[0].id as string;
}

let o1: string;
let sh1: string;
let invId: string;

describe("Müşteri faturası ve tahsilat", () => {
  it("sevkiyattan taslak: fiyat siparişten, KDV oranı; sevkiyat başına bir fatura; fiyatsız satır faturalanmaz", async () => {
    o1 = await firmOrder("10", "150.00");
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o1}/confirm`));
    sh1 = await shipped(o1, "10");
    const list = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/receivables/uninvoiced-shipments"));
    expect(list.map((x: any) => x.id)).toContain(sh1);
    const sales = await call(w.app, "sales@a.test", A, "POST", "/api/customer-invoices/from-shipment", { shipmentId: sh1 });
    expect(sales.status).toBe(403);
    const d = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/customer-invoices/from-shipment", { shipmentId: sh1, taxRate: 20 }, { "idempotency-key": "ci-1" }));
    invId = d.id;
    expect(d).toMatchObject({ status: "draft", documentMode: "draft", netAmount: "1500.00", taxAmount: "300.00", grossAmount: "1800.00" });
    expect(d.code).toMatch(/^MF-TASLAK-/);
    const again = await call(w.app, "accounting@a.test", A, "POST", "/api/customer-invoices/from-shipment", { shipmentId: sh1 });
    expect(again.body.error.code).toBe("already_invoiced");
    const o2 = await firmOrder("1");
    expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o2}/confirm`));
    const sh2 = await shipped(o2, "1");
    const np = await call(w.app, "accounting@a.test", A, "POST", "/api/customer-invoices/from-shipment", { shipmentId: sh2 });
    expect(np.body.error.code).toBe("price_missing");
    // Taslakta KDV değişebilir
    const u = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/update`, { taxRate: 10 }));
    expect(u.grossAmount).toBe("1650.00");
    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/update`, { taxRate: 20 }));
  });

  it("kesilen fatura numaralanır, vadesi müşteri şartından; değişmez; tahsilat yalnız kayıt", async () => {
    const early = await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/receipts`, { amount: "10.00", receivedOn: addDays(0), reference: "HAV-0" });
    expect(early.body.error.code).toBe("not_receivable");
    const i = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/issue`, { invoiceDate: addDays(-40) }));
    expect(i).toMatchObject({ status: "issued", code: "MF-000001", invoiceDate: addDays(-40), dueDate: addDays(-10), overdue: true });
    const upd = await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/update`, { taxRate: 0 });
    expect(upd.body.error.code).toBe("invoice_issued");
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await expect(w.owner.query(`update customer_invoices set net_amount = 1 where id = $1`, [invId])).rejects.toThrow(/invoice_issued/);
    await expect(w.owner.query(`update customer_invoice_lines set qty = 1 where invoice_id = $1`, [invId])).rejects.toThrow(/invoice_issued/);
    const r1 = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/receipts`, { amount: "800.00", receivedOn: addDays(0), reference: "HAV-1" }));
    expect(r1).toMatchObject({ status: "issued", open: "1000.00" });
    const over = await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/receipts`, { amount: "1000.01", receivedOn: addDays(0), reference: "HAV-2" });
    expect(over.body.error.code).toBe("overpayment");
    const cancel = await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/cancel`, { reason: "hata" });
    expect(cancel.body.error.code).toBe("invalid_transition");
    await expect(w.owner.query(`update customer_receipts set amount = 1`)).rejects.toThrow(/append/i);
  });

  it("yaşlandırma ve kredi durumu; satış görebilir, değiştiremez", async () => {
    const ag = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/receivables/aging"));
    expect(ag.buckets[0]).toMatchObject({ customerName: "Alacak Müşterisi", over1: "1000.00", total: "1000.00" });
    const c = ag.credit.find((x: any) => x.customer === "Alacak Müşterisi");
    expect(c).toMatchObject({ openReceivables: 1000, maxOverdueDays: 10, creditLimit: null, blocked: false });
    expect(c.warnings[0]).toContain("Fiyatı girilmemiş");
    const s = await call(w.app, "sales@a.test", A, "POST", `/api/customers/${customerId}/credit`, { creditLimit: "1", paymentTermsDays: 30, overdueBlockDays: null, reason: "deneme" });
    expect(s.status).toBe(403);
  });
});

describe("Kredi kontrolü", () => {
  it("limit aşımı ve vadesi geçmiş alacak siparişi kesinleştirmeyi engeller; ret olayı kalır", async () => {
    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customers/${customerId}/credit`, { creditLimit: "2000.00", paymentTermsDays: 30, overdueBlockDays: null, reason: "Yıllık kredi değerlendirmesi" }));
    const o = await firmOrder("10", "150.00"); // 1500 + açık 1000 = 2500 > 2000
    const r = await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o}/confirm`);
    expect(r.body.error.code).toBe("credit_blocked");
    expect(r.body.error.details.credit).toMatchObject({ exposure: 2500, available: -500 });
    const hist = expectOk(await call(w.app, "sales@a.test", A, "GET", `/api/history/sales_order/${o}`));
    expect(hist.map((e: any) => e.eventType)).toContain("confirm.rejected.credit");
    // Limit yükseltilse de vadesi 7 günden fazla geçmiş alacak engeller
    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customers/${customerId}/credit`, { creditLimit: "10000.00", paymentTermsDays: 30, overdueBlockDays: 7, reason: "Limit artışı, vade disiplini" }));
    const r2 = await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o}/confirm`);
    expect(r2.body.error.message).toContain("Vadesi 10 gün geçmiş");
    // Satış serbest bırakamaz; yönetici gerekçeyle bırakır, sipariş kesinleşir
    const salesRel = await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o}/credit-release`, { reason: "Müşteri ödeme sözü verdi" });
    expect(salesRel.status).toBe(403);
    expectOk(await call(w.app, "manager@a.test", A, "POST", `/api/sales-orders/${o}/credit-release`, { reason: "Müşteri yazılı ödeme planı verdi; stratejik sipariş" }));
    expect(expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o}/confirm`)).status).toBe("firm");
    // Tahsilat tamamlanınca engel kalkar
    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/customer-invoices/${invId}/receipts`, { amount: "1000.00", receivedOn: addDays(0), reference: "HAV-3" }));
    const st = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/customers/${customerId}/credit`));
    expect(st).toMatchObject({ openReceivables: 0, blocked: false, uninvoicedOrders: 1500 });
    const inv = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/customer-invoices/${invId}`));
    expect(inv.status).toBe("paid");
  });
});
