/**
 * Oturum 39 devamı (W39 devamı — tarihsel veri geçişi): açık tedarikçi borcu (AP) fatura içe aktarımı.
 * Canlı fatura giriş akışından (POST /api/supplier-invoices) bilinçli olarak farklı: üç yönlü eşleştirme
 * (sipariş–mal kabul–fatura) HİÇBİR ŞEKİLDE çalıştırılmaz, hiçbir lot maliyeti yazılmaz. Bu testler hem
 * doğru veri geçişini hem de bu "hiçbir yan etki yok" garantisinin gerçekten tutulduğunu (lot_costs
 * tablosuna satır düşmediğini, match_result'ın uydurulmadığını) doğrular.
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

  expectOk(
    await call(w.app, "purchasing@a.test", A, "POST", "/api/suppliers", {
      code: "APIMP-1",
      name: "Geçiş Tedarikçisi 1",
      paymentTermsDays: 45,
    }),
  );
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

const M = {
  supplierCode: "tedarikci",
  invoiceNo: "faturano",
  invoiceDate: "faturatarihi",
  dueDate: "vade",
  currency: "kur",
  netAmount: "net",
  taxAmount: "kdv",
  description: "aciklama",
  paidAmount: "odenen",
  paidDate: "odemetarihi",
};

describe("Açık tedarikçi borcu (AP) fatura içe aktarımı (W39 devamı — tarihsel geçiş)", () => {
  it("yetkisiz rol önizleyemez", async () => {
    const r = await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/ap-invoices/preview", {
      fileName: "ap.csv",
      content: "tedarikci,faturano,faturatarihi,vade,kur,net,kdv,aciklama,odenen,odemetarihi\nAPIMP-1,F-1,2026-01-10,,,1000,180,Geçiş,,",
      mapping: M,
    });
    expect(r.status).toBe(403);
  });

  it("geçerli fatura doğrudan onaylı kaydedilir, vade boşsa tedarikçi ödeme vadesinden hesaplanır, üç yönlü eşleştirme çalıştırılmaz ve lot maliyeti yazılmaz", async () => {
    const csv = [
      "tedarikci,faturano,faturatarihi,vade,kur,net,kdv,aciklama,odenen,odemetarihi",
      "APIMP-1,F-1,2026-01-10,,,1000,180,Geçiş faturası,,",
    ].join("\n");
    const p = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/imports/ap-invoices/preview", { fileName: "ap1.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 1, ok: 1, errors: 0 });

    const beforeLotCosts = await w.owner.query(`select count(*)::int n from lot_costs`);

    const committed = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ invoices: 1, payments: 0 });

    const afterLotCosts = await w.owner.query(`select count(*)::int n from lot_costs`);
    expect(afterLotCosts.rows[0].n).toBe(beforeLotCosts.rows[0].n);

    const list = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/supplier-invoices"));
    const inv = list.find((i: any) => i.invoiceNo === "F-1");
    expect(inv).toMatchObject({ status: "approved", currency: "TRY" });
    expect(inv.dueDate).toBe("2026-02-24"); // 2026-01-10 + 45 gün (tedarikçi ödeme vadesi)

    const detail = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/supplier-invoices/${inv.id}`));
    expect(detail.matchResult).toMatchObject({ migrated: true });
    expect(detail.lines).toHaveLength(1);
  });

  it("ödenen tutar tamamını karşılarsa fatura 'paid' olur ve ödeme kaydı oluşur; kısmi ödeme 'approved' kalır", async () => {
    const csv = [
      "tedarikci,faturano,faturatarihi,vade,kur,net,kdv,aciklama,odenen,odemetarihi",
      "APIMP-1,F-FULLPAID,2026-01-05,2026-02-05,TRY,500,90,Tam ödenmiş,590,2026-02-01",
      "APIMP-1,F-PARTPAID,2026-01-06,2026-02-06,TRY,500,90,Kısmi ödenmiş,200,2026-02-01",
    ].join("\n");
    const p = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/imports/ap-invoices/preview", { fileName: "ap2.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 2, ok: 2, errors: 0 });
    const committed = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ invoices: 2, payments: 2 });

    const list = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/supplier-invoices"));
    const full = list.find((i: any) => i.invoiceNo === "F-FULLPAID");
    const part = list.find((i: any) => i.invoiceNo === "F-PARTPAID");
    expect(full.status).toBe("paid");
    expect(part.status).toBe("approved");
  });

  it("hatalı satırlar (bilinmeyen tedarikçi, geçersiz tutar/tarih/kur, ödenen tutar verilip ödeme tarihi verilmemesi, mükerrer fatura) onayı engeller", async () => {
    const csv = [
      "tedarikci,faturano,faturatarihi,vade,kur,net,kdv,aciklama,odenen,odemetarihi",
      "YOK-TEDARIKCI,F-BAD-1,2026-01-10,,,100,,,,",
      "APIMP-1,F-BAD-2,2026-01-10,,,abc,,,,",
      "APIMP-1,F-BAD-3,gecersiz-tarih,,,100,,,,",
      "APIMP-1,F-BAD-4,2026-01-10,,,100,,,50,",
      "APIMP-1,F-1,2026-01-10,,,100,,,,", // ilk testte zaten kaydedilmiş fatura no
    ].join("\n");
    const p = expectOk(await call(w.app, "accounting@a.test", A, "POST", "/api/imports/ap-invoices/preview", { fileName: "ap3.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 5, ok: 0, errors: 5 });
    expect(p.rows[0].messages).toEqual(expect.arrayContaining([expect.stringContaining("Tedarikçi bulunamadı")]));
    expect(p.rows[1].messages).toEqual(expect.arrayContaining([expect.stringContaining("Net tutar geçersiz")]));
    expect(p.rows[2].messages).toEqual(expect.arrayContaining([expect.stringContaining("Fatura tarihi geçersiz")]));
    expect(p.rows[3].messages).toEqual(expect.arrayContaining([expect.stringContaining("ödeme tarihi de gerekli")]));
    expect(p.rows[4].messages).toEqual(expect.arrayContaining([expect.stringContaining("zaten kayıtlı")]));

    const commit = await call(w.app, "accounting@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {});
    expect(commit.status).toBe(409);
    expect(commit.body.error.code).toBe("import_has_errors");
  });

  it("uzlaşma: kaynak satır sayısı = oluşan fatura sayısı", async () => {
    const jobs = expectOk(await call(w.app, "accounting@a.test", A, "GET", "/api/imports"));
    const ap1 = jobs.find((j: any) => j.fileName === "ap1.csv");
    expect(ap1.reconciliation).toMatchObject({ sourceRows: 1, targetRows: 1, matched: true });
  });
});
