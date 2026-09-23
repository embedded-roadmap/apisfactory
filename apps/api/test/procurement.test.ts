/**
 * Oturum 13 (W18): tedarikçi, teklif talebi ve karşılaştırma, gerekçeli seçim, satın alma siparişi (test gönderimi),
 * tedarikçi teyidi ve kayma etkisi, takip taraması, mal kabulle sipariş durumu.
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

const S: Record<string, string> = {};
let rfqId: string;
let poId: string;

describe("Tedarikçi ve teklif (W18)", () => {
  it("tedarikçi yalnız satın almayla; bloke tedarikçiden teklif alınmaz", async () => {
    const sales = await call(w.app, "sales@a.test", A, "POST", "/api/suppliers", { code: "XX", name: "Yetkisiz" });
    expect(sales.status).toBe(403);
    for (const [code, name] of [["DIGI", "Dağıtıcı A"], ["MOUS", "Dağıtıcı B"], ["LOCAL", "Yerel Tedarikçi"]] as const) {
      S[code] = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/suppliers", { code, name, defaultLeadTimeDays: 10 })).id;
    }
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/suppliers/${S.LOCAL}/status`, { status: "blocked", reason: "Kalite denetimi başarısız" }));
  });

  it("RFQ yalnız onaylı talepten; teklifler karşılaştırılır (en ucuz, en hızlı, ihtiyaç tarihi)", async () => {
    const r = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/rfqs", { purchaseRequestId: prId }, { "idempotency-key": "rfq-1" }));
    rfqId = r.id;
    expect(r).toMatchObject({ status: "open", qty: "100.000000", prCode: expect.stringMatching(/^SAT-/) });
    const dup = await call(w.app, "purchasing@a.test", A, "POST", "/api/rfqs", { purchaseRequestId: prId });
    expect(dup.body.error.code).toBe("rfq_exists");
    const blocked = await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfqId}/quotes`, { supplierId: S.LOCAL, unitPrice: "1.00", currency: "TRY", leadTimeDays: 2 });
    expect(blocked.body.error.code).toBe("supplier_blocked");
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfqId}/quotes`, { supplierId: S.DIGI, unitPrice: "12.50", currency: "TRY", leadTimeDays: 45 }));
    const q = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfqId}/quotes`, { supplierId: S.MOUS, unitPrice: "14.00", currency: "TRY", leadTimeDays: 7, moq: "150" }));
    const digi = q.quotes.find((x: any) => x.supplierCode === "DIGI");
    const mous = q.quotes.find((x: any) => x.supplierCode === "MOUS");
    expect(digi).toMatchObject({ total: "1250.00", meetsNeedDate: false, fastest: false });
    expect(mous).toMatchObject({ total: "2100.00", meetsNeedDate: true, fastest: true, moqAbove: true });
    expect(digi.cheapest).toBe(true);
    // Fiyat alanı yetkisi olmayan kullanıcı fiyatı görmez
    const prod = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/rfqs/${rfqId}`));
    expect(prod.quotes[0].unitPrice).toBeNull();
  });

  it("en ucuz olmayan teklif gerekçe ister; seçim taslak sipariş açar, talep dönüşür", async () => {
    const mous = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/rfqs/${rfqId}`)).quotes.find((x: any) => x.supplierCode === "MOUS");
    const noReason = await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfqId}/award`, { quoteId: mous.id });
    expect(noReason.body.error.code).toBe("award_reason_required");
    expect(noReason.body.error.details.reasons[0]).toContain("en düşük");
    const a = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfqId}/award`, { quoteId: mous.id, reason: "Ucuz teklif ihtiyaç tarihine yetişmiyor (45 gün)" }));
    poId = a.poId;
    const po = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/purchase-orders/${poId}`));
    expect(po).toMatchObject({ status: "draft", supplierName: "Dağıtıcı B", total: "2100.00" });
    expect(po.lines[0]).toMatchObject({ qtyOrdered: "150.000000", requestedDate: addDays(30) }); // MOQ
    const prs = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchase-requests"));
    expect(prs.find((p: any) => p.id === prId).status).toBe("converted");
    const again = await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfqId}/award`, { quoteId: mous.id, reason: "tekrar deneme gerekçesi" });
    expect(again.body.error.code).toBe("rfq_closed");
  });
});

describe("Satın alma siparişi, teyit ve gecikme (W18)", () => {
  it("gönderim yalnız test modunda çıkış kutusuna; teyitsiz satır takip görevine düşer", async () => {
    const early = await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-orders/${poId}/lines/00000000-0000-0000-0000-000000000000/confirm`, { confirmedDate: addDays(7) });
    expect(early.body.error.code).toBe("invalid_transition"); // taslak sipariş teyit alamaz
    const sent = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-orders/${poId}/send`));
    expect(sent).toMatchObject({ status: "sent", sendMode: "test" });
    const ob = await w.owner.query(`select count(*)::int as n from outbox where topic = 'supplier.po_send' and payload->>'poId' = $1`, [poId]);
    expect(ob.rows[0].n).toBe(1);
    // Gönderimi 4 gün öncesine çek → teyitsiz takip
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await w.owner.query(`update purchase_orders set sent_at = now() - interval '4 days' where id = $1`, [poId]);
    const run = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/purchasing/followups/run"));
    expect(run.followups).toBe(1);
    const rerun = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/purchasing/followups/run"));
    expect(rerun.followups).toBe(0); // günde bir kez
    const tasks = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/tasks/mine"));
    expect(tasks.some((t: any) => t.kind === "po_followup" && t.title.startsWith("Tedarikçi teyidi yok"))).toBe(true);
    const fu = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchasing/followups"));
    expect(fu[0]).toMatchObject({ state: "unconfirmed", supplierName: "Dağıtıcı B" });
  });

  let lineId: string;
  it("teyit değişmez kayıttır; ileri kayma not ister ve bağlı siparişe etkiyi görev olarak açar", async () => {
    const po = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/purchase-orders/${poId}`));
    lineId = po.lines[0].id;
    const c1 = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-orders/${poId}/lines/${lineId}/confirm`, { confirmedDate: addDays(10), supplierReference: "SO-778" }));
    expect(c1).toMatchObject({ status: "confirmed", slipDays: -20 });
    expect(expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/tasks/mine")).some((t: any) => t.kind === "po_followup")).toBe(false);
    const noNote = await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-orders/${poId}/lines/${lineId}/confirm`, { confirmedDate: addDays(35) });
    expect(noNote.body.error.code).toBe("reason_required");
    const c2 = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-orders/${poId}/lines/${lineId}/confirm`, { confirmedDate: addDays(35), note: "Üretici wafer gecikmesi" }));
    expect(c2.slipDays).toBe(25);
    expect(c2.impact).toHaveLength(1);
    expect(c2.impact[0]).toMatchObject({ customer: "Alım Müşterisi", atRisk: true });
    expect(c2.lines[0].confirmations).toHaveLength(2);
    const sales = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/tasks/mine"));
    expect(sales.some((t: any) => t.kind === "supplier_delay" && t.entityId === orderId)).toBe(true);
    await expect(w.owner.query(`update po_confirmations set confirmed_date = current_date`)).rejects.toThrow(/append/i);
    const sup = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/suppliers"));
    expect(Number(sup.find((s: any) => s.code === "MOUS").avgSlipDays)).toBe(2.5);
    // Teyit tarihi geçince gecikmiş takibi
    await w.owner.query(`update purchase_order_lines set confirmed_date = current_date - 2, last_followup_at = null where id = $1`, [lineId]);
    expect(expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/purchasing/followups/run")).followups).toBe(1);
    const fu = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchasing/followups"));
    expect(fu[0]).toMatchObject({ state: "overdue", daysLate: 2 });
  });

  it("mal kabul sipariş durumunu ilerletir; teslim alınan sipariş iptal edilemez", async () => {
    const part = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/receipts", { supplierName: "Dağıtıcı B", purchaseOrderLineId: lineId, lines: [{ itemId: mcu, lotNo: "MCUP-1", qty: "100" }] }));
    expect(part).toBeTruthy();
    expect(expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/purchase-orders/${poId}`)).status).toBe("partially_received");
    const cancel = await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-orders/${poId}/cancel`, { reason: "Vazgeçildi" });
    expect(cancel.body.error.code).toBe("invalid_transition");
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/receipts", { supplierName: "Dağıtıcı B", purchaseOrderLineId: lineId, lines: [{ itemId: mcu, lotNo: "MCUP-2", qty: "50" }] }));
    const done = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/purchase-orders/${poId}`));
    expect(done.status).toBe("received");
    expect(done.lines[0].status).toBe("closed");
    expect(expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchasing/followups"))).toHaveLength(0);
    // Diğer şirket göremez
    const other = await call(w.app, "all@b.test", w.b.companyId, "GET", `/api/purchase-orders/${poId}`);
    expect(other.status).toBe(404);
  });
});
