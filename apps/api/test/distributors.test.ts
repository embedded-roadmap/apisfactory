/**
 * Oturum 16 (W17): distribütör bağlayıcıları — test modu (sentetik, işaretli), fiyat dosyası, önbellek ve kota,
 * fiyat alanı yetkisi, BOM tedarik görünümü, RFQ'ya otomatik teklif.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let revA: string;
let prId: string;
let mcu: string;
let bomId: string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const addDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "DS-1", name: "Distribütör kartı" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;PoSemi;MCU-P;1;MCU;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "p.csv", content: csv, mapping }));
  bomId = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bomId}/publish`));
  mcu = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bomId}`)).lines[0].itemId;
  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bomId })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${revA}/handover`, { area, decision: "approve" }));
  }
  const customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "C-DS", name: "Distribütör Müşterisi" })).id;
  const o = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", { customerId, requestedDate: addDays(30), lines: [{ productRevisionId: revA, qty: "100" }] }));
  expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o.id}/confirm`));
  const prs = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/purchase-requests"));
  prId = prs.find((p: any) => p.sourceType === "production_need").id;
  expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/purchase-requests/${prId}/decision`, { decision: "approve" }));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

const C: Record<string, any> = {};
let sup: string;

describe("Distribütör bağlayıcıları (W17)", () => {
  it("varsayılan olarak bağlı değil; teklif yok; yalnız tedarikçi yönetimi yetkisiyle mod değişir", async () => {
    const list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/distributors"));
    expect(list.map((c: any) => c.key)).toEqual(["digikey", "farnell", "lcsc", "mouser", "nexar"]);
    expect(list.every((c: any) => c.mode === "not_connected")).toBe(true);
    for (const c of list) C[c.key] = c;
    const none = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/items/${mcu}/offers`));
    expect(none).toMatchObject({ offers: [], connectorsActive: 0 });
    const rd = await call(w.app, "rd@a.test", A, "POST", `/api/distributors/${C.digikey.id}`, { mode: "test", reason: "deneme" });
    expect(rd.status).toBe(403);
    sup = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/suppliers", { code: "DK", name: "DigiKey (distribütör)" })).id;
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/distributors/${C.digikey.id}`, { mode: "test", supplierId: sup, dailyCallLimit: 2, reason: "Test kataloğuyla deneme" }));
    const integ = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/integrations"));
    expect(integ.find((i: any) => i.key === "digikey")).toMatchObject({ mode: "test" });
  });

  it("test teklifi deterministik ve işaretli; önbellekten gelir; kota dolunca önbellek + uyarı; fiyat yetkisi", async () => {
    const a = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/items/${mcu}/offers?qty=100`));
    const o = a.offers[0];
    expect(o).toMatchObject({ connector: "DigiKey", source: "test_connector", testData: true, stale: false, qty: 100 });
    expect(o.unitPrice).toBeGreaterThan(0);
    const b = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/items/${mcu}/offers?qty=100`));
    expect(b.offers[0].fetchedAt).toBe(o.fetchedAt); // önbellek
    expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/items/${mcu}/offers?refresh=1`)); // 2. çağrı
    const q = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/items/${mcu}/offers?refresh=1`));
    expect(q.warnings[0]).toContain("kota");
    expect(q.offers[0].breaks).toEqual(o.breaks); // deterministik
    const prod = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/items/${mcu}/offers`));
    expect(prod.offers[0]).toMatchObject({ unitPrice: null, breaks: [] });
    const list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/distributors"));
    expect(list.find((c: any) => c.key === "digikey")).toMatchObject({ callsToday: 2 });
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await expect(w.owner.query(`delete from connector_calls`)).rejects.toThrow(/append/i);
  });

  it("fiyat dosyası: gerçek liste yüklenir, hatalı satır raporlanır; mod dışı yüklenemez", async () => {
    const wrong = await call(w.app, "purchasing@a.test", A, "POST", `/api/distributors/${C.mouser.id}/price-file`, { content: "mpn;price_1\nX;1" });
    expect(wrong.body.error.code).toBe("wrong_mode");
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/distributors/${C.mouser.id}`, { mode: "price_file", currency: "EUR", reason: "Haftalık fiyat listesi" }));
    const csv = ["mpn;sku;stock;moq;lead_time_days;lifecycle;price_1;price_100", "MCU-P;595-MCUP;1200;1;5;nrnd;2,10;1,85", "BAD-1;x;1;1;1;active;abc;", "YOK-9;;;;;;0,50;"].join("\n");
    const r = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/distributors/${C.mouser.id}/price-file`, { fileName: "mouser_hafta39.csv", content: csv, decimal: "," }));
    expect(r).toMatchObject({ saved: 2, total: 3 });
    expect(r.errors[0]).toContain("price_1");
    const offers = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/items/${mcu}/offers?qty=150`));
    const m = offers.offers.find((x: any) => x.connectorKey === "mouser");
    expect(m).toMatchObject({ source: "price_file", testData: false, currency: "EUR", unitPrice: 1.85, lifecycle: "nrnd", stock: 1200 });
    expect(m.sourceRef).toContain("mouser_hafta39.csv");
  });

  it("BOM tedarik görünümü: ihtiyaç, en iyi teklif, yaşam döngüsü riski, para birimi bazında toplam", async () => {
    const s = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bomId}/sourcing?qty=150`));
    expect(s.lines).toHaveLength(1);
    const l = s.lines[0];
    expect(l).toMatchObject({ gross: 150, toBuy: 150 });
    expect(l.best).toBeTruthy();
    expect(l.risks).toContain("yaşam döngüsü: NRND");
  });

  it("RFQ'ya otomatik teklif: tedarikçiye bağlı bağlayıcıdan eklenir, elle girilen teklif korunur", async () => {
    const r = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/rfqs", { purchaseRequestId: prId }));
    const t = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${r.id}/auto-quotes`));
    expect(t.skipped.join(" ")).toContain("Mouser: tedarikçiye bağlı değil");
    expect(t.added).toEqual(["DigiKey"]);
    const q = expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/rfqs/${r.id}`));
    expect(q.quotes[0]).toMatchObject({ supplierCode: "DK", source: "test_connector" });
    expect(q.quotes[0].note).toContain("TEST VERİSİ");
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${r.id}/quotes`, { supplierId: sup, unitPrice: "9.99", currency: "USD", leadTimeDays: 5 }));
    const t2 = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/rfqs/${r.id}/auto-quotes`));
    expect(t2.skipped.join(" ")).toContain("elle girilmiş teklif korunuyor");
    expect(expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/rfqs/${r.id}`)).quotes[0].unitPrice).toBe("9.990000");
  });
});
