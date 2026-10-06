/**
 * Yöneticinin parola sıfırlaması (073): geçici parola + ilk girişte değişim zorunlu, oturumlar kapanır.
 * Başka şirketin de üyesi olan kullanıcı sıfırlanamaz (hesap ele geçirme riski); kendi parolası bu yoldan sıfırlanamaz.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, PASSWORD, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
const membership = async (email: string) =>
  expectOk(await call(w.app, "admin@a.test", A, "GET", "/api/admin/users")).find((u: any) => u.email === email).membershipId as string;
const login = (email: string, password: string) => w.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("yönetici parola sıfırlaması", () => {
  it("geçici parola verilir, eski parola ve oturumlar geçersiz olur, ilk girişte değişim zorunlu", async () => {
    const old = (await login("sales@a.test", PASSWORD)).json().token as string;
    const noReason = await call(w.app, "admin@a.test", A, "POST", `/api/admin/users/${await membership("sales@a.test")}/reset-password`, { reason: "x" });
    expect(noReason.status).toBe(400);
    const r = expectOk(await call(w.app, "admin@a.test", A, "POST", `/api/admin/users/${await membership("sales@a.test")}/reset-password`, { reason: "Parolasını unuttu" }));
    expect(r.temporaryPassword).toBeTruthy();

    expect((await login("sales@a.test", PASSWORD)).statusCode).toBe(401);
    const oldSession = await w.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${old}`, "x-company-id": A } });
    expect(oldSession.statusCode).toBe(401);

    const fresh = await login("sales@a.test", r.temporaryPassword);
    expect(fresh.statusCode).toBe(200);
    const me = await w.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${fresh.json().token}`, "x-company-id": A } });
    expect(me.json().mustChangePassword).toBe(true);

    const hist = expectOk(await call(w.app, "admin@a.test", A, "GET", "/api/events?entityType=membership"));
    expect(hist.map((e: any) => e.eventType)).toContain("password.reset");
  });

  it("kendi parolası ve başka şirkette de üyeliği olan kullanıcı sıfırlanamaz; yetkisiz rol sıfırlayamaz", async () => {
    const self = await call(w.app, "admin@a.test", A, "POST", `/api/admin/users/${await membership("admin@a.test")}/reset-password`, { reason: "Kendi parolam" });
    expect(self.body.error.code).toBe("self_change");

    // rd@a.test'i B şirketine de üye yap (sahip bağlantısıyla, B kapsamında).
    const u = (await w.owner.query(`select id from users where email = 'rd@a.test'`)).rows[0].id;
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [w.b.companyId]);
    await w.owner.query(`insert into memberships (company_id, user_id) values ($1, $2)`, [w.b.companyId, u]);
    const multi = await call(w.app, "admin@a.test", A, "POST", `/api/admin/users/${await membership("rd@a.test")}/reset-password`, { reason: "Parolasını unuttu" });
    expect(multi.body.error.code).toBe("multi_company");
    expect((await login("rd@a.test", PASSWORD)).statusCode).toBe(200);

    const denied = await call(w.app, "manager@a.test", A, "POST", `/api/admin/users/${await membership("production@a.test")}/reset-password`, { reason: "Parolasını unuttu" });
    expect(denied.status).toBe(403);
  });
});
