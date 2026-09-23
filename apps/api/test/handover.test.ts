/**
 * Oturum 11: devir politikası (şirket ayarı) — test planı, firmware (+SHA) ve yayımlanmış rota zorunluluğu,
 * gerekçeli muafiyet, inceleme sırasında sıkılaşan politika, yayımda saklanan kontrol listesi.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let productId: string;
let bomV1: string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };

async function newRevision(rev: string) {
  return expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev, bomVersionId: bomV1 })).id as string;
}
const submit = (id: string) => call(w.app, "rd@a.test", A, "POST", `/api/revisions/${id}/transition`, { action: "submit_handover" });
const approve = (u: string, id: string, area: string) => call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${id}/handover`, { area, decision: "approve" });

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "HV-1", name: "Devir kartı" })).id;
  const csv = ["Designator;Manufacturer;MPN;Quantity;Description;DNP", "U1;HvSemi;MCU-H;1;MCU;"].join("\n");
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "h.csv", content: csv, mapping }));
  bomV1 = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bomV1}/publish`));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Devir politikası", () => {
  it("politika yoksa yalnız BOM zorunlu; politika sürümlü ve yalnız akış yöneticisiyle", async () => {
    const r1 = await newRevision("A");
    const rd = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/revisions/${r1}/readiness`));
    expect(rd).toMatchObject({ policyVersion: null, ready: true });
    expect(rd.items.filter((i: any) => i.required).map((i: any) => i.key)).toEqual(["bom"]);
    const rdUser = await call(w.app, "rd@a.test", A, "POST", "/api/handover/policy", { requireTestPlan: true, requireFirmware: true, requireFirmwareSha: false, requireRouting: true, note: "deneme" });
    expect(rdUser.status).toBe(403);
    const bad = await call(w.app, "manager@a.test", A, "POST", "/api/handover/policy", { requireTestPlan: false, requireFirmware: false, requireFirmwareSha: true, requireRouting: false, note: "hatalı" });
    expect(bad.body.error.code).toBe("invalid_policy");
    const p = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/handover/policy", { requireTestPlan: true, requireFirmware: true, requireFirmwareSha: true, requireRouting: true, note: "Seri üretime eksik paketle geçilmez" }));
    expect(p.versionNo).toBe(1);
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await expect(w.owner.query(`update handover_policies set require_routing = false`)).rejects.toThrow(/append/i);
  });

  let revB: string;
  it("eksik madde devre göndermeyi engeller; ret olayı kalır; tamamlanınca gönderilir", async () => {
    revB = await newRevision("B");
    const blocked = await submit(revB);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("handover_requirements");
    expect(blocked.body.error.details.missing).toEqual(["test_plan", "firmware", "firmware_sha", "routing"]);
    const hist = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/history/product_revision/${revB}`));
    expect(hist.map((e: any) => e.eventType)).toContain("handover.blocked");
    // Paket tamamlanır: test planı, firmware + özet, rota
    const plan = expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revB}/test-plans`, { limits: [{ name: "V", low: 1, high: 2 }] }));
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/test-plans/${plan.id}/publish`));
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revB}/firmware`, { version: "3.0.0", sha256: "b".repeat(64) }));
    const draft = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${revB}/routings`, {}));
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/routings/${draft.id}/publish`, { note: "İlk rota" }));
    const rd = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/revisions/${revB}/readiness`));
    expect(rd.ready).toBe(true);
    expect(rd.items.find((i: any) => i.key === "routing").detail).toBe("v1");
    const ok = expectOk(await submit(revB));
    expect(ok.status).toBe("handover_review");
  });

  it("inceleme sırasında sıkılaşan politika son onayda kontrol edilir; muafiyet gerekçeli ve yetkiyle", async () => {
    const revC = await newRevision("C");
    // v2 gevşek: yalnız test planı
    expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/handover/policy", { requireTestPlan: true, requireFirmware: false, requireFirmwareSha: false, requireRouting: false, note: "Pilot dönemi" }));
    const plan = expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revC}/test-plans`, { limits: [{ name: "V", low: 1, high: 2 }] }));
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/test-plans/${plan.id}/publish`));
    expectOk(await submit(revC));
    expectOk(await approve("rd", revC, "rd"));
    expectOk(await approve("production", revC, "production"));
    // v3 sıkı: rota zorunlu; incelemedeki revizyon etkilenenler listesinde
    const v3 = expectOk(await call(w.app, "manager@a.test", A, "POST", "/api/handover/policy", { requireTestPlan: true, requireFirmware: false, requireFirmwareSha: false, requireRouting: true, note: "Rota zorunlu" }));
    expect(v3.affectedInReview.map((x: any) => x.missing)).toContainEqual(["routing"]);
    const last = await approve("quality", revC, "quality");
    expect(last.body.error.code).toBe("handover_requirements");
    expect(last.body.error.message).toContain("v3");
    // Onay yazılmadı
    const r = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/revisions/${revC}`));
    expect(r.missingApprovals).toEqual(["quality"]);
    // Muafiyet: yetki, gerekçe, zorunlu olmayan madde, karşılanmış madde
    const noPerm = await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revC}/waivers`, { requirement: "routing", reason: "Pilot parti varsayılan rotayla" });
    expect(noPerm.status).toBe(403);
    const short = await call(w.app, "manager@a.test", A, "POST", `/api/revisions/${revC}/waivers`, { requirement: "routing", reason: "kısa" });
    expect(short.status).toBe(400);
    const notReq = await call(w.app, "manager@a.test", A, "POST", `/api/revisions/${revC}/waivers`, { requirement: "firmware", reason: "Firmware sonra girilecek" });
    expect(notReq.body.error.code).toBe("not_required");
    const met = await call(w.app, "manager@a.test", A, "POST", `/api/revisions/${revC}/waivers`, { requirement: "test_plan", reason: "Test planı var zaten ama yine de" });
    expect(met.body.error.code).toBe("already_met");
    const wv = expectOk(await call(w.app, "manager@a.test", A, "POST", `/api/revisions/${revC}/waivers`, { requirement: "routing", reason: "Pilot parti varsayılan rotayla üretilecek" }));
    expect(wv.ready).toBe(true);
    expect(wv.items.find((i: any) => i.key === "routing").waiver.reason).toContain("Pilot parti");
    const done = expectOk(await approve("quality", revC, "quality"));
    expect(done.status).toBe("released");
    // Yayımda kontrol listesi saklanır (politika sürümü ve muafiyetle)
    expect(done.handoverChecklist).toMatchObject({ policyVersion: 3, ready: true, round: 1 });
    expect(done.handoverChecklist.items.find((i: any) => i.key === "routing").waiver.by).toBe("A manager");
    const pol = expectOk(await call(w.app, "technician@a.test", A, "GET", "/api/handover/policy"));
    expect(pol.current.versionNo).toBe(3);
    expect(pol.history).toHaveLength(3);
    expect(pol.waivers[0]).toMatchObject({ requirement: "routing", productCode: "HV-1", rev: "C" });
    const late = await call(w.app, "manager@a.test", A, "POST", `/api/revisions/${revC}/waivers`, { requirement: "routing", reason: "Yayımlanmış revizyona muafiyet denemesi" });
    expect(late.body.error.code).toBe("revision_locked");
  });
});
