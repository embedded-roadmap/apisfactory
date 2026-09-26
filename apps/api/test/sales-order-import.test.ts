/**
 * Oturum 39 devamı (W39 devamı — tarihsel veri geçişi): açık satış siparişi içe aktarımı.
 * Canlı sipariş oluşturma akışından (POST /api/sales-orders + confirm) bilinçli olarak farklı:
 * bu, geçmişten taşınan siparişleri doğrudan kaydeder — rezervasyon/üretim ihtiyacı/satın alma talebi
 * HİÇBİR ŞEKİLDE otomatik oluşturulmaz. Bu testler hem doğru veri geçişini hem de bu "hiçbir yan etki
 * yok" garantisinin gerçekten tutulduğunu (reservations/production_needs tablolarına satır düşmediğini)
 * doğrular.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let productId: string;
let revDraftA: string;
let revReleasedA: string;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;

  const p = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "SO-IMP-1", name: "İçe aktarım test ürünü" }));
  productId = p.id;
  revDraftA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A" })).id;
  revReleasedA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "B" })).id;
  // Handover akışını çalıştırmadan, yalnızca "yayımlanmış revizyon otomatik seçilir" testi için doğrudan işaretlendi.
  await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
  await w.owner.query(`update product_revisions set status = 'released', released_at = now() where id = $1`, [revReleasedA]);

  expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "SOI-CUST-1", name: "Geçiş Müşterisi 1" }));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

const M = {
  orderCode: "sipariş",
  customerCode: "musteri",
  productCode: "urun",
  rev: "rev",
  qty: "miktar",
  unitPrice: "fiyat",
  requestedDate: "tarih",
  status: "durum",
};

describe("Açık satış siparişi içe aktarımı (W39 devamı — tarihsel geçiş)", () => {
  it("yetkisiz rol önizleyemez", async () => {
    const r = await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/sales-orders/preview", {
      fileName: "so.csv",
      content: "sipariş,musteri,urun,rev,miktar,fiyat,tarih,durum\nHIST-1,SOI-CUST-1,SO-IMP-1,B,10,100,2026-01-15,firm",
      mapping: M,
    });
    expect(r.status).toBe(403);
  });

  it("çok satırlı sipariş gruplanır, revizyon verilmezse yayımlanmış revizyon otomatik seçilir, hiçbir rezervasyon/üretim ihtiyacı/satın alma talebi oluşmaz", async () => {
    const csv = [
      "sipariş,musteri,urun,rev,miktar,fiyat,tarih,durum",
      "HIST-1,SOI-CUST-1,SO-IMP-1,B,10,100.50,2026-01-15,firm",
      "HIST-1,SOI-CUST-1,SO-IMP-1,,5,,2026-01-15,firm", // rev boş → yayımlanmış (B) otomatik seçilir
    ].join("\n");
    const p = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/imports/sales-orders/preview", { fileName: "so1.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 2, ok: 2, errors: 0 });
    expect(p.rows[1].values.productRevisionId).toBe(revReleasedA);

    const before = await w.owner.query(`select count(*)::int n from reservations`);
    const beforeNeeds = await w.owner.query(`select count(*)::int n from production_needs`);
    const beforePr = await w.owner.query(`select count(*)::int n from purchase_requests`);

    const committed = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ orders: 1, lines: 2 });

    const after = await w.owner.query(`select count(*)::int n from reservations`);
    const afterNeeds = await w.owner.query(`select count(*)::int n from production_needs`);
    const afterPr = await w.owner.query(`select count(*)::int n from purchase_requests`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(afterNeeds.rows[0].n).toBe(beforeNeeds.rows[0].n);
    expect(afterPr.rows[0].n).toBe(beforePr.rows[0].n);

    const order = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/sales-orders"));
    const hist1 = order.find((o: any) => o.code === "HIST-1");
    expect(hist1).toMatchObject({ status: "firm", customerName: "Geçiş Müşterisi 1" });

    const detail = expectOk(await call(w.app, "sales@a.test", A, "GET", `/api/sales-orders/${hist1.id}`));
    expect(detail.lines).toHaveLength(2);
    // Tarihsel geçişte uygunluk hesaplanmaz — confirmResult uydurulmaz, null kalır.
    expect(detail.confirmResult).toBeNull();
  });

  it("sipariş kodu boşsa her satır kendi kodunda ayrı sipariş olur", async () => {
    const csv = [
      "sipariş,musteri,urun,rev,miktar,fiyat,tarih,durum",
      ",SOI-CUST-1,SO-IMP-1,B,3,,2026-02-01,firm",
      ",SOI-CUST-1,SO-IMP-1,B,4,,2026-02-02,firm",
    ].join("\n");
    const p = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/imports/sales-orders/preview", { fileName: "so2.csv", content: csv, mapping: M }));
    const committed = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ orders: 2, lines: 2 });
  });

  it("hatalı satırlar (bilinmeyen müşteri/ürün, geçersiz miktar/tarih/durum, mükerrer sipariş kodu) onayı engeller", async () => {
    const csv = [
      "sipariş,musteri,urun,rev,miktar,fiyat,tarih,durum",
      "HIST-BAD-1,YOK-MUSTERI,SO-IMP-1,B,10,,2026-01-15,firm",
      "HIST-BAD-2,SOI-CUST-1,YOK-URUN,B,10,,2026-01-15,firm",
      "HIST-BAD-3,SOI-CUST-1,SO-IMP-1,B,0,,2026-01-15,firm",
      "HIST-BAD-4,SOI-CUST-1,SO-IMP-1,B,10,,gecersiz-tarih,firm",
      "HIST-BAD-5,SOI-CUST-1,SO-IMP-1,B,10,,2026-01-15,gonderildi",
      "HIST-1,SOI-CUST-1,SO-IMP-1,B,1,,2026-01-15,firm", // ilk testte zaten kullanılmış sipariş kodu
    ].join("\n");
    const p = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/imports/sales-orders/preview", { fileName: "so3.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 6, ok: 0, errors: 6 });
    expect(p.rows[0].messages).toEqual(expect.arrayContaining([expect.stringContaining("Müşteri bulunamadı")]));
    expect(p.rows[1].messages).toEqual(expect.arrayContaining([expect.stringContaining("Ürün bulunamadı")]));
    expect(p.rows[2].messages).toEqual(expect.arrayContaining([expect.stringContaining("Miktar geçersiz")]));
    expect(p.rows[3].messages).toEqual(expect.arrayContaining([expect.stringContaining("tarih geçersiz")]));
    expect(p.rows[4].messages).toEqual(expect.arrayContaining([expect.stringContaining('"draft" veya "firm"')]));
    expect(p.rows[5].messages).toEqual(expect.arrayContaining([expect.stringContaining("zaten kullanımda")]));

    const commit = await call(w.app, "sales@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {});
    expect(commit.status).toBe(409);
    expect(commit.body.error.code).toBe("import_has_errors");
  });

  it("uzlaşma: kaynak satır sayısı = onaylanan siparişlerin toplam kalem sayısı", async () => {
    const jobs = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/imports"));
    const so1 = jobs.find((j: any) => j.fileName === "so1.csv");
    expect(so1.reconciliation).toMatchObject({ sourceRows: 2, targetRows: 2, matched: true });
  });
});
