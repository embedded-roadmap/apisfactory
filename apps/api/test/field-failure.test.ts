/**
 * R44: saha arızasının seri/lot/revizyona bağlanması. `rmas.kind = 'field_failure'` şemada
 * 011_returns.sql'den beri vardı ama akış hiçbir zaman ayrışmamıştı — her iade fiziksel teslim
 * alma ve fiziksel stok hareketi üreten kararlar üzerinden zorunlu geçiyordu. Bu, saha arızasında
 * (cihaz müşteride kalır, fiziksel olarak geri gelmez) UYDURMA bir depo hareketi anlamına gelirdi.
 * Bu testler 043_field_failure.sql + returns.ts'deki düzeltmeyi doğrular: saha arızası receive
 * adımını atlar, doğrudan inceleme yapılır, karar yalnızca "kayda geçti, işlem yok" veya
 * "gerçek iadeye yükselt" olabilir — hiçbiri stok/cihaz hareketi üretmez (yükseltme, yeni ve ayrı
 * bir fiziksel 'return' kaydı açar).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let revA: string;
let fgItem: string;
let c1: string;
let serials: string[] = [];
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
const ALL = { box: true, accessories: true, label: true, inspection: true };
const W = "warehouse@a.test";
const S = "sales@a.test";
const Q = "quality@a.test";

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;

  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "FF-1", name: "FF-1" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "ff.csv", content: `Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;MCU-FF;1;MCU;`, mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  const rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "rd", decision: "approve" }));
  expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${rev}/handover`, { area: "production", decision: "approve" }));
  expectOk(await call(w.app, Q, A, "POST", `/api/revisions/${rev}/handover`, { area: "quality", decision: "approve" }));
  revA = rev;

  c1 = expectOk(await call(w.app, S, A, "POST", "/api/customers", { code: "FF-C1", name: "Saha Müşterisi" })).id;
  expectOk(await call(w.app, S, A, "POST", `/api/customers/${c1}/addresses`, { label: "Merkez", recipient: "Teslim Alan", line1: "Sanayi Cad. 1", city: "İstanbul" }));

  const p = await call(w.app, W, A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: "kod,miktar,lot,konum,rev\nCMP-TESTSEMI-MCU-FF,10,MFF-1,STK,", mapping: stockMapping });
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${p.body.jobId}/commit`, {}));

  const wo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: revA, qty: "3" }));
  const rel = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo.id}/release`));
  serials = rel.devices.map((d: any) => d.serial);
  const mr = expectOk(await call(w.app, W, A, "GET", "/api/lots/lookup?code=MFF-1"))[0].id;
  expectOk(await call(w.app, W, A, "POST", `/api/work-orders/${wo.id}/issue`, { lotId: mr, qty: "3" }));
  for (const op of rel.operations.slice(0, 5)) {
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/start`));
    if (op.isQualityGate) for (const s of serials) expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/devices/${s}/test`, { result: "pass" }));
    expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`));
  }
  expectOk(await call(w.app, Q, A, "POST", `/api/work-orders/${wo.id}/release-to-stock`));
  fgItem = expectOk(await call(w.app, W, A, "GET", `/api/lots/lookup?code=${wo.code}`))[0].itemId;

  const o = expectOk(await call(w.app, S, A, "POST", "/api/sales-orders", { customerId: c1, requestedDate: "2026-12-01", lines: [{ productRevisionId: revA, qty: "3" }] }));
  expectOk(await call(w.app, S, A, "POST", `/api/sales-orders/${o.id}/confirm`));
  const sh = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o.id}/shipments`, { lines: [{ lineId: o.lines[0].id, qty: "3" }] }));
  for (const s of serials) expectOk(await call(w.app, W, A, "POST", `/api/packages/${sh.packages[0].id}/items`, { code: s }));
  expectOk(await call(w.app, W, A, "POST", `/api/packages/${sh.packages[0].id}/close`, { checklist: ALL }));
  expectOk(await call(w.app, W, A, "POST", `/api/shipments/${sh.id}/pack-complete`));
  expectOk(await call(w.app, W, A, "POST", `/api/shipments/${sh.id}/ship`, { carrier: "Test kargo" }));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

const avail = async (itemId: string) => expectOk(await call(w.app, W, A, "GET", `/api/stock/availability/${itemId}`));
const deviceStatus = async (serial: string) => expectOk(await call(w.app, Q, A, "GET", `/api/devices/${serial}`)).status;

describe("Saha arızası (field_failure) — fiziksel hareket üretmeyen akış (R44)", () => {
  it("saha arızası açılınca teslim alma görevi değil, doğrudan kaliteye inceleme görevi düşer", async () => {
    const r = expectOk(await call(w.app, S, A, "POST", "/api/rmas", { code: serials[0], kind: "field_failure", complaint: "Cihaz sahada aralıklı olarak resetleniyor" }));
    expect(r.status).toBe("open");
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    const tasks = await w.owner.query(`select kind, assignee_role from tasks where entity_type = 'rma' and entity_id = $1`, [r.id]);
    expect(tasks.rows).toEqual([{ kind: "rma_inspect", assignee_role: "quality" }]);
  });

  it("saha arızasında fiziksel teslim alma adımı yok — cihaz müşteride kalır", async () => {
    const r = expectOk(await call(w.app, S, A, "POST", "/api/rmas", { code: serials[1], kind: "field_failure", complaint: "Ekran zaman zaman kararıyor" }));
    const recv = await call(w.app, W, A, "POST", `/api/rmas/${r.id}/receive`, {});
    expect(recv.body.error.code).toBe("not_applicable");
    expect(await deviceStatus(serials[1])).toBe("shipped"); // hâlâ müşteride, iade kabul alanına girmedi

    // İnceleme doğrudan "open"dan yapılabilir (teslim alma beklenmeden).
    const insp = expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/inspect`, { finding: "Yazılım kaynaklı görünüyor, uzaktan güncellemeyle çözüldü", cause: "firmware" }));
    expect(insp.status).toBe("inspected");

    // Fiziksel sonuçlar (tamir, değişim, hurda, stoğa al, olduğu gibi iade) saha arızasında yasak.
    for (const disposition of ["repair", "replace", "scrap", "restock", "return_as_is"]) {
      const d = await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition, note: "test" });
      expect(d.body.error.code).toBe("field_failure_disposition");
    }

    // "Kayda geçti, işlem yok": stok/cihaz hareketi olmadan kapanır.
    const before = await avail(fgItem);
    const dec = expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition: "logged_no_action", note: "Uzaktan çözüldü, işlem gerekmiyor" }));
    expect(dec.status).toBe("closed");
    expect(dec.escalatedRmaId ?? null).toBe(null);
    const after = await avail(fgItem);
    expect(after).toEqual(before);
    expect(await deviceStatus(serials[1])).toBe("shipped"); // hareket yok, cihaz hâlâ müşteride
  });

  it("normal (fiziksel) iadede 'kayda geçti'/'gerçek iadeye yükselt' seçilemez", async () => {
    const r = expectOk(await call(w.app, S, A, "POST", "/api/rmas", { code: serials[2], kind: "warranty", complaint: "Buton çalışmıyor" }));
    expectOk(await call(w.app, W, A, "POST", `/api/rmas/${r.id}/receive`, {}));
    expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/inspect`, { finding: "Buton temas sorunu", cause: "component" }));
    for (const disposition of ["logged_no_action", "escalated_to_rma"]) {
      const d = await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition, note: "test" });
      expect(d.body.error.code).toBe("field_failure_disposition");
    }
    // temizlik: normal akışla kapat
    expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${r.id}/decide`, { disposition: "scrap", note: "Hurda" }));
  });

  it("'gerçek iadeye yükselt': yeni bir fiziksel 'return' kaydı açar, orijinali ona bağlar ve kapatır", async () => {
    // serials[0]'a saha arızası daha önce açılmıştı (ilk testte) — o kaydı kullan.
    const before = expectOk(await call(w.app, S, A, "GET", `/api/rma-lookup?code=${serials[0]}`));
    expect(before).toBeTruthy();
    const list = expectOk(await call(w.app, S, A, "GET", "/api/rmas"));
    const original = list.find((x: any) => x.serial === serials[0] && x.kind === "field_failure");
    expect(original).toBeTruthy();

    expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${original.id}/inspect`, { finding: "Sahada tekrarlanamadı, cihazın gönderilmesi isteniyor", cause: "unknown" }));
    const dec = expectOk(await call(w.app, Q, A, "POST", `/api/rmas/${original.id}/decide`, { disposition: "escalated_to_rma", note: "Müşteri cihazı göndermeyi kabul etti" }));
    expect(dec.status).toBe("closed");
    expect(dec.escalatedRmaId).toBeTruthy();
    expect(dec.escalatedRmaCode).toMatch(/^IAD-/);

    const escalated = expectOk(await call(w.app, S, A, "GET", `/api/rmas/${dec.escalatedRmaId}`));
    expect(escalated).toMatchObject({ kind: "return", status: "open", customerId: c1, serial: serials[0] });

    // Yükseltilen kayıt artık gerçek, fiziksel bir iade — normal akışla (teslim alma dahil) devam eder.
    const recv = expectOk(await call(w.app, W, A, "POST", `/api/rmas/${dec.escalatedRmaId}/receive`, {}));
    expect(recv.status).toBe("received");
    expect(await deviceStatus(serials[0])).toBe("returned");
  });
});
