/**
 * R04: Ar-Ge malzeme talebinin proje ve muhasebeyle bağlantısı (ana talimat §3).
 * "Ar-Ge malzeme talebinde proje, MPN veya tanımlı genel ihtiyaç, miktar, gerekçe, ihtiyaç tarihi
 *  ve maliyet merkezi bulunsun. Önce mevcut stoktan karşılama değerlendirilsin, kalan satın almaya
 *  aktarılsın. Muhasebe her giderin hangi projeye ait olduğunu görebilsin. Ortak alım ve giderler
 *  paylaştırılsın."
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let itemNoStock: string;
let itemWithStock: string; // 5 birim serbest stok
let projectId: string;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;

  itemNoStock = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "PRJ-CMP-1", name: "Proje bileşeni (stoksuz)", kind: "component" })).id;
  itemWithStock = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "PRJ-CMP-2", name: "Proje bileşeni (stoklu)", kind: "component" })).id;

  const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", {
    fileName: "prj.csv", content: "kod,miktar,lot,konum\nPRJ-CMP-2,5,PRJ-L1,STK",
    mapping: { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum" },
  }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Ar-Ge projeleri ve malzeme talebi (R04)", () => {
  it("proje oluşturma yetkiye tabi; bütçe verilirse para birimi zorunlu", async () => {
    const denied = await call(w.app, "sales@a.test", A, "POST", "/api/rd-projects", { name: "Yetkisiz deneme" });
    expect(denied.status).toBe(403);
    const badBudget = await call(w.app, "rd@a.test", A, "POST", "/api/rd-projects", { name: "Bütçe hatalı", budgetAmount: "1000" });
    expect(badBudget.status).toBe(400);
    const p = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/rd-projects", {
      name: "Yeni nesil sensör projesi", costCenter: "ARGE-01", budgetAmount: "1000.00", currency: "TRY", note: "Pilot",
    }));
    expect(p.code).toMatch(/^PRJ-/);
    projectId = p.id;
    const detail = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/rd-projects/${projectId}`));
    expect(detail).toMatchObject({ name: "Yeni nesil sensör projesi", costCenter: "ARGE-01", status: "open" });
    expect(detail.budgetStatus).toMatchObject({ currency: "TRY", budgetAmount: "1000.00", spent: "0.00", remaining: "1000.00" });
  });

  it("proje bağlantısız (genel) manuel talep eskisi gibi çalışır — stok kontrolü yapılmaz", async () => {
    const r = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/purchase-requests", { itemId: itemWithStock, qty: "2", note: "Genel talep, proje yok" }));
    expect(r.covered).toBe(false);
    expect(r.forwardedQty).toBe("2"); // 5 birim stok olmasına rağmen düşülmedi — proje bağlantısı yoksa eski davranış
  });

  it("projeye bağlı talepte önce stoktan karşılama değerlendirilir, kalan satın almaya aktarılır; maliyet merkezi projeden miras alınır", async () => {
    // itemWithStock'ta serbest stok az önceki genel talep tarafından rezerve edilmedi (yalnızca yeni bir PR açıldı,
    // rezervasyon oluşturmadı) — bu yüzden hâlâ 5 birim serbest. 8 birim istenince 5'i stoktan karşılanır, 3'ü kalır.
    const r = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/purchase-requests", {
      itemId: itemWithStock, qty: "8", note: "Prototip için gerekli", projectId, needDate: "2027-01-15",
    }));
    expect(r.covered).toBe(false);
    expect(r).toMatchObject({ requestedQty: "8", coveredQty: "5", forwardedQty: "3" });

    const detail = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}`));
    const pr = detail.purchaseRequests.find((x: any) => x.id === r.id);
    expect(pr).toMatchObject({ qty: "3.000000", costCenter: "ARGE-01" }); // proje maliyet merkezinden miras alındı
  });

  it("stok talebi tamamen karşılıyorsa satın alma talebi açılmaz (uydurma talep yok)", async () => {
    const r = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/purchase-requests", {
      itemId: itemWithStock, qty: "1", note: "Az miktar, stok yeter", projectId,
    }));
    expect(r).toMatchObject({ covered: true, id: null, requestedQty: "1", coveredQty: "1", forwardedQty: "0" });
    const detail = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}`));
    expect(detail.purchaseRequests).toHaveLength(1); // önceki testteki tek talep — bu tur hiç eklenmedi
  });

  it("stok yoksa talebin tamamı satın almaya yönlendirilir", async () => {
    const r = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/purchase-requests", {
      itemId: itemNoStock, qty: "50", note: "Stoksuz kalem", projectId,
    }));
    expect(r).toMatchObject({ covered: false, requestedQty: "50", coveredQty: "0", forwardedQty: "50" });
  });

  it("gerçek harcama: onay → teklif → ödül zincirinden doğan PO satırı proje harcamasına yansır", async () => {
    const detail0 = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}`));
    const pr = detail0.purchaseRequests.find((x: any) => x.qty === "3.000000");
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-requests/${pr.id}/decision`, { decision: "approve" }));
    const supplier = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/suppliers", { code: "TED-PRJ", name: "Proje Tedarikçisi" }));
    const rfq = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/rfqs", { purchaseRequestId: pr.id }));
    const q = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfq.id}/quotes`, { supplierId: supplier.id, unitPrice: "20.00", currency: "TRY", leadTimeDays: 3 }));
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${rfq.id}/award`, { quoteId: q.quotes[0].id }));

    const detail = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/rd-projects/${projectId}`));
    const spend = detail.spendByCurrency.find((s: any) => s.currency === "TRY");
    expect(spend.orderedAmount).toBe("60.00"); // 3 × 20.00
    expect(detail.budgetStatus).toMatchObject({ spent: "60.00", remaining: "940.00" });
  });

  it("ortak gider paylaştırma: muhasebe gerekçeyle elle böler; yetkisiz rol reddedilir", async () => {
    const denied = await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/cost-allocations`, {
      amount: "100.00", currency: "TRY", description: "Ortak kargo", reason: "test",
    });
    expect(denied.status).toBe(403); // rd rolünde cost.manage yok
    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/rd-projects/${projectId}/cost-allocations`, {
      amount: "100.00", currency: "TRY", description: "Ortak sarf malzeme kargo bedeli — 3 projeye bölüştürüldü", sourceRef: "AP-000099", reason: "Eylül ortak kargo faturası, eşit bölüştürüldü",
    }));
    const detail = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/rd-projects/${projectId}`));
    expect(detail.allocations).toHaveLength(1);
    const spend = detail.spendByCurrency.find((s: any) => s.currency === "TRY");
    expect(spend).toMatchObject({ orderedAmount: "60.00", allocatedAmount: "100.00", total: "160.00" });
    expect(detail.budgetStatus).toMatchObject({ spent: "160.00", remaining: "840.00" });
  });

  it("yönetici raporu: bütçeli açık proje harcaması artık gerçek veriden hesaplanır (insufficient_data değil)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const g = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/reports/generate", { periodKind: "weekly", from: today, to: today }));
    const pb = g.findings.find((f: any) => f.area === "project_budget");
    expect(pb.causeType).toBe("hypothesis");
    const detail = expectOk(await call(w.app, "manager@a.test", A, "GET", `/api/reports/findings/${pb.id}`));
    expect(detail.finding).toContain("PRJ-");
  });

  it("proje kapatılınca yeni malzeme talebi ve gider paylaşımı reddedilir; tekrar kapatma reddedilir; kapalı proje bütçe raporundan düşer", async () => {
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/close`, { reason: "Pilot tamamlandı" }));
    const again = await call(w.app, "rd@a.test", A, "POST", `/api/rd-projects/${projectId}/close`, { reason: "tekrar" });
    expect(again.body.error.code).toBe("already_closed");
    const req = await call(w.app, "rd@a.test", A, "POST", "/api/purchase-requests", { itemId: itemNoStock, qty: "1", note: "Kapalı projede talep", projectId });
    expect(req.body.error.code).toBe("project_closed");
    const alloc = await call(w.app, "accounting@a.test", A, "POST", `/api/rd-projects/${projectId}/cost-allocations`, { amount: "10.00", currency: "TRY", description: "kapalı proje denemesi", reason: "kapalı proje denemesi" });
    expect(alloc.body.error.code).toBe("project_closed");

    const today = new Date().toISOString().slice(0, 10);
    const g = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/reports/generate", { periodKind: "weekly", from: today, to: today }));
    const pb = g.findings.find((f: any) => f.area === "project_budget");
    expect(pb.causeType).toBe("insufficient_data"); // kapalı projede artık açık/bütçeli proje yok
  });
});
