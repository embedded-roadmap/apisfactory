/**
 * Kişiler paneli (durum) ve genel arama (074, modules/presence.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
const statusOf = async (viewer: string, name: string) =>
  (expectOk(await call(w.app, viewer, A, "GET", "/api/presence")).people as any[]).find((p) => p.name === name)?.status;

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

describe("durum (çevrimiçi / meşgul / dışarıda / çevrimdışı görün)", () => {
  it("sinyal gönderen çevrimiçi görünür; seçilen durum yansır; görünmez ve 2 dk sinyalsiz kişi çevrimdışı görünür", async () => {
    expect(await statusOf("rd@a.test", "A sales")).toBe("offline");
    expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/presence/heartbeat"));
    expect(await statusOf("rd@a.test", "A sales")).toBe("available");

    expectOk(await call(w.app, "sales@a.test", A, "PUT", "/api/presence/status", { status: "busy" }));
    expect(await statusOf("rd@a.test", "A sales")).toBe("busy");
    expect(expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/presence")).me.status).toBe("busy");

    expectOk(await call(w.app, "sales@a.test", A, "PUT", "/api/presence/status", { status: "invisible" }));
    expect(await statusOf("rd@a.test", "A sales")).toBe("offline");

    expectOk(await call(w.app, "sales@a.test", A, "PUT", "/api/presence/status", { status: "available" }));
    // Satırı yalnız sahibi yazabilir (074 RLS): güncellemeyi o kullanıcının kimliğiyle yap.
    await w.owner.query(`select set_config('app.company_id', $1, false), set_config('app.user_id', (select id::text from users where email = 'sales@a.test'), false)`, [A]);
    await w.owner.query(`update user_presence set last_seen_at = now() - interval '3 minutes' where user_id = (select id from users where email = 'sales@a.test')`);
    expect(await statusOf("rd@a.test", "A sales")).toBe("offline");

    const bad = await call(w.app, "sales@a.test", A, "PUT", "/api/presence/status", { status: "online-ish" });
    expect(bad.status).toBe(400);
  });

  it("başka şirketin kişileri listede yok; kişi kendisini listede görmez", async () => {
    const people = expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/presence")).people as any[];
    expect(people.map((p) => p.name)).not.toContain("B herkes");
    expect(people.map((p) => p.name)).not.toContain("A rd");
  });
});

describe("genel arama", () => {
  it("kişileri bulur; kayıt türleri yetkiye göre döner", async () => {
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/suppliers", { code: "ARAMA-TED", name: "Arama Tedarikçisi" }));
    const p = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/search?q=arama")).results as any[];
    expect(p.find((r) => r.type === "supplier")?.title).toBe("ARAMA-TED");
    const s = expectOk(await call(w.app, "sales@a.test", A, "GET", "/api/search?q=arama")).results as any[];
    expect(s.find((r) => r.type === "supplier")).toBeUndefined(); // satışın satın alma görme izni yok

    const people = expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/search?q=quality")).results as any[];
    expect(people.find((r) => r.type === "person")?.title).toBe("A quality");
    expect((await call(w.app, "rd@a.test", A, "GET", "/api/search?q=a")).status).toBe(400); // en az 2 karakter
  });
});
