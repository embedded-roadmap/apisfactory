/**
 * Oturum 39 devamı (W39 devamı — tarihsel veri geçişi): tarihsel üretim (iş emri) içe aktarımı.
 * Canlı akıştan (planla → yayımla → seri üret → operasyon → test → kalite kapısı → serbest bırak)
 * bilinçli olarak farklı: operasyon/malzeme çıkışı/cihaz bazlı test geçmişi HİÇBİR ŞEKİLDE
 * uydurulmaz — yalnızca bilinen gerçek toplamlar (sağlam/hurda adet, tamamlanma tarihi, varsa
 * verilen birim maliyet) kaydedilir. Bu testler hem doğru veri geçişini hem de maliyet motorunun
 * bu ayrımı (migrated) doğru koruduğunu doğrular.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let productCode: string;

const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const M = { woCode: "isemrikodu", productCode: "urunkodu", rev: "rev", qtyGood: "saglam", qtyScrap: "hurda", completedDate: "tamamlanma", unitCost: "birimmaliyet", currency: "kur" };

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  productCode = "WOIMP-1";
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: productCode, name: "Geçiş iş emri ürünü" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;WoImpSemi;WOI-MCU;1;MCU;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "wo.csv", content: csv, mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  const revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revA}/handover`, { area, decision: "approve" }));
  }
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Tarihsel üretim (iş emri) içe aktarımı (W39 devamı — tarihsel geçiş)", () => {
  it("yetkisiz rol önizleyemez", async () => {
    const r = await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/work-orders/preview", {
      fileName: "wo1.csv",
      content: "isemrikodu,urunkodu,rev,saglam,hurda,tamamlanma,birimmaliyet,kur\nWOI-1,WOIMP-1,A,10,2,2026-01-10,5.50,TRY",
      mapping: M,
    });
    expect(r.status).toBe(403);
  });

  it("geçerli iş emri doğrudan tamamlandı olarak kaydedilir; sağlam adet bitmiş ürün lotuna girer, hurda adet stok etkisi yaratmaz, migrated=true işaretlenir", async () => {
    const csv = ["isemrikodu,urunkodu,rev,saglam,hurda,tamamlanma,birimmaliyet,kur", "WOI-TEST-1,WOIMP-1,A,10,2,2026-01-10,5.50,TRY"].join("\n");
    const p = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/imports/work-orders/preview", { fileName: "wo2.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 1, ok: 1, errors: 0 });

    const committed = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ workOrders: 1, devices: 12 });

    const list = expectOk(await call(w.app, "production@a.test", A, "GET", "/api/work-orders"));
    const wo = list.find((x: any) => x.code === "WOI-TEST-1");
    expect(wo).toMatchObject({ status: "completed", qty: "12.000000", released: 10, scrapped: 2 });

    const detail = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/work-orders/${wo.id}`));
    expect(detail.migrated).toBe(true);
    expect(detail.operations).toHaveLength(0);
    expect(detail.devices).toHaveLength(12);
    expect(detail.devices.filter((d: any) => d.status === "released")).toHaveLength(10);
    expect(detail.devices.filter((d: any) => d.status === "scrapped")).toHaveLength(2);

    // Bitmiş ürün lotu: sağlam adet kadar 'produce' hareketi, gerçek stok etkisi.
    const products = expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/products"));
    const itemId = products.find((x: any) => x.code === productCode).itemId;
    const bal = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/stock/balances?itemId=${itemId}`));
    const finishedBal = bal.find((b: any) => b.lotNo === "WOI-TEST-1");
    expect(finishedBal).toBeTruthy();
    expect(Number(finishedBal.qty)).toBe(10);

    // Verilen birim maliyet doğrudan lota kaydedilmiş olmalı (maliyet motorundan bağımsız).
    const lot = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/lots/lookup?code=WOI-TEST-1`))[0];
    const costs = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/lots/${lot.id}/costs`));
    expect(costs[0]).toMatchObject({ unitCost: "5.5", currency: "TRY", source: "production" });
    expect(costs[0].reference).toContain("tarihsel geçiş");
  });

  it("maliyet motoru tarihsel iş emri için birim maliyeti asla hesaplamaz (sıfır girdiden sahte 0 üretmez), eksik olarak işaretler", async () => {
    const list = expectOk(await call(w.app, "production@a.test", A, "GET", "/api/work-orders"));
    const wo = list.find((x: any) => x.code === "WOI-TEST-1");
    const run = expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/work-orders/${wo.id}/costs`, {}));
    expect(run.complete).toBe(false);
    expect(run.unitCost).toBeNull();
    expect(run.gaps.some((g: string) => g.includes("tarihsel geçişle"))).toBe(true);
  });

  it("yalnız hurda (sağlam adet 0) kaydedilebilir; bitmiş ürün lotu oluşmaz", async () => {
    const csv = ["isemrikodu,urunkodu,rev,saglam,hurda,tamamlanma,birimmaliyet,kur", "WOI-TEST-SCRAP,WOIMP-1,A,0,3,2026-01-11,,"].join("\n");
    const p = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/imports/work-orders/preview", { fileName: "wo3.csv", content: csv, mapping: M }));
    const committed = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ workOrders: 1, devices: 3 });
    const lot = await call(w.app, "production@a.test", A, "GET", `/api/lots/lookup?code=WOI-TEST-SCRAP`);
    expect(expectOk(lot)).toHaveLength(0);
  });

  it("iş emri kodu verilmezse otomatik üretilir (canlı akışla aynı IE sayacı, çakışma olmaz)", async () => {
    const csv = ["isemrikodu,urunkodu,rev,saglam,hurda,tamamlanma,birimmaliyet,kur", ",WOIMP-1,A,1,0,2026-01-12,,"].join("\n");
    const p = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/imports/work-orders/preview", { fileName: "wo4.csv", content: csv, mapping: M }));
    const committed = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {}));
    expect(committed).toMatchObject({ workOrders: 1, devices: 1 });
    const list = expectOk(await call(w.app, "production@a.test", A, "GET", "/api/work-orders"));
    expect(list.some((x: any) => x.code.startsWith("IE-"))).toBe(true);
  });

  it("hatalı satırlar (bilinmeyen ürün/revizyon, geçersiz adet/tarih/maliyet, sıfır toplam adet, mükerrer iş emri kodu) onayı engeller", async () => {
    const csv = [
      "isemrikodu,urunkodu,rev,saglam,hurda,tamamlanma,birimmaliyet,kur",
      "WOI-BAD-1,YOK-URUN,A,5,0,2026-01-10,,",
      "WOI-BAD-2,WOIMP-1,X,5,0,2026-01-10,,",
      "WOI-BAD-3,WOIMP-1,A,abc,0,2026-01-10,,",
      "WOI-BAD-4,WOIMP-1,A,0,0,2026-01-10,,",
      "WOI-BAD-5,WOIMP-1,A,5,0,gecersiz-tarih,,",
      "WOI-BAD-6,WOIMP-1,A,5,0,2026-01-10,-1,TRY",
      "WOI-TEST-1,WOIMP-1,A,5,0,2026-01-10,,", // ilk testte zaten kaydedilmiş iş emri kodu
    ].join("\n");
    const p = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/imports/work-orders/preview", { fileName: "wo5.csv", content: csv, mapping: M }));
    expect(p.summary).toMatchObject({ total: 7, ok: 0, errors: 7 });
    expect(p.rows[0].messages).toEqual(expect.arrayContaining([expect.stringContaining("Ürün bulunamadı")]));
    expect(p.rows[1].messages).toEqual(expect.arrayContaining([expect.stringContaining("Revizyon bulunamadı")]));
    expect(p.rows[2].messages).toEqual(expect.arrayContaining([expect.stringContaining("Sağlam adet geçersiz")]));
    expect(p.rows[3].messages).toEqual(expect.arrayContaining([expect.stringContaining("toplamı sıfırdan büyük olmalı")]));
    expect(p.rows[4].messages).toEqual(expect.arrayContaining([expect.stringContaining("Tamamlanma tarihi geçersiz")]));
    expect(p.rows[5].messages).toEqual(expect.arrayContaining([expect.stringContaining("Birim maliyet geçersiz")]));
    expect(p.rows[6].messages).toEqual(expect.arrayContaining([expect.stringContaining("zaten kullanımda")]));

    const commit = await call(w.app, "production@a.test", A, "POST", `/api/imports/${p.jobId}/commit`, {});
    expect(commit.status).toBe(409);
    expect(commit.body.error.code).toBe("import_has_errors");
  });

  it("uzlaşma: kaynak satır sayısı = oluşan iş emri sayısı", async () => {
    const jobs = expectOk(await call(w.app, "production@a.test", A, "GET", "/api/imports"));
    const wo2 = jobs.find((j: any) => j.fileName === "wo2.csv");
    expect(wo2.reconciliation).toMatchObject({ sourceRows: 1, targetRows: 1, matched: true });
  });
});
