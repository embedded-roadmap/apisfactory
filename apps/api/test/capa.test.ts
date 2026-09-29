/**
 * R18 (ana talimat §16): tekrarlayan hata → düzeltici faaliyet (DF) ve etkinlik kontrolü.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, PASSWORD, setupWorld, type World } from "./helpers";
import { createUser } from "../src/db/seed";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let rev: string;
const Q = "quality@a.test";
const Q2 = "kalite2@a.test";
const T = "technician@a.test";
const W = "warehouse@a.test";
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };

/** qty adet üret; hepsi testte kalır ve verilen hata koduyla hurdaya ayrılır. Son kararın yanıtını döner. */
async function failing(qty: string, code: string) {
  const wo = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/work-orders", { productRevisionId: rev, qty }));
  const rel = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/work-orders/${wo.id}/release`));
  const lot = expectOk(await call(w.app, W, A, "GET", "/api/lots/lookup?code=CP-L1"))[0].id;
  expectOk(await call(w.app, W, A, "POST", `/api/work-orders/${wo.id}/issue`, { lotId: lot, qty }));
  const results: any[] = [];
  for (const op of rel.operations) {
    expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/start`));
    if (op.isQualityGate) {
      for (const d of rel.devices) {
        expectOk(await call(w.app, T, A, "POST", `/api/devices/${d.serial}/test`, { result: "fail" }));
        results.push(expectOk(await call(w.app, Q, A, "POST", `/api/devices/${d.serial}/disposition`, { decision: "scrap", note: "Test kaldı", defectCode: code })));
      }
    }
    expectOk(await call(w.app, T, A, "POST", `/api/work-orders/${wo.id}/operations/${op.id}/complete`));
  }
  return results;
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "CP-1", name: "DF kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "c.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;CP-MCU;1;MCU;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  for (const [u, area] of [["rd", "rd"], ["production", "production"], ["quality", "quality"]] as [string, string][]) {
    expectOk(await call(w.app, `${u}@a.test`, A, "POST", `/api/revisions/${rev}/handover`, { area, decision: "approve" }));
  }
  const sp = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", {
    fileName: "s.csv", content: "kod,miktar,lot,konum\nCMP-TESTSEMI-CP-MCU,30,CP-L1,STK", mapping: { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum" },
  }));
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
  const role = (await w.owner.query(`select id from roles where company_id = $1 and code = 'quality'`, [A])).rows[0];
  await createUser(w.owner, { email: Q2, name: "İkinci kalite", password: PASSWORD, companyId: A, roles: ["quality"], roleIds: { quality: role.id } });
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Düzeltici faaliyet (R18)", () => {
  let capaId: string;
  it("aynı üründe aynı hata kodu eşiğe ulaşınca DF açılır; sonraki tekrarlar ona bağlanır; başka kod etkilemez", async () => {
    expect(expectOk(await call(w.app, Q, A, "GET", "/api/capa-settings"))).toEqual({ threshold: 3, windowDays: 30 });
    const r = await failing("3", "kisa-devre");
    expect(r.map((x) => x.capa?.created ?? null)).toEqual([null, null, true]);
    capaId = r[2].capa.capaId;
    const again = await failing("1", "KISA-DEVRE");
    expect(again[0].capa).toMatchObject({ capaId, created: false });
    expect((await failing("1", "LEHIM"))[0].capa).toBeNull();
    const c = expectOk(await call(w.app, Q, A, "GET", `/api/capas/${capaId}`));
    expect(c).toMatchObject({ status: "open", defectCode: "KISA-DEVRE", productCode: "CP-1", trigger: { count: 3, threshold: 3 } });
    expect(c.occurrences).toHaveLength(4);
    const task = await w.owner.query(`select assignee_role from tasks where kind = 'capa' and entity_id = $1 and status = 'open'`, [capaId]);
    expect(task.rows.map((x) => x.assignee_role)).toEqual(["quality"]);
  });

  it("faaliyet → etkinlik kontrolü: giren doğrulayamaz; sonradan tekrar varsa 'etkili' gerekçe ister; etkisizse yeniden açılır", async () => {
    const body = { rootCause: "Varsayım: C5 kondansatörü lehim köprüsü, şablon açıklığı fazla", action: "Şablon açıklığı %10 küçültüldü, AOI kuralı eklendi", checkAfterDays: 14 };
    expect((await call(w.app, T, A, "POST", `/api/capas/${capaId}/action`, body)).status).toBe(403);
    const a = expectOk(await call(w.app, Q, A, "POST", `/api/capas/${capaId}/action`, body));
    expect(a).toMatchObject({ status: "action_taken", recurrencesSinceAction: 0 });
    expect((await call(w.app, Q, A, "POST", `/api/capas/${capaId}/verify`, { effective: true })).body.error.code).toBe("self_verification");
    await failing("1", "KISA-DEVRE"); // faaliyetten sonra tekrar
    expect((await call(w.app, Q2, A, "POST", `/api/capas/${capaId}/verify`, { effective: true })).body.error.code).toBe("recurrence_after_action");
    const re = expectOk(await call(w.app, Q2, A, "POST", `/api/capas/${capaId}/verify`, { effective: false, note: "Tekrar etti; kök neden yanlış olabilir" }));
    expect(re).toMatchObject({ status: "open", reopenCount: 1 });

    expectOk(await call(w.app, Q, A, "POST", `/api/capas/${capaId}/action`, { ...body, rootCause: "Varsayım: dizgi makinesi besleyici hizası kaymış" }));
    const done = expectOk(await call(w.app, Q2, A, "POST", `/api/capas/${capaId}/verify`, { effective: true, note: "İki haftada tekrar yok" }));
    expect(done).toMatchObject({ status: "closed", verifiedBy: "İkinci kalite" });
    const hist = await w.owner.query(`select event_type from events where entity_id = $1 order by created_at`, [capaId]);
    expect(hist.rows.map((x) => x.event_type)).toEqual(expect.arrayContaining(["opened", "recurrence.linked", "action_taken", "verified.ineffective", "verified.effective"]));
  });
});
