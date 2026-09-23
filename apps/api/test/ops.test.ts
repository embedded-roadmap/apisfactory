/**
 * Oturum 20 (W38): bağlayıcı operasyon panosu — kota, önbellek isabeti, hata sayısı, son etkinlik.
 * Yeni tablo yok; connector_calls ve document_dispatches kayıtlarının özetidir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let itemId: string;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  itemId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "OPS-1", name: "Ops kalemi", kind: "component", manufacturer: "OpsSemi", mpn: "OPS-MPN-1" })).id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Bağlayıcı operasyon panosu (W38)", () => {
  it("yetkisiz göremez; tüm bağlayıcılar BAĞLANMADI ve sıfır etkinlikle listelenir", async () => {
    const denied = await call(w.app, "purchasing@a.test", A, "GET", "/api/connectors/status");
    expect(denied.status).toBe(403);
    const s = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/connectors/status"));
    expect(s.rows.length).toBe(5 + 6 + 6); // distribütör + e-belge + kargo
    expect(s.rows.every((r: any) => r.mode === "not_connected" && r.activityToday === 0)).toBe(true);
    expect(s.summary).toMatchObject({ connected: 0, total: 17, errorsWeek: 0 });
  });

  it("distribütör TEST moduna alınıp sorgulanınca kota/önbellek isabeti panoya yansır", async () => {
    const digikey = (await call(w.app, "manager@a.test", A, "GET", "/api/distributors")).body.find((c: any) => c.key === "digikey");
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", `/api/distributors/${digikey.id}`, { mode: "test", dailyCallLimit: 3, reason: "Ops panosu testi" }));
    expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/items/${itemId}/offers`)); // ilk çağrı: ok
    expectOk(await call(w.app, "purchasing@a.test", A, "GET", `/api/items/${itemId}/offers`)); // ikinci: önbellekten (cache_hit)
    const s = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/connectors/status"));
    const row = s.rows.find((r: any) => r.key === "digikey");
    expect(row).toMatchObject({ category: "distributor", mode: "test", activityToday: 1, cacheHitsToday: 1, quota: 3 });
    expect(row.quotaPct).toBeCloseTo((1 / 3) * 100, 1);
    expect(row.cacheHitPct).toBeCloseTo(50, 1);
    expect(row.lastActivityAt).toBeTruthy();
    expect(s.summary.connected).toBe(1);
  });

  it("e-belge ve kargo gönderimleri de bağlayıcı bazında sayılır", async () => {
    const einv = (await call(w.app, "manager@a.test", A, "GET", "/api/einvoice-connectors")).body.find((c: any) => c.key === "gib_portal");
    expectOk(await call(w.app, "accounting@a.test", A, "POST", `/api/einvoice-connectors/${einv.id}`, { mode: "test", reason: "Ops panosu testi" }));
    const cargo = (await call(w.app, "manager@a.test", A, "GET", "/api/cargo-connectors")).body.find((c: any) => c.key === "aras");
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/cargo-connectors/${cargo.id}`, { mode: "test", reason: "Ops panosu testi" }));
    const s = expectOk(await call(w.app, "manager@a.test", A, "GET", "/api/connectors/status"));
    expect(s.rows.find((r: any) => r.key === "gib_portal")).toMatchObject({ category: "einvoice", mode: "test", activityToday: 0, quota: null });
    expect(s.rows.find((r: any) => r.key === "aras")).toMatchObject({ category: "cargo", mode: "test", activityToday: 0 });
    expect(s.summary.connected).toBe(3);
  });

  it("RLS: başka şirketin bağlayıcı etkinliği karışmaz", async () => {
    const b = expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/connectors/status"));
    expect(b.rows.every((r: any) => r.mode === "not_connected" && r.activityToday === 0)).toBe(true);
  });
});
