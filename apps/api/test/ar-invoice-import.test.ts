/**
 * Oturum 39 devamı (W39 devamı — tarihsel veri geçişi): açık alacak (AR) fatura içe aktarımı.
 * Canlı fatura akışından (sevkiyattan taslak → kes) bilinçli olarak farklı: gerçek bir satış siparişi/
 * sevkiyat bağlantısı HİÇBİR ŞEKİLDE uydurulmaz — customer_invoices.sales_order_id bu göç için nullable
 * yapıldı (migration 039) ve migrated=true ile işaretlenir. Bu testler hem doğru veri geçişini hem de
 * bu dürüstlük garantisinin gerçekten tutulduğunu (sales_order_id/shipment_id'nin null kaldığını,
 * migrated bayrağının doğru set edildiğini) doğrular.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;

  expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "ARIMP-1", name: "Geçiş Müşterisi AR" }));
  const cust = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/customers"));
  const custId = cust.find((c: any) => c.code === "ARIMP-1").id;
  expectOk(
    await call(w.app, "accounting@a.test", A, "POST", `/api/customers/${custId}/credit`, {
      creditLimit: null,
      creditCurrency: "TRY",
      paymentTermsDays: 45,
      overdueBlockDays: null,
      reason: "İçe aktarım testi için ödeme vadesi",
    }),
  );
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

const M = {
  invoiceNo: "faturano",
  customerCode: "musteri",
  invoiceDate: "faturatarihi",
  dueDate: "vade",
  currency: "kur",
  netAmount: "net",
  taxAmount: "kdv",
  description: "aciklama",
  receivedAmount: "tahsil",
  receivedDate: "tahsiltarihi",
};

describe("Açık alacak (AR) fatura içe aktarımı (W39 devamı — tarihsel geçiş)", () => {
  it("yetkisiz rol önizleyemez", async () => {
    const r = await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/ar-invoices/preview", {
      fileName: "ar.csv",
      content: "faturano,musteri,faturatarihi,vade,kur,net,kdv,aciklama,tahsil,tahsiltarihi\nARIMP-1,ARIMP-1,2026-01-10,,,1000,180,Geçiş,,",
      mapping: M,
    });
    expect(r.status).toBe(403);
  });

  it("geçerli fatura doğrudan kesildi olarak kaydedilir, vade boşsa müşteri ödeme vadesinden hesaplanır, sipariş/sevkiyat bağlantısı uydurulmaz, migrated=true işaretlenir", async () => {
    const csv = [
      "faturano,musteri,faturatarihi,vade,kur,net,kdv,aciklama,tahsil,tahsiltarihi",
      "F-AR-1,ARIMP-1,2026-01-10,,,1000,180,Geçiş faturası,,",
    ].join("\n");
    const p = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/imports/ar-invoices/preview", { fileName: "ar1.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 1, ok: 1, errors: 0 });
    expect(p.rows[0].values.taxRate).toBe("18.00"); // 180/1000*100

    const committed = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ invoices: 1, receipts: 0 });

    const list = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/customer-invoices"));
    const inv = list.find((i: any) => i.code === "F-AR-1");
    expect(inv).toMatchObject({ status: "issued", currency: "TRY" });
    expect(inv.dueDate).toBe("2026-02-24"); // 2026-01-10 + 45 gün (müşteri ödeme vadesi)

    const detail = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/customer-invoices/${inv.id}`));
    expect(detail.migrated).toBe(true);
    expect(detail.salesOrderId).toBeNull();
    expect(detail.shipmentId).toBeNull();
    expect(detail.lines).toHaveLength(1);
  });

  it("tahsil edilen tutar tamamını karşılarsa fatura 'paid' olur ve tahsilat kaydı oluşur; kısmi tahsilat 'issued' kalır", async () => {
    const csv = [
      "faturano,musteri,faturatarihi,vade,kur,net,kdv,aciklama,tahsil,tahsiltarihi",
      "F-AR-FULLPAID,ARIMP-1,2026-01-05,2026-02-05,TRY,500,90,Tam tahsil,590,2026-02-01",
      "F-AR-PARTPAID,ARIMP-1,2026-01-06,2026-02-06,TRY,500,90,Kısmi tahsil,200,2026-02-01",
    ].join("\n");
    const p = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/imports/ar-invoices/preview", { fileName: "ar2.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 2, ok: 2, errors: 0 });
    const committed = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ invoices: 2, receipts: 2 });

    const list = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/customer-invoices"));
    const full = list.find((i: any) => i.code === "F-AR-FULLPAID");
    const part = list.find((i: any) => i.code === "F-AR-PARTPAID");
    expect(full.status).toBe("paid");
    expect(part.status).toBe("issued");
  });

  it("fatura no verilmezse otomatik üretilir (canlı 'kes' akışıyla aynı MF sayacı, çakışma olmaz)", async () => {
    const csv = ["faturano,musteri,faturatarihi,vade,kur,net,kdv,aciklama,tahsil,tahsiltarihi", ",ARIMP-1,2026-01-15,,,300,,,,"].join("\n");
    const p = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/imports/ar-invoices/preview", { fileName: "ar3.csv", content: csv, mapping: M }));
    const committed = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ invoices: 1, receipts: 0 });
    const list = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/customer-invoices"));
    expect(list.some((i: any) => i.code.startsWith("MF-"))).toBe(true);
  });

  it("hatalı satırlar (bilinmeyen müşteri, geçersiz tutar/tarih/kur, KDV oranı %100'ü aşan, tahsil edilen tutar verilip tahsilat tarihi verilmemesi, mükerrer fatura no) onayı engeller", async () => {
    const csv = [
      "faturano,musteri,faturatarihi,vade,kur,net,kdv,aciklama,tahsil,tahsiltarihi",
      "F-BAD-1,YOK-MUSTERI,2026-01-10,,,100,,,,",
      "F-BAD-2,ARIMP-1,2026-01-10,,,abc,,,,",
      "F-BAD-3,ARIMP-1,gecersiz-tarih,,,100,,,,",
      "F-BAD-4,ARIMP-1,2026-01-10,,,100,150,,,",
      "F-BAD-5,ARIMP-1,2026-01-10,,,100,,,50,",
      "F-AR-1,ARIMP-1,2026-01-10,,,100,,,,", // ilk testte zaten kaydedilmiş fatura no
    ].join("\n");
    const p = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/imports/ar-invoices/preview", { fileName: "ar4.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 6, ok: 0, errors: 6 });
    expect(p.rows[0].messages).toEqual(expect.arrayContaining([expect.stringContaining("Müşteri bulunamadı")]));
    expect(p.rows[1].messages).toEqual(expect.arrayContaining([expect.stringContaining("Net tutar geçersiz")]));
    expect(p.rows[2].messages).toEqual(expect.arrayContaining([expect.stringContaining("Fatura tarihi geçersiz")]));
    expect(p.rows[3].messages).toEqual(expect.arrayContaining([expect.stringContaining("KDV oranı")]));
    expect(p.rows[4].messages).toEqual(expect.arrayContaining([expect.stringContaining("tahsilat tarihi de gerekli")]));
    expect(p.rows[5].messages).toEqual(expect.arrayContaining([expect.stringContaining("zaten kullanımda")]));

    const commit = await call(w.app, "accounting@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {});
    expect(commit.status).toBe(409);
    expect(commit.body.error.code).toBe("import_has_errors");
  });

  it("uzlaşma: kaynak satır sayısı = oluşan fatura sayısı", async () => {
    const jobs = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/imports"));
    const ar1 = jobs.find((j: any) => j.fileName === "ar1.csv");
    expect(ar1.reconciliation).toMatchObject({ sourceRows: 1, targetRows: 1, matched: true });
  });
});
