/**
 * Kendi rolünü değiştirme kuralı ve tek yönetici istisnası. Normalde kimse kendi rolünü değiştiremez; şirkette rolleri
 * yönetebilen başka etkin üye yoksa gerekçeyle iş rolü eklenebilir, rol yönetimi yetkisi kaldırılamaz.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
const ADMIN = "admin@a.test";
let selfId: string;

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  selfId = expectOk(await call(w.app, ADMIN, A, "GET", "/api/admin/users")).find((u: any) => u.email === ADMIN).membershipId;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Tek yönetici istisnası", () => {
  it("tek yöneticiyken istisna açıktır; yetkisiz göremez", async () => {
    expect(expectOk(await call(w.app, ADMIN, A, "GET", "/api/admin/self-role-change"))).toEqual({ allowed: true });
    expect((await call(w.app, "manager@a.test", A, "GET", "/api/admin/self-role-change")).status).toBe(403);
  });

  it("gerekçesiz reddedilir; rol yönetimi yetkisini kendinden kaldıramaz", async () => {
    expect((await call(w.app, ADMIN, A, "POST", `/api/admin/users/${selfId}/roles`, { roles: ["admin", "purchasing"] })).status).toBe(400);
    expect((await call(w.app, ADMIN, A, "POST", `/api/admin/users/${selfId}/roles`, { roles: ["admin", "purchasing"], reason: "kısa" })).status).toBe(400);
    const lock = await call(w.app, ADMIN, A, "POST", `/api/admin/users/${selfId}/roles`, { roles: ["purchasing"], reason: "Satın almayı da ben yürüteceğim" });
    expect(lock.body.error.code).toBe("last_admin");
  });

  it("gerekçeyle iş rolü eklenir; olay kaydında gerekçe ve istisna yazılır", async () => {
    expectOk(await call(w.app, ADMIN, A, "POST", `/api/admin/users/${selfId}/roles`, { roles: ["admin", "purchasing", "rd"], reason: "Şirketi tek başıma kuruyorum, satın alma ve Ar-Ge de bende" }));
    const me = expectOk(await call(w.app, ADMIN, A, "GET", "/api/admin/users")).find((u: any) => u.email === ADMIN);
    expect([...me.roles].sort()).toEqual(["admin", "purchasing", "rd"]);
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    const ev = (await w.owner.query(`select reason, after_state from events where entity_type = 'membership' and entity_id = $1 and event_type = 'roles.changed' order by id desc limit 1`, [selfId])).rows[0];
    await w.owner.query(`select set_config('app.company_id', '', false)`);
    expect(ev.reason).toContain("tek yöneticisi");
    expect(ev.after_state).toEqual(["admin", "purchasing", "rd"]);
  });

  it("ikinci bir rol yöneticisi eklenince istisna kalkar: kendi rolünü değiştiremez", async () => {
    expectOk(await call(w.app, ADMIN, A, "POST", "/api/admin/users", { email: "admin2@a.test", name: "İkinci Yönetici", roles: ["admin"] }));
    expect(expectOk(await call(w.app, ADMIN, A, "GET", "/api/admin/self-role-change"))).toEqual({ allowed: false });
    const r = await call(w.app, ADMIN, A, "POST", `/api/admin/users/${selfId}/roles`, { roles: ["admin", "purchasing", "rd", "sales"], reason: "Satışı da ben yapacağım artık" });
    expect(r.body.error.code).toBe("self_change");
  });
});
