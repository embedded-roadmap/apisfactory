/**
 * Oturum 39 (W33 devamı): kurutma/yeniden uygunluk (bake-out) reçetesi ve çevrimi. JEDEC J-STD-033
 * tablosu burada sabit kodlanmaz — şirketin kalite ekibinin tanımladığı, sürümlenen bir reçete ve gerçek
 * çevrim kaydı tutulur. Tamamlanan çevrim yalnız kullanım süresini (floor life) sıfırlar, raf ömrünü değil.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let itemId: string;
let lotId: string;
let ovenId: string;
let oosOvenId: string;
let calibExpiredOvenId: string;
let fixtureId: string;
let recipeV1: any;

function addDays(n: number): string {
  return new Date(Date.now() + n * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;

  itemId = expectOk(
    await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "CMP-MSL-DRY1", name: "Nem hassas BGA", kind: "component", manufacturer: "M", mpn: "DRY-1" }),
  ).id;
  expectOk(
    await call(w.app, "quality@a.test", A, "POST", `/api/items/${itemId}/storage`, { mslLevel: "3", floorLifeHours: 168 }),
  );
  const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
  const stock = "kod,miktar,lot,konum,rev\nCMP-MSL-DRY1,100,DRY-LOT-1,STK,";
  const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: stock, mapping: stockMapping }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  lotId = expectOk(await call(w.app, "warehouse@a.test", A, "GET", "/api/lots/lookup?code=DRY-LOT-1"))[0].id;
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/lots/${lotId}/open`));

  ovenId = expectOk(await call(w.app, "quality@a.test", A, "POST", "/api/equipment", { code: "OVEN-1", name: "Kurutma fırını 1", kind: "oven", calibrationDue: addDays(90) })).id;
  oosOvenId = expectOk(await call(w.app, "quality@a.test", A, "POST", "/api/equipment", { code: "OVEN-2", name: "Kurutma fırını 2", kind: "oven", calibrationDue: addDays(90) })).id;
  expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/equipment/${oosOvenId}/status`, { status: "out_of_service", reason: "Bakımda" }));
  calibExpiredOvenId = expectOk(
    await call(w.app, "quality@a.test", A, "POST", "/api/equipment", { code: "OVEN-3", name: "Kurutma fırını 3", kind: "oven", calibrationDue: addDays(-3) }),
  ).id;
  fixtureId = expectOk(await call(w.app, "quality@a.test", A, "POST", "/api/equipment", { code: "FIX-1", name: "Fikstür", kind: "fixture" })).id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Kurutma (bake-out) reçetesi ve çevrimi (W33 devamı)", () => {
  it("reçete sürümleri değişmez; yalnız kalite/depo tanımlayabilir; her sürüm bir kaynak (datasheet/prosedür) taşır", async () => {
    const noAccess = await call(w.app, "sales@a.test", A, "POST", "/api/dryout-recipes", {
      mslLevel: "3", temperatureC: 125, durationHours: 24, source: "JEDEC J-STD-033D.1 Tablo 4-1",
    });
    expect(noAccess.status).toBe(403);

    recipeV1 = expectOk(
      await call(w.app, "quality@a.test", A, "POST", "/api/dryout-recipes", {
        mslLevel: "3", temperatureC: 125, durationHours: 24, source: "JEDEC J-STD-033D.1 Tablo 4-1", note: "1.4mm üstü kalınlık",
      }),
    );
    expect(recipeV1).toMatchObject({ versionNo: 1, temperatureC: 125, durationHours: 24 });

    // Kaynak alanı zorunlu (en az 3 karakter) — sunucu üretici prosedürünü uydurmaz, referans ister.
    const noSource = await call(w.app, "quality@a.test", A, "POST", "/api/dryout-recipes", { mslLevel: "3", temperatureC: 125, durationHours: 24, source: "x" });
    expect(noSource.status).toBe(400);

    const v2 = expectOk(
      await call(w.app, "quality@a.test", A, "POST", "/api/dryout-recipes", {
        mslLevel: "3", temperatureC: 90, durationHours: 48, source: "JEDEC J-STD-033D.1 Tablo 4-2 (düşük sıcaklık alternatifi)",
      }),
    );
    expect(v2.versionNo).toBe(2);

    // Eski sürüm geçersiz kılınmaz — ikisi de listede görünür.
    const list = expectOk(await call(w.app, "quality@a.test", A, "GET", "/api/dryout-recipes"));
    expect(list.map((r: any) => r.versionNo)).toEqual(expect.arrayContaining([1, 2]));
  });

  it("çevrim başlatma: fırın olmayan/hizmet dışı/kalibrasyonu geçmiş ekipmanla reddedilir", async () => {
    const notOven = await call(w.app, "technician@a.test", A, "POST", `/api/lots/${lotId}/dryout/start`, { recipeId: recipeV1.id, equipmentId: fixtureId });
    expect(notOven.status).toBe(409);
    expect(notOven.body.error.code).toBe("not_oven");

    const oos = await call(w.app, "technician@a.test", A, "POST", `/api/lots/${lotId}/dryout/start`, { recipeId: recipeV1.id, equipmentId: oosOvenId });
    expect(oos.status).toBe(409);
    expect(oos.body.error.code).toBe("equipment_out_of_service");

    const expired = await call(w.app, "technician@a.test", A, "POST", `/api/lots/${lotId}/dryout/start`, { recipeId: recipeV1.id, equipmentId: calibExpiredOvenId });
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe("calibration_expired");

    // production.execute yetkisi olmayan rol başlatamaz (depo yalnız inventory.issue/item.storage.manage taşır).
    const noAccess = await call(w.app, "warehouse@a.test", A, "POST", `/api/lots/${lotId}/dryout/start`, { recipeId: recipeV1.id, equipmentId: ovenId });
    expect(noAccess.status).toBe(403);
  });

  it("çevrim başlatılır, aynı lotta ikinci açık çevrime izin verilmez, tamamlanınca yalnız kullanım süresi sıfırlanır (raf ömrü değil)", async () => {
    const before = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/items/${itemId}/lots`));
    const lotBefore = before.lots.find((l: any) => l.id === lotId);
    const floorLifeBefore = lotBefore.floorLifeExpiresAt;
    expect(floorLifeBefore).toBeTruthy();

    const started = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/lots/${lotId}/dryout/start`, { recipeId: recipeV1.id, equipmentId: ovenId, note: "İlk çevrim" }));
    expect(started.status).toBe("in_progress");

    const again = await call(w.app, "technician@a.test", A, "POST", `/api/lots/${lotId}/dryout/start`, { recipeId: recipeV1.id, equipmentId: ovenId });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_in_progress");

    const completed = expectOk(
      await call(w.app, "technician@a.test", A, "POST", `/api/lots/${lotId}/dryout/${started.id}/complete`, {
        status: "completed", actualTemperatureC: 124.5, actualDurationHours: 25, note: "Tam süre uygulandı",
      }),
    );
    expect(completed.status).toBe("completed");
    expect(completed.floorLifeResetAt).toBeTruthy();

    const after = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/items/${itemId}/lots`));
    const lotAfter = after.lots.find((l: any) => l.id === lotId);
    // Kullanım süresi (floor life) çevrim bitişinden yeniden başlar — daha ileri bir tarih olmalı.
    expect(new Date(lotAfter.floorLifeExpiresAt).getTime()).toBeGreaterThan(new Date(floorLifeBefore).getTime());
    // Raf ömrü (expiresAt) bu işlemden etkilenmez — bu lotta hiç girilmediği için hâlâ boş kalmalı.
    expect(lotAfter.expiresAt).toBeNull();

    const history = expectOk(await call(w.app, "quality@a.test", A, "GET", `/api/lots/${lotId}/dryout`));
    expect(history[0]).toMatchObject({ status: "completed", equipmentCode: "OVEN-1", recipeVersionNo: 1, actualTemperatureC: "124.50" });

    // Kapanmış çevrim ikinci kez kapatılamaz.
    const already = await call(w.app, "technician@a.test", A, "POST", `/api/lots/${lotId}/dryout/${started.id}/complete`, { status: "completed" });
    expect(already.status).toBe(409);
    expect(already.body.error.code).toBe("not_in_progress");
  });

  it("yarıda kesilen (aborted) çevrim kullanım süresini sıfırlamaz", async () => {
    const before = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/items/${itemId}/lots`));
    const floorLifeBefore = before.lots.find((l: any) => l.id === lotId).floorLifeExpiresAt;

    const started = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/lots/${lotId}/dryout/start`, { recipeId: recipeV1.id, equipmentId: ovenId }));
    const aborted = expectOk(await call(w.app, "technician@a.test", A, "POST", `/api/lots/${lotId}/dryout/${started.id}/complete`, { status: "aborted", note: "Elektrik kesintisi" }));
    expect(aborted.status).toBe("aborted");
    expect(aborted.floorLifeResetAt).toBeNull();

    const after = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/items/${itemId}/lots`));
    const floorLifeAfter = after.lots.find((l: any) => l.id === lotId).floorLifeExpiresAt;
    expect(floorLifeAfter).toBe(floorLifeBefore);
  });

  it("şirket B kendi kaydını görmez (RLS)", async () => {
    const r = await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/dryout-recipes");
    expect(expectOk(r)).toEqual([]);
    // Bu uç, lotun şirkete ait olup olmadığını ayrıca doğrulamaz; RLS çevrim tablosunu şirkete göre süzer,
    // bu yüzden B'nin A'ya ait bir lot id'siyle sorgusu kendi (boş) sonuç kümesini döner, 404 değil.
    const r2 = expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", `/api/lots/${lotId}/dryout`));
    expect(r2).toEqual([]);
  });
});
