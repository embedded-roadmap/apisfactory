/**
 * Uçtan uca bot testi bulgusu (2026-10-05): yöneticinin verdiği geçici parola kalıcı olarak geçerli kalıyordu.
 * Artık yönetici eklediği kullanıcı parolasını değiştirene kadar yalnız /api/me, parola, çıkış ve şirket listesine erişir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;

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

const req = (token: string, method: "GET" | "POST", url: string, payload?: unknown) =>
  w.app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${token}`, "x-company-id": A } });

describe("geçici parola ilk girişte değiştirilir", () => {
  it("yönetici eklediği kullanıcı parolayı değiştirmeden işlem yapamaz; değiştirince her şey açılır", async () => {
    const created = expectOk(await call(w.app, "admin@a.test", A, "POST", "/api/admin/users", { email: "gecici@a.test", name: "Geçici Kullanıcı", roles: ["sales"] }));
    const login = await w.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "gecici@a.test", password: created.temporaryPassword } });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;

    const me = await req(token, "GET", "/api/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().mustChangePassword).toBe(true);
    const blocked = await req(token, "GET", "/api/sales-orders");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("password_change_required");

    const same = await req(token, "POST", "/api/auth/password", { current: created.temporaryPassword, next: created.temporaryPassword });
    expect(same.json().error.code).toBe(created.temporaryPassword.length >= 10 ? "password_unchanged" : "bad_request");

    expectOk(await req(token, "POST", "/api/auth/password", { current: created.temporaryPassword, next: "kendi-parolam-123" }).then((r) => ({ status: r.statusCode, body: r.json() })));
    const me2 = await req(token, "GET", "/api/me");
    expect(me2.json().mustChangePassword).toBe(false);
    expect((await req(token, "GET", "/api/sales-orders")).statusCode).toBe(200);
  });

  it("şirket kurucusu ve mevcut kullanıcılar etkilenmez", async () => {
    const me = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/me"));
    expect(me.mustChangePassword).toBe(false);
    const s = await w.app.inject({ method: "POST", url: "/api/setup/company", payload: { companyName: "Kurucu Ltd.", companyCode: "KUR-1", adminName: "Kurucu", adminEmail: "kurucu@kur.test", adminPassword: "kurucu-parola-1" } });
    const t = s.json();
    const me2 = await w.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${t.token}`, "x-company-id": t.companies[0].id } });
    expect(me2.json().mustChangePassword).toBe(false);
  });
});
