/**
 * R46 — Yedek, geri yükleme ve kesintide talimat erişimi (W37 §28: "Kesintide yayımlanmış talimat ve
 * atanmış iş listesinin kontrollü çevrimdışı kopyası kullanılabilsin"). `GET /api/offline/snapshot`
 * gerçek atanmış açık işleri ve `@apisfactory/shared`'daki (tek kaynak, `/help` ile aynı) yayımlanmış
 * rol rehberi/destek politikasını döner — hiçbir alan uydurulmaz.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool } from "../src/db/pool";

let app: FastifyInstance;
let owner: pg.Client;

beforeAll(async () => {
  const url = process.env.MIGRATION_DATABASE_URL!;
  owner = new pg.Client({ connectionString: url });
  await owner.connect();
  await owner.query("drop schema public cascade; create schema public; grant usage on schema public to apis_app;");
  await migrate(url, () => {});
  app = await buildApp();
});

afterAll(async () => {
  await owner.end();
  await closePool();
});

async function newCompanySession() {
  const r = await app.inject({
    method: "POST",
    url: "/api/setup/company",
    payload: { companyName: "Offline Test Ltd.", companyCode: `OFF-${Date.now()}`, adminName: "Kurucu Yönetici", adminEmail: `offline-${Date.now()}@test.com`, adminPassword: "kurucu-parola-1" },
  });
  expect(r.statusCode).toBe(200);
  const s = r.json();
  return { token: s.token as string, companyId: s.companies[0].id as string, userId: s.user.id as string };
}

describe("R46: kesintide talimat erişimi — çevrimdışı kopya", () => {
  it("gerçek atanmış açık işleri ve yayımlanmış rol rehberi/destek politikasını döner", async () => {
    const { token, companyId, userId } = await newCompanySession();
    const headers = { authorization: `Bearer ${token}`, "x-company-id": companyId };

    // Kendime gerçek bir açık görev ata.
    const t1 = await app.inject({ method: "POST", url: "/api/tasks", headers, payload: { title: "Çevrimdışı test görevi", assigneeUserId: userId, priority: "high" } });
    expect(t1.statusCode).toBe(200);

    // Tamamlanmış bir görev — snapshot'ta GÖRÜNMEMELİ (yalnızca açık işler).
    const t2 = await app.inject({ method: "POST", url: "/api/tasks", headers, payload: { title: "Kapanmış görev", assigneeUserId: userId } });
    const t2Id = t2.json().id;
    const done = await app.inject({ method: "POST", url: `/api/tasks/${t2Id}/status`, headers, payload: { status: "done" } });
    expect(done.statusCode).toBe(200);

    const snap = await app.inject({ method: "GET", url: "/api/offline/snapshot", headers });
    expect(snap.statusCode).toBe(200);
    const body = snap.json();

    expect(body.company.id).toBe(companyId);
    expect(body.user.id).toBe(userId);
    expect(body.roleGuides.length).toBeGreaterThan(0);
    expect(body.supportPolicy.length).toBeGreaterThan(0);
    expect(body.importExportNotes.length).toBeGreaterThan(0);

    const titles = body.myTasks.map((t: { title: string }) => t.title);
    expect(titles).toContain("Çevrimdışı test görevi");
    expect(titles).not.toContain("Kapanmış görev");
  });

  it("kimliksiz istek reddedilir (401)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/offline/snapshot" });
    expect(r.statusCode).toBe(401);
  });

  it("başka bir şirketin görevi çevrimdışı kopyada görünmez (RLS izolasyonu)", async () => {
    const a = await newCompanySession();
    const b = await newCompanySession();
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${a.token}`, "x-company-id": a.companyId },
      payload: { title: "Yalnızca A şirketinin görevi", assigneeUserId: a.userId },
    });
    const snapB = await app.inject({ method: "GET", url: "/api/offline/snapshot", headers: { authorization: `Bearer ${b.token}`, "x-company-id": b.companyId } });
    const titlesB = snapB.json().myTasks.map((t: { title: string }) => t.title);
    expect(titlesB).not.toContain("Yalnızca A şirketinin görevi");
  });
});
