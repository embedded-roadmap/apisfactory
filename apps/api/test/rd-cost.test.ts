/**
 * R05: Devirde Ar-Ge maliyetinin hesaplanması (ana talimat §8).
 * "Devirde Ar-Ge maliyeti raporlansın: prototip malzemesi, PCB/dizgi, mühendislik zamanı, dış hizmet, test ve diğer
 *  tanımlı giderler. Gelmemiş faturalar varsa rapor geçici olsun; yeni giderler tarihçeli düzeltmeyle işlensin. Ar-Ge
 *  payının ürün maliyetine aktarımında aynı gideri iki kez sayma."
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let projectId: string;
let lineId: string;
let supplierId: string;
let firstInvoiceCode: string;
let unpricedEntryId: string;
let revisionId: string;

const addDays = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };

const invoice = (no: string, qty: string) => {
  const amount = (Number(qty) * 20).toFixed(2);
  return { supplierId, invoiceNo: no, invoiceDate: addDays(0), currency: "TRY", netAmount: amount, taxAmount: "0.00", lines: [{ poLineId: lineId, qty, unitPrice: "20.00", amount }] };
};

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  // owner da FORCE RLS altında: değişmezlik/olay kontrolleri için şirket bağlamı.
  await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
  projectId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/rd-projects", { name: "Güç kartı Ar-Ge", costCenter: "ARGE-02" })).id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Ar-Ge maliyeti (R05)", () => {
  it("PCB/dizgi talebi → sipariş → kısmi teslim → kısmi fatura: faturalanan gerçek, faturasız teslim tahakkuk, teslim alınmayan taahhüt", async () => {
    const item = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "PCB-PWR-1", name: "Güç kartı PCB + dizgi", kind: "component" })).id;
    const bad = await call(w.app, "rd@a.test", A, "POST", "/api/purchase-requests", { itemId: item, qty: "10", note: "Projesiz kategori", rdCostCategory: "pcb_assembly" });
    expect(bad.status).toBe(400);
    const pr = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/purchase-requests", { itemId: item, qty: "10", note: "Prototip PCB", projectId, rdCostCategory: "pcb_assembly" }));
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-requests/${pr.id}/decision`, { decision: "approve" }));
    supplierId = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/suppliers", { code: "PCBF", name: "PCB Fabrikası" })).id;
    const rfq = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/rfqs", { purchaseRequestId: pr.id }));
    const q = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfq.id}/quotes`, { supplierId, unitPrice: "20.00", currency: "TRY", leadTimeDays: 5 }));
    const poId = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfq.id}/award`, { quoteId: q.quotes[0].id })).poId;
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-orders/${poId}/send`));
    lineId = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/purchase-orders/${poId}`)).lines[0].id;
    const rc = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/receipts", { supplierName: "PCB Fabrikası", purchaseOrderLineId: lineId, lines: [{ itemId: item, lotNo: "PCB-L1", qty: "6" }] }));
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/receipt-lines/${rc.lines[0].id}/inspection`, { acceptedQty: "6", rejectedQty: "0", note: "Görsel kontrol tamam" }));
    firstInvoiceCode = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/supplier-invoices", invoice("PCB-F1", "4"))).code;

    const cost = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}/cost`));
    expect(cost.status).toBe("provisional");
    expect(cost.byCurrency).toEqual([
      expect.objectContaining({ currency: "TRY", invoiced: "80.00", accrued: "40.00", openCommitment: "80.00", total: "120.00" }),
    ]);
    expect(cost.byCurrency[0].byCategory.pcb_assembly).toBe("120.00");
    expect(cost.provisionalReasons.join(" ")).toMatch(/faturası gelmedi/);
    expect(cost.provisionalReasons.join(" ")).toMatch(/açık sipariş/);
  });

  it("çift sayım koruması: projeye zaten satın alma olarak giren fatura elle bölüştürmeye kaynak olamaz", async () => {
    for (const ref of [firstInvoiceCode, "PCB-F1"]) {
      const dup = await call(w.app, "accounting@a.test", A, "POST", `/api/rd-projects/${projectId}/cost-allocations`, {
        amount: "80.00", currency: "TRY", description: "PCB faturası", sourceRef: ref, reason: "yanlışlıkla ikinci kez", category: "pcb_assembly",
      });
      expect(dup.body.error.code).toBe("double_count");
    }
    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/rd-projects/${projectId}/cost-allocations`, {
      amount: "300.00", currency: "TRY", description: "Dış laboratuvar EMC ön testi", sourceRef: "LAB-2026-17", reason: "Tamamı bu projeye ait", category: "test",
    }));
  });

  it("mühendislik zamanı: tarihinde geçerli ücretle fiyatlanır; ücretsiz saat raporu geçici yapar; düzeltme ters kayıtla", async () => {
    const early = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/time-entries`, { workDate: addDays(-40), hours: "2", activity: "design", note: "Ücret tanımından önce" }));
    unpricedEntryId = early.id;
    expect((await call(w.app, "rd@a.test", A, "POST", "/api/rd-labor-rates", { ratePerHour: "1000", currency: "TRY", effectiveFrom: addDays(-30), note: "yetkisiz deneme" })).status).toBe(403);
    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/rd-labor-rates", { ratePerHour: "1000", currency: "TRY", effectiveFrom: addDays(-30), note: "2026 Ar-Ge saat ücreti" }));
    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/rd-labor-rates", { ratePerHour: "1200", currency: "TRY", effectiveFrom: addDays(-5), note: "Zam sonrası" }));
    const dupRate = await call(w.app, "accounting@a.test", A, "POST", "/api/rd-labor-rates", { ratePerHour: "1300", currency: "TRY", effectiveFrom: addDays(-5), note: "aynı gün" });
    expect(dupRate.body.error.code).toBe("duplicate");

    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/time-entries`, { workDate: addDays(-10), hours: "8", activity: "layout" }));
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/time-entries`, { workDate: addDays(0), hours: "1.5", activity: "test" }));
    expect((await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/time-entries`, { workDate: addDays(1), hours: "1", activity: "test" })).status).toBe(400);
    expect((await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/time-entries`, { workDate: addDays(0), hours: "25", activity: "test" })).status).toBe(400);
    expect((await call(w.app, "sales@a.test", A, "POST", `/api/rd-projects/${projectId}/time-entries`, { workDate: addDays(0), hours: "1", activity: "test" })).status).toBe(403);

    let cost = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}/cost`));
    expect(cost.engineering).toMatchObject({ hours: "11.50", unpricedHours: "2.00" });
    expect(cost.provisionalReasons.join(" ")).toMatch(/2\.00 saat/);
    expect(cost.byCurrency[0].engineering).toBe("9800.00"); // 8 × 1000 + 1,5 × 1200

    const rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/rd-time-entries/${unpricedEntryId}/reverse`, { reason: "Başka projeye aitti" }));
    expect((await call(w.app, "rd@a.test", A, "POST", `/api/rd-time-entries/${unpricedEntryId}/reverse`, { reason: "tekrar" })).body.error.code).toBe("already_reversed");
    expect((await call(w.app, "rd@a.test", A, "POST", `/api/rd-time-entries/${rev.id}/reverse`, { reason: "ters kaydı ters" })).body.error.code).toBe("is_reversal");
    await expect(w.owner.query(`update rd_time_entries set hours = 1 where id = $1`, [unpricedEntryId])).rejects.toThrow(/append/i);

    cost = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}/cost`));
    expect(cost.engineering).toMatchObject({ hours: "9.50", unpricedHours: "0.00" });
    expect(cost.byCurrency[0]).toMatchObject({ invoiced: "80.00", accrued: "40.00", allocated: "300.00", engineering: "9800.00", total: "10220.00" });
    expect(cost.byCurrency[0].byCategory).toMatchObject({ pcb_assembly: "120.00", engineering_time: "9800.00", test: "300.00", prototype_material: "0.00" });
    const list = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}/time-entries`));
    expect(list.find((t: any) => t.id === unpricedEntryId).reversed).toBe(true);
  });

  it("devir onayında rapor sürüm 1 olarak dondurulur; sonra proje bağı değişmez", async () => {
    const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "PWR-1", name: "Güç kartı" })).id;
    const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;PwrSemi;REG-1;1;Regülatör;"].join("\n");
    const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "p.csv", content: csv, mapping }));
    const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
    revisionId = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;

    expect((await call(w.app, "sales@a.test", A, "PUT", `/api/revisions/${revisionId}/rd-project`, { projectId, reason: "deneme" })).status).toBe(403);
    expectOk(await call(w.app, "rd@a.test", A, "PUT", `/api/revisions/${revisionId}/rd-project`, { projectId, reason: "Bu kart PRJ projesinin ürünü" }));
    expect(expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/revisions/${revisionId}`)).rdProjectId).toBe(projectId);

    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revisionId}/transition`, { action: "submit_handover" }));
    for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
      expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revisionId}/handover`, { area, decision: "approve" }));
    }
    const reports = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/revisions/${revisionId}/rd-cost-reports`));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ versionNo: 1, status: "provisional", trigger: "handover" });
    expect(reports[0].report.byCurrency[0].total).toBe("10220.00");

    const relink = await call(w.app, "rd@a.test", A, "PUT", `/api/revisions/${revisionId}/rd-project`, { projectId: null, reason: "ayır" });
    expect(relink.body.error.code).toBe("revision_locked");
    await expect(w.owner.query(`update rd_cost_reports set status = 'final' where revision_id = $1`, [revisionId])).rejects.toThrow(/append/i);
  });

  it("tarihçeli düzeltme: devirden sonra gelen fatura ve zaman yeni sürüm açar; önceki sürüm korunur, fark olay defterinde", async () => {
    expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/supplier-invoices", invoice("PCB-F2", "2")));
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/time-entries`, { workDate: addDays(0), hours: "1", activity: "documentation" }));

    expect((await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revisionId}/rd-cost-reports/recalculate`, { reason: "yeni fatura" })).status).toBe(403);
    expect((await call(w.app, "accounting@a.test", A, "POST", `/api/revisions/${revisionId}/rd-cost-reports/recalculate`, {})).status).toBe(400);
    const v2 = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/revisions/${revisionId}/rd-cost-reports/recalculate`, { reason: "PCB-F2 faturası ve devir sonrası dokümantasyon" }));
    expect(v2).toMatchObject({ versionNo: 2, status: "provisional" }); // 4 adet hâlâ teslim alınmadı
    // Tahakkuk (40) faturaya dönüştü → toplamı değiştirmez; yalnız yeni 1 saat × 1200 fark yaratır.
    expect(v2.report.byCurrency[0]).toMatchObject({ invoiced: "120.00", accrued: "0.00", total: "11420.00" });
    expect(v2.changes).toEqual([{ currency: "TRY", before: "10220.00", after: "11420.00", delta: "1200.00" }]);

    const reports = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/revisions/${revisionId}/rd-cost-reports`));
    expect(reports.map((r: any) => r.versionNo)).toEqual([2, 1]);
    expect(reports[1].report.byCurrency[0].total).toBe("10220.00");
    const events = await w.owner.query(`select event_type from events where entity_id = $1 and event_type like 'rd_cost.%' order by created_at`, [revisionId]);
    expect(events.rows.map((e) => e.event_type)).toEqual(["rd_cost.handover", "rd_cost.recalculation"]);
  });

  it("stoktan karşılanan proje malzemesi: depoya görev, projeye çıkış/iade, lot maliyetiyle Ar-Ge maliyetine girer", async () => {
    const itemId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "MAT-PRJ-1", name: "Prototip konnektör", kind: "component" })).id;
    const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", {
      fileName: "m.csv", content: "kod,miktar,lot,konum\nMAT-PRJ-1,10,MAT-L1,STK", mapping: { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum" },
    }));
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
    const lotId = expectOk(await call(w.app, "warehouse@a.test", A, "GET", "/api/lots/lookup?code=MAT-L1"))[0].id;
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/lots/${lotId}/cost`, { unitCost: "2.5", currency: "TRY", source: "invoice", reference: "FTR-MAT" }));
    const before = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}/cost`)).byCurrency[0];

    const pr = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/purchase-requests", { itemId, qty: "4", note: "Prototip için stoktan", projectId }));
    expect(pr).toMatchObject({ covered: true, coveredQty: "4" });
    const task = await w.owner.query(`select assignee_role from tasks where kind = 'rd_material_issue' and entity_id = $1 and status = 'open'`, [projectId]);
    expect(task.rows.map((t) => t.assignee_role)).toEqual(["warehouse"]);

    expect((await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/material-issues`, { lotId, qty: "4" })).status).toBe(403);
    const open = expectOk(await call(w.app, "warehouse@a.test", A, "GET", "/api/rd-projects/open-for-issue"));
    expect(Object.keys(open.find((x: any) => x.id === projectId)).sort()).toEqual(["code", "id", "name"]);
    expect((await call(w.app, "warehouse@a.test", A, "GET", `/api/rd-projects/${projectId}`)).status).toBe(403); // bütçe/harcama depoya kapalı
    expect((await call(w.app, "warehouse@a.test", A, "POST", `/api/rd-projects/${projectId}/material-issues`, { lotId, qty: "100" })).body.error.code).toBe("lot_not_usable");
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/rd-projects/${projectId}/material-issues`, { lotId, qty: "4", note: "Prototip tezgâhına" }));
    expect((await call(w.app, "warehouse@a.test", A, "POST", `/api/rd-projects/${projectId}/material-returns`, { lotId, qty: "5", note: "fazla iade" })).body.error.code).toBe("over_return");
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/rd-projects/${projectId}/material-returns`, { lotId, qty: "1", note: "Kullanılmadı" }));

    const cost = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}/cost`));
    const now = cost.byCurrency[0];
    expect(now.stockIssued).toBe("7.50"); // (4 − 1) × 2,50
    expect(Number(now.total) - Number(before.total)).toBeCloseTo(7.5, 2);
    expect(Number(now.byCategory.prototype_material) - Number(before.byCategory.prototype_material)).toBeCloseTo(7.5, 2);
    expect(cost.stockMaterials.map((m: any) => [m.moveType, m.amount])).toEqual([["issue", "10.00"], ["return", "-2.50"]]);
    const moves = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}/material-moves`));
    expect(moves).toHaveLength(2);
  });

  it("kapalı projeye zaman kaydı girilmez", async () => {
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/close`, { reason: "Devir tamamlandı" }));
    const r = await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/time-entries`, { workDate: addDays(0), hours: "1", activity: "test" });
    expect(r.body.error.code).toBe("project_closed");
  });
});
