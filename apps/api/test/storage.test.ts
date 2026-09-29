/**
 * Oturum 22 (W33): MSL, raf ömrü, ambalaj ve koşul — kalem düzeyinde isteğe bağlı saklama kuralları,
 * lot düzeyinde elle girilen üretim/son kullanma tarihi, paket açılış kaydı ve FIFO/FEFO sıralı lot listesi.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let mslItemId: string;

async function lotId(lotNo: string): Promise<string> {
  return expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/lots/lookup?code=${lotNo}`))[0].id;
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  mslItemId = expectOk(
    await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "CMP-MSL-IC1", name: "Nem hassas IC", kind: "component", manufacturer: "M", mpn: "MSL-IC1" }),
  ).id;
  expectOk(
    await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "CMP-RES-MSL1", name: "Direnç 10k", kind: "component", manufacturer: "R", mpn: "RES-MSL1" }),
  );
  const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
  const stock = "kod,miktar,lot,konum,rev\nCMP-MSL-IC1,100,MSL-LOT-1,STK,\nCMP-MSL-IC1,50,MSL-LOT-2,STK,";
  const sp = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: stock, mapping: stockMapping }));
  expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("MSL, raf ömrü, ambalaj ve koşul (W33)", () => {
  it("kalem saklama kuralları isteğe bağlıdır; yalnız kalite/depo düzenleyebilir", async () => {
    const noAccess = await call(w.app, "sales@a.test", A, "POST", `/api/items/${mslItemId}/storage`, { mslLevel: "3" });
    expect(noAccess.status).toBe(403);
    const set = expectOk(
      await call(w.app, "quality@a.test", A, "POST", `/api/items/${mslItemId}/storage`, {
        mslLevel: "3",
        floorLifeHours: 168,
        shelfLifeDays: 365,
        storageCondition: "≤10°C, kuru dolap",
        issuePolicy: "fefo",
      }),
    );
    expect(set).toMatchObject({ mslLevel: "3", floorLifeHours: 168, shelfLifeDays: 365, issuePolicy: "fefo" });
    const list = expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/items?q=CMP-MSL-IC1"));
    expect(list[0]).toMatchObject({ mslLevel: "3", storageCondition: "≤10°C, kuru dolap" });

    // Diğer kalemlerde bu alanlar zorunlu değil (varsayılan fifo, MSL yok).
    const plain = expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/items?q=CMP-RES-MSL1"));
    expect(plain[0]).toMatchObject({ mslLevel: null, issuePolicy: "fifo" });
  });

  it("lot üretim/son kullanma tarihi elle girilir; AI süre uydurmaz — yalnız girilen tarih kullanılır", async () => {
    const lot1 = await lotId("MSL-LOT-1");
    const lot2 = await lotId("MSL-LOT-2");
    const soon = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/lots/${lot1}/expiry`, { mfgDate: "2026-01-01", expiresAt: soon }));
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/lots/${lot2}/expiry`, { mfgDate: "2026-06-01", expiresAt: later }));

    const { item, lots } = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/items/${mslItemId}/lots`));
    expect(item.issuePolicy).toBe("fefo");
    // FEFO: yakın son kullanma tarihli lot önce gelir.
    expect(lots.map((l: any) => l.lotNo)).toEqual(["MSL-LOT-1", "MSL-LOT-2"]);
    expect(lots[0].status).toBe("expiring_soon");
    expect(lots[1].status).toBe("ok");
  });

  it("paket açılışı bir kez kaydedilir; kullanım süresi (floor life) açılıştan hesaplanır", async () => {
    const lot1 = await lotId("MSL-LOT-1");
    const opened = expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/lots/${lot1}/open`));
    expect(opened.floorLifeExpiresAt).toBeTruthy();
    const again = await call(w.app, "warehouse@a.test", A, "POST", `/api/lots/${lot1}/open`);
    expect(again.status).toBe(409);

    const { lots } = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/items/${mslItemId}/lots`));
    const l1 = lots.find((l: any) => l.lotNo === "MSL-LOT-1");
    expect(l1.openedAt).toBeTruthy();
    expect(l1.floorLifeExpiresAt).toBeTruthy();
  });

  it("mobil lot arama (barkod) MSL ve son kullanma bilgisini döner", async () => {
    const rows = expectOk(await call(w.app, "warehouse@a.test", A, "GET", "/api/lots/lookup?code=MSL-LOT-2"));
    expect(rows[0]).toMatchObject({ mslLevel: "3", floorLifeHours: 168 });
    expect(rows[0].expiresAt).toBeTruthy();
  });

  it("şirket B kendi kalemini görmez (RLS)", async () => {
    const r = await call(w.app, "all@b.test", w.b.companyId, "GET", `/api/items/${mslItemId}/lots`);
    expect(r.status).toBe(404);
  });
});
