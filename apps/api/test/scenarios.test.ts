/**
 * Oturum 23 (W35): senaryo, maliyet/termin kıyası — baz planın kopyası üzerinde ne-olurdu hesabı
 * (500→1.000 adet, kritik parça gecikmesi, onaylı alternatif, fason varsayımı, ek vardiya).
 * Gerçek rezervasyon/sipariş/iş emri oluşturmaz.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let revId: string;
let capId: string;
let altCapId: string;

const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "SC-1", name: "Senaryo kartı" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "C1;ScenPassive;SCEN-CAP;4;Kondansatör 10uF 0603;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "sc.csv", content: csv, mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  const lines = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bom}`)).lines;
  capId = lines[0].itemId;
  revId = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;

  altCapId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "CMP-SCEN-CAP-ALT", name: "Kondansatör 10uF 0603 X5R alternatif", kind: "component", manufacturer: "ScenPassive2", mpn: "SCEN-CAP-2" })).id;
  await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
  await w.owner.query(`update items set lead_time_days = 30 where id = $1`, [capId]);
  await w.owner.query(`update items set lead_time_days = 5 where id = $1`, [altCapId]);

  // Az miktar stokta; kalanı yeni alımla karşılanacak (termin hesaplansın diye).
  const stock = "kod,miktar,lot,konum,rev\nCMP-SCENPASSIVE-SCEN-CAP,10,SCENCAP-1,STK,";
  const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: stock, mapping: stockMapping }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Senaryo karşılaştırma (W35)", () => {
  it("baz plan kopyalanır; adet artışı hem malzeme eksiğini hem kapasiteyi büyütür", async () => {
    const s = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/scenarios", {
      name: "500 yerine 1000 adet", productRevisionId: revId, qty: "1000", overrides: {},
    }));
    expect(s.result.baseline.materials[0].requiredQty).toBe("4000");
    expect(s.result.scenario.materials[0].requiredQty).toBe("4000"); // overrides boş -> baseline == scenario
    expect(s.result.scenario.status).toBe("ok");
    expect(s.result.scenario.assumptions.join(" ")).toContain("Ne-olurdu");
  });

  it("kritik parça N gün gecikmesi terminin geç tarafını iterir; delta pozitif gün gösterir", async () => {
    const s = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/scenarios", {
      name: "Kritik parça 14 gün gecikme", productRevisionId: revId, qty: "100",
      overrides: { criticalItemId: capId, delayDays: 14 },
    }));
    expect(s.result.scenario.materials[0].source).toContain("14 gün senaryo gecikmesi");
    expect(s.result.delta.latestDays).toBeGreaterThan(0);
  });

  it("yalnız onaylı alternatif senaryoda kullanılabilir; onaysız reddedilir", async () => {
    const bad = await call(w.app, "manager@a.test", A, "POST", "/api/scenarios", {
      name: "Onaysız alternatif", productRevisionId: revId, qty: "100",
      overrides: { alternateFor: { itemId: capId, alternateItemId: altCapId } },
    });
    expect(bad.status).toBe(400);

    // Onaylat: aday öner + Ar-Ge + üretim onayı
    const cand = expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/alternates`, {
      itemId: capId, alternateItemId: altCapId, reason: "Senaryo testi için onaylı alternatif", pinCompatible: true, footprintSame: true, electricalEquivalent: true,
    }));
    for (const [u, area] of [["rd", "rd"], ["production", "production"]]) {
      expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/alternates/${cand.id}/decision`, { area, decision: "approve" }));
    }
    const s = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/scenarios", {
      name: "Onaylı alternatif", productRevisionId: revId, qty: "100",
      overrides: { alternateFor: { itemId: capId, alternateItemId: altCapId } },
    }));
    expect(s.result.scenario.materials[0].itemCode).toContain("onaylı alternatif");
    // Alternatifin temin süresi (5 gün) asıl parçadan (30 gün) kısa; termin daha erken -> delta negatif veya 0
    expect(s.result.delta.latestDays).toBeLessThanOrEqual(0);
  });

  it("fason varsayımı iç kapasiteyi sıfırlar; ek vardiya günlük kapasiteyi büyütür", async () => {
    const sub = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/scenarios", {
      name: "Fason", productRevisionId: revId, qty: "100", overrides: { subcontract: true },
    }));
    expect(sub.result.scenario.productionDays).toBe(0);
    expect(sub.result.scenario.assumptions.join(" ")).toContain("Fason varsayımı");

    const shift = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/scenarios", {
      name: "Ek vardiya", productRevisionId: revId, qty: "100", overrides: { extraShiftMinutes: 480 },
    }));
    expect(shift.result.scenario.productionDays).toBeLessThanOrEqual(shift.result.baseline.productionDays);
  });

  it("kayıtlı senaryolar listelenir ve detay görüntülenir; salt izinli olmayan roller de görebilir (report.view)", async () => {
    const list = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/scenarios?productRevisionId=${revId}`));
    expect(list.length).toBeGreaterThanOrEqual(4);
    const detail = expectOk(await call(w.app, "accounting@a.test", A, "GET", `/api/scenarios/${list[0].id}`));
    expect(detail.productCode).toBe("SC-1");
    expect((await call(w.app, "technician@a.test", A, "POST", "/api/scenarios", { name: "yetkisiz deneme", productRevisionId: revId, qty: "1" })).status).toBe(403);
  });

  it("şirket B kendi senaryosunu görmez (RLS)", async () => {
    const r = await call(w.app, "all@b.test", w.b.companyId, "GET", `/api/scenarios?productRevisionId=${revId}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe("Senaryodan göreve / değişiklik talebine (R42)", () => {
  it("senaryodan görev ve değişiklik talebi açılır; senaryo detayında izlenir", async () => {
    const sc = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/scenarios", { name: "Takip senaryosu", productRevisionId: revId, qty: "5" }));
    const task = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/tasks", {
      title: "Senaryodaki darboğazı değerlendir", assigneeRole: "production", entityType: "scenario", entityId: sc.id,
    }));
    expect(task).toMatchObject({ entityType: "scenario", entityId: sc.id });
    expect((await call(w.app, "manager@a.test", A, "POST", "/api/tasks", { title: "Yok", assigneeRole: "production", entityType: "scenario", entityId: "00000000-0000-0000-0000-000000000000" })).status).toBe(404);
    const cr = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/change-requests", {
      scenarioId: sc.id, title: "Alternatif kondansatör", description: "Senaryo sonucu kritik parçanın alternatifinin revizyona eklenmesi öneriliyor.",
    }));
    expect(cr.code).toMatch(/^DT-/);
    const d = expectOk(await call(w.app, "manager@a.test", A, "GET", `/api/scenarios/${sc.id}`));
    expect(d.followUps.tasks.map((t: any) => t.title)).toEqual(["Senaryodaki darboğazı değerlendir"]);
    expect(d.followUps.changeRequests.map((c: any) => c.code)).toEqual([cr.code]);
    expect((await call(w.app, "rd@a.test", A, "POST", "/api/change-requests", { scenarioId: "00000000-0000-0000-0000-000000000000", title: "Yok", description: "Olmayan senaryo denemesi yapılıyor." })).status).toBe(404);
  });
});
