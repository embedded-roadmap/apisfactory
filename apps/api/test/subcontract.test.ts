/**
 * Oturum 24 (W32): fason üretici portalı — dış kullanıcı yalnızca kendisine atanmış işi görür
 * (genel izinle değil, subcontract_jobs.subcontractor_user_id eşleşmesiyle). Kabul/karşı teklif,
 * malzeme transferi/iade, ilerleme (ileri yönde), dış firma beyanı ile şirketin kesin kabulü ayrıdır,
 * dosya yükleme (fotoğraf/video/test raporu/teslim belgesi).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, login, PASSWORD, setupWorld, type World } from "./helpers";
import { createUser } from "../src/db/seed";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let B: string;
let subUserId: string;
let otherSubUserId: string;
let capId: string;
let lotId: string;

async function makeExternal(companyId: string, email: string, name: string): Promise<string> {
  await w.owner.query(`select set_config('app.company_id', $1, false)`, [companyId]);
  const role = (await w.owner.query(`select id from roles where company_id = $1 and code = 'subcontractor'`, [companyId])).rows[0];
  const userId = await createUser(w.owner, { email, name, password: PASSWORD, companyId, roles: ["subcontractor"], roleIds: { subcontractor: role.id } });
  await w.owner.query(`update memberships set is_external = true where company_id = $1 and user_id = $2`, [companyId, userId]);
  return userId;
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId; B = w.b.companyId;
  subUserId = await makeExternal(A, "fason@ext.test", "Fason Firma A.Ş.");
  otherSubUserId = await makeExternal(A, "fason2@ext.test", "Başka Fason Ltd.");

  capId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "CMP-SJ-CAP", name: "Kondansatör (fason testi)", kind: "component", manufacturer: "Sj", mpn: "SJ-CAP" })).id;
  const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
  const stock = "kod,miktar,lot,konum,rev\nCMP-SJ-CAP,100,SJ-LOT-1,STK,";
  const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: stock, mapping: stockMapping }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  lotId = expectOk(await call(w.app, "warehouse@a.test", A, "GET", "/api/lots/lookup?code=SJ-LOT-1"))[0].id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

let jobId: string;

describe("Fason üretici portalı (W32)", () => {
  it("iç personel iş önerir; yalnız subcontract.manage yetkisi olan oluşturabilir; dış kullanıcı olmayan biri atanamaz", async () => {
    expect((await call(w.app, "quality@a.test", A, "POST", "/api/subcontract-jobs", {
      subcontractorUserId: subUserId, kind: "dizgi", scope: "10 adet kart dizgisi", qty: "10",
    })).status).toBe(403);

    const rdUserId = (await w.owner.query(`select id from users where email = 'rd@a.test'`)).rows[0].id;
    const badUser = await call(w.app, "production@a.test", A, "POST", "/api/subcontract-jobs", {
      subcontractorUserId: rdUserId, kind: "dizgi", scope: "10 adet kart dizgisi", qty: "10",
    });
    expect(badUser.status).toBe(400);

    jobId = expectOk(await call(w.app, "production@a.test", A, "POST", "/api/subcontract-jobs", {
      subcontractorUserId: subUserId, kind: "dizgi", scope: "10 adet kart SMT dizgisi", qty: "10",
      promisedDate: "2026-12-01", price: "1500", companySupplies: "Kondansatör CMP-SJ-CAP", subcontractorSupplies: "Lehim pastası",
    })).id;
    expect(jobId).toBeTruthy();
  });

  it("dış kullanıcı yalnız kendisine atanan işi görür; başka fasoncu göremez; iç ticari veriler kapalı (genel izin yok)", async () => {
    const mine = expectOk(await call(w.app, "fason@ext.test", A, "GET", "/api/subcontract-jobs/mine"));
    expect(mine.map((j: any) => j.id)).toContain(jobId);
    const otherMine = expectOk(await call(w.app, "fason2@ext.test", A, "GET", "/api/subcontract-jobs/mine"));
    expect(otherMine.map((j: any) => j.id)).not.toContain(jobId);
    expect((await call(w.app, "fason2@ext.test", A, "GET", `/api/subcontract-jobs/${jobId}`)).status).toBe(403);
    // Dış kullanıcının başka bir uç noktaya (örn. envanter) genel erişimi yok
    expect((await call(w.app, "fason@ext.test", A, "GET", "/api/stock/balances")).status).toBe(403);
  });

  it("kabul/karşı teklif: dış firma karşı teklif verir, iç personel karşı teklifi kabul eder", async () => {
    const countered = expectOk(await call(w.app, "fason@ext.test", A, "POST", `/api/subcontract-jobs/${jobId}/decision`, {
      decision: "counter", counterPrice: "1700", note: "Malzeme fiyatı arttı",
    }));
    expect(countered.status).toBe("countered");
    expect((await call(w.app, "fason@ext.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "prep" })).status).toBe(409); // henüz kabul edilmedi

    const accepted = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/subcontract-jobs/${jobId}/counter-decision`, { decision: "accept" }));
    expect(accepted.status).toBe("accepted");
    expect(accepted.price).toBe("1700.00");
  });

  it("malzeme fason konumuna transfer edilir; stok gerçekten düşer", async () => {
    const before = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/stock/availability/${capId}`));
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/subcontract-jobs/${jobId}/transfer-material`, { itemId: capId, lotId, qty: "40" }));
    const after = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/stock/availability/${capId}`));
    expect(Number(after.usable)).toBe(Number(before.usable) - 40);
    expect(Number(after.subcontractor)).toBe(40);
  });

  it("dış firma ilerlemeyi yalnız ileri yönde bildirir; atlama/geri gidiş reddedilir", async () => {
    expect((await call(w.app, "fason@ext.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "testing" })).status).toBe(409); // prep atlanamaz
    expectOk(await call(w.app, "fason@ext.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "prep" }));
    expectOk(await call(w.app, "fason@ext.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "in_production" }));
    expect((await call(w.app, "fason@ext.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "prep" })).status).toBe(409); // geri gidilemez
    expectOk(await call(w.app, "fason@ext.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "testing" }));
    expectOk(await call(w.app, "fason@ext.test", A, "POST", `/api/subcontract-jobs/${jobId}/progress`, { status: "ready_to_ship" }));
  });

  it("dış firma sağlam/fire/kullanılmayan bildirir (beyan); bu, şirketin kesin kabulüyle karışmaz", async () => {
    const declared = expectOk(await call(w.app, "fason@ext.test", A, "POST", `/api/subcontract-jobs/${jobId}/declare`, {
      goodQty: "9", scrapQty: "1", unusedQty: "0", note: "1 adet dizgi hatası",
    }));
    expect(declared.declaredGoodQty).toBe("9.000000");
    expect(declared.acceptedGoodQty).toBeNull(); // kesin kabul henüz verilmedi
  });

  it("iç personel fireyi imha eder, kullanılmayanı iade alır, bitmiş çıktıyı kesin kabul eder (yeni lot + giriş kalite görevi)", async () => {
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/subcontract-jobs/${jobId}/return-material`, { itemId: capId, lotId, qty: "4", kind: "scrap" }));

    const done = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/subcontract-jobs/${jobId}/accept-output`, { itemId: capId, lotNo: "SJ-OUT-1", qty: "9" }));
    expect(done.ok).toBe(true);
    const job = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/subcontract-jobs/${jobId}`));
    expect(job.status).toBe("completed");
    expect(job.acceptedGoodQty).toBe("9.000000");

    const outLot = expectOk(await call(w.app, "quality@a.test", A, "GET", "/api/lots/lookup?code=SJ-OUT-1"))[0];
    expect(outLot.inspectionStatus).toBe("pending");
    expect(outLot.balances.some((b: any) => b.locationType === "incoming_inspection" && Number(b.qty) === 9)).toBe(true);
  });

  it("fotoğraf/test raporu yüklenebilir; her iki taraf da görür; başka fasoncu göremez", async () => {
    const png = Buffer.from("\x89PNG\r\n\x1a\nTEST").toString("base64");
    const up = expectOk(await call(w.app, "fason@ext.test", A, "POST", `/api/subcontract-jobs/${jobId}/files`, { kind: "test_report", fileName: "test.png", contentType: "image/png", contentBase64: png }));
    expect(up.id).toBeTruthy();
    const list1 = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/subcontract-jobs/${jobId}/files`));
    expect(list1.length).toBe(1);
    expect((await call(w.app, "fason2@ext.test", A, "GET", `/api/subcontract-jobs/${jobId}/files`)).status).toBe(403);
    const dl = await call(w.app, "fason@ext.test", A, "GET", `/api/subcontract-jobs/${jobId}/files/${up.id}`);
    expect(dl.status).toBe(200);
  });

  it("malzeme kullanımı: girdi lotu bazında gönderilen/iade/fire ve net tüketim; çıktı lotu ayrı listelenir", async () => {
    expect((await call(w.app, "fason2@ext.test", A, "GET", `/api/subcontract-jobs/${jobId}/material-usage`)).status).toBe(403); // başka fasoncu göremez
    const usage = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/subcontract-jobs/${jobId}/material-usage`));
    expect(usage.inputLots.length).toBe(1);
    const row = usage.inputLots[0];
    expect(row.lotNo).toBe("SJ-LOT-1");
    expect(Number(row.sentQty)).toBe(40);
    expect(Number(row.scrappedQty)).toBe(4);
    expect(Number(row.returnedQty)).toBe(0);
    expect(Number(row.netConsumedQty)).toBe(36);
    expect(usage.outputLots.length).toBe(1);
    expect(usage.outputLots[0].lotNo).toBe("SJ-OUT-1");
    expect(Number(usage.outputLots[0].qty)).toBe(9);
    // dış firma da kendi işinin malzeme kullanımını görebilir
    const asSub = expectOk(await call(w.app, "fason@ext.test", A, "GET", `/api/subcontract-jobs/${jobId}/material-usage`));
    expect(asSub.inputLots.length).toBe(1);
  });

  it("şirket B kendi işini görmez (RLS)", async () => {
    const r = await call(w.app, "all@b.test", B, "GET", "/api/subcontract-jobs");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("fasoncu performans raporu: yalnız iç yönetim görür; tamamlanan işten gerçek toplamlar ve termin/fire oranı hesaplanır", async () => {
    expect((await call(w.app, "quality@a.test", A, "GET", "/api/subcontract-jobs/performance")).status).toBe(403);
    expect((await call(w.app, "fason@ext.test", A, "GET", "/api/subcontract-jobs/performance")).status).toBe(403);
    const rows = expectOk(await call(w.app, "production@a.test", A, "GET", "/api/subcontract-jobs/performance"));
    const row = rows.find((r: any) => r.subcontractorUserId === subUserId);
    expect(row).toBeTruthy();
    expect(Number(row.jobsTotal)).toBe(1);
    expect(Number(row.jobsCompleted)).toBe(1);
    expect(Number(row.totalAcceptedGoodQty)).toBe(9);
    expect(Number(row.totalDeclaredGoodQty)).toBe(9);
    expect(Number(row.totalDeclaredScrapQty)).toBe(1);
    expect(row.scrapRate).toBeCloseTo(1 / 10, 5);
    // termin 2026-12-01, kesin kabul çok daha erken (test anı) verildiğinden zamanında sayılır
    expect(Number(row.onTimeCompleted)).toBe(1);
    expect(Number(row.lateCompleted)).toBe(0);
    expect(row.onTimeRate).toBe(1);
    // hiç işi olmayan/hiç kabul edilmemiş fasoncuda oranlar uydurulmaz, null döner
    const other = rows.find((r: any) => r.subcontractorUserId === otherSubUserId);
    expect(other).toBeUndefined(); // fason2@ext.test'e hiç iş atanmadı, raporda hiç satırı yok
  });
});
