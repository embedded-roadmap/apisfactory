/**
 * Oturum 39 devamı (W39 devamı — tarihsel veri geçişi): açık satın alma siparişi içe aktarımı.
 * Canlı akıştan (RFQ → teklif karşılaştırma → award) bilinçli olarak farklı: RFQ/teklif/satın alma
 * talebi/tahsisat HİÇBİR ŞEKİLDE otomatik oluşturulmaz. Bu testler hem doğru veri geçişini hem de
 * "hiçbir yan etki yok" garantisinin gerçekten tutulduğunu (rfqs/purchase_requests/purchase_allocations
 * tablolarına satır düşmediğinin) doğrular; ayrıca sipariş durumunun (gönderildi/teyitli/kısmen teslim
 * alındı/teslim alındı) canlı sistemle AYNI türetme fonksiyonuyla (refreshPoStatus) doğru hesaplandığını
 * doğrular.
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

  expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/suppliers", { code: "POIMP-1", name: "Geçiş Tedarikçisi POI" }));
  expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "POIMP-CMP-1", name: "İçe aktarım test kalemi", kind: "component" }));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

const M = {
  poCode: "siparis",
  supplierCode: "tedarikci",
  itemCode: "kalem",
  qty: "miktar",
  qtyReceived: "alinan",
  unitPrice: "fiyat",
  currency: "kur",
  requestedDate: "istenen",
  confirmedDate: "teyit",
};

describe("Açık satın alma siparişi içe aktarımı (W39 devamı — tarihsel geçiş)", () => {
  it("yetkisiz rol önizleyemez", async () => {
    const r = await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/purchase-orders/preview", {
      fileName: "po.csv",
      content: "siparis,tedarikci,kalem,miktar,alinan,fiyat,kur,istenen,teyit\nHIST-1,POIMP-1,POIMP-CMP-1,10,,100,TRY,2026-01-15,",
      mapping: M,
    });
    expect(r.status).toBe(403);
  });

  it("çok satırlı sipariş gruplanır; hiçbir RFQ/talep/tahsisat oluşmaz; teyit/teslim verilmezse durum 'sent' kalır", async () => {
    const csv = [
      "siparis,tedarikci,kalem,miktar,alinan,fiyat,kur,istenen,teyit",
      "HIST-1,POIMP-1,POIMP-CMP-1,100,,10.50,TRY,2026-01-15,",
      "HIST-1,POIMP-1,POIMP-CMP-1,50,,,TRY,2026-01-20,",
    ].join("\n");
    const p = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/imports/purchase-orders/preview", { fileName: "po1.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 2, ok: 2, errors: 0 });

    const beforeRfq = await w.owner.query(`select count(*)::int n from rfqs`);
    const beforePr = await w.owner.query(`select count(*)::int n from purchase_requests`);
    const beforeAlloc = await w.owner.query(`select count(*)::int n from purchase_allocations`);

    const committed = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ orders: 1, lines: 2 });

    const afterRfq = await w.owner.query(`select count(*)::int n from rfqs`);
    const afterPr = await w.owner.query(`select count(*)::int n from purchase_requests`);
    const afterAlloc = await w.owner.query(`select count(*)::int n from purchase_allocations`);
    expect(afterRfq.rows[0].n).toBe(beforeRfq.rows[0].n);
    expect(afterPr.rows[0].n).toBe(beforePr.rows[0].n);
    expect(afterAlloc.rows[0].n).toBe(beforeAlloc.rows[0].n);

    const list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchase-orders"));
    const hist1 = list.find((o: any) => o.code === "HIST-1");
    expect(hist1).toMatchObject({ supplierName: "Geçiş Tedarikçisi POI", lines: 2 });

    const detail = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/purchase-orders/${hist1.id}`));
    expect(detail.status).toBe("sent"); // teyit/teslim verilmedi — canlı sistem gibi 'sent' ötesine geçmez
    expect(detail.lines).toHaveLength(2);
    expect(detail.sentAt).toBeNull(); // gerçekte ne zaman gönderildiği bilinmiyor — uydurulmaz
  });

  it("teyit tarihi ve tam teslim alınan miktar verilirse durum 'received' olarak türetilir (uydurulmaz, refreshPoStatus'tan gelir)", async () => {
    const csv = ["siparis,tedarikci,kalem,miktar,alinan,fiyat,kur,istenen,teyit", "HIST-RECV,POIMP-1,POIMP-CMP-1,20,20,,TRY,2026-01-10,2026-01-12"].join("\n");
    const p = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/imports/purchase-orders/preview", { fileName: "po2.csv", content: csv, mapping: M }));
    const committed = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ orders: 1, lines: 1 });
    const list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchase-orders"));
    const o = list.find((x: any) => x.code === "HIST-RECV");
    const detail = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/purchase-orders/${o.id}`));
    expect(detail.status).toBe("received");
    expect(detail.lines[0]).toMatchObject({ qtyOrdered: "20.000000", qtyReceived: "20.000000", confirmedDate: "2026-01-12" });
  });

  it("kısmi teslim alınan miktar verilirse durum 'partially_received' olur", async () => {
    const csv = ["siparis,tedarikci,kalem,miktar,alinan,fiyat,kur,istenen,teyit", "HIST-PART,POIMP-1,POIMP-CMP-1,20,8,,TRY,2026-01-10,"].join("\n");
    const p = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/imports/purchase-orders/preview", { fileName: "po3.csv", content: csv, mapping: M }));
    const committed = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ orders: 1, lines: 1 });
    const list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchase-orders"));
    const o = list.find((x: any) => x.code === "HIST-PART");
    const detail = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/purchase-orders/${o.id}`));
    expect(detail.status).toBe("partially_received");
  });

  it("sipariş kodu boşsa her satır kendi kodunda ayrı sipariş olur", async () => {
    const csv = [
      "siparis,tedarikci,kalem,miktar,alinan,fiyat,kur,istenen,teyit",
      ",POIMP-1,POIMP-CMP-1,5,,,TRY,2026-02-01,",
      ",POIMP-1,POIMP-CMP-1,7,,,TRY,2026-02-02,",
    ].join("\n");
    const p = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/imports/purchase-orders/preview", { fileName: "po4.csv", content: csv, mapping: M }));
    const committed = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ orders: 2, lines: 2 });
  });

  it("hatalı satırlar (bilinmeyen tedarikçi/kalem, geçersiz miktar/teslim/tarih/kur, mükerrer sipariş kodu, dosya içi farklı tedarikçi) onayı engeller", async () => {
    const csv = [
      "siparis,tedarikci,kalem,miktar,alinan,fiyat,kur,istenen,teyit",
      "HIST-BAD-1,YOK-TEDARIKCI,POIMP-CMP-1,10,,,TRY,2026-01-15,",
      "HIST-BAD-2,POIMP-1,YOK-KALEM,10,,,TRY,2026-01-15,",
      "HIST-BAD-3,POIMP-1,POIMP-CMP-1,0,,,TRY,2026-01-15,",
      "HIST-BAD-4,POIMP-1,POIMP-CMP-1,10,15,,TRY,2026-01-15,", // alınan > sipariş
      "HIST-BAD-5,POIMP-1,POIMP-CMP-1,10,,,TRY,gecersiz-tarih,",
      "HIST-BAD-6,POIMP-1,POIMP-CMP-1,10,,,XX,2026-01-15,",
      "HIST-1,POIMP-1,POIMP-CMP-1,1,,,TRY,2026-01-15,", // ilk testte zaten kullanılmış sipariş kodu
    ].join("\n");
    const p = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/imports/purchase-orders/preview", { fileName: "po5.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 7, ok: 0, errors: 7 });
    expect(p.rows[0].messages).toEqual(expect.arrayContaining([expect.stringContaining("Tedarikçi bulunamadı")]));
    expect(p.rows[1].messages).toEqual(expect.arrayContaining([expect.stringContaining("Kalem bulunamadı")]));
    expect(p.rows[2].messages).toEqual(expect.arrayContaining([expect.stringContaining("Miktar geçersiz")]));
    expect(p.rows[3].messages).toEqual(expect.arrayContaining([expect.stringContaining("sipariş miktarını")]));
    expect(p.rows[4].messages).toEqual(expect.arrayContaining([expect.stringContaining("İstenen tarih geçersiz")]));
    expect(p.rows[5].messages).toEqual(expect.arrayContaining([expect.stringContaining("Para birimi geçersiz")]));
    expect(p.rows[6].messages).toEqual(expect.arrayContaining([expect.stringContaining("zaten kullanımda")]));

    const commit = await call(w.app, "purchasing@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {});
    expect(commit.status).toBe(409);
    expect(commit.body.error.code).toBe("import_has_errors");
  });

  it("uzlaşma: kaynak satır sayısı = onaylanan siparişlerin toplam kalem sayısı", async () => {
    const jobs = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/imports"));
    const po1 = jobs.find((j: any) => j.fileName === "po1.csv");
    expect(po1.reconciliation).toMatchObject({ sourceRows: 2, targetRows: 2, matched: true });
  });
});
