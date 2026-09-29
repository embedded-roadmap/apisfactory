/**
 * DEMO senaryo verisi (kalan işler 2): boş şemaya seed + senaryo oynatılır; yönetici raporunun dört alanı onay bekleyen
 * gerçek bulgu üretmeli (AI yorumunun denenebilmesi için). Senaryo gerçek API uçlarını kullandığından, bir iş kuralı
 * değiştiğinde bu test bozulur — demo verisi sessizce çürümez.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool } from "../src/db/pool";
import { DEMO_PASSWORD, seedDemo } from "../src/db/seed";
import { runScenario } from "../src/db/seed-scenario";

let owner: pg.Client;

beforeAll(async () => {
  const url = process.env.MIGRATION_DATABASE_URL!;
  owner = new pg.Client({ connectionString: url });
  await owner.connect();
  await owner.query("drop schema public cascade; create schema public; grant usage on schema public to apis_app;");
  await migrate(url, () => {});
  await seedDemo();
  await runScenario();
}, 120_000);

afterAll(async () => {
  await owner.end();
  await closePool();
});

describe("DEMO senaryo verisi", () => {
  it("yönetici raporunda tahsilat, proje bütçesi, tedarikçi performansı ve kârlılık onay bekleyen bulgu üretir", async () => {
    const app = await buildApp();
    try {
      const login = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "yonetici@demo.apisfactory.com", password: DEMO_PASSWORD } })).json();
      const cid = login.companies.find((c: any) => c.code === "DEMO-ELK").id;
      const d = new Date();
      const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
      const to = d.toISOString().slice(0, 10);
      const r = (await app.inject({ method: "GET", url: `/api/reports/executive?periodKind=monthly&from=${from}&to=${to}`, headers: { authorization: `Bearer ${login.token}`, "x-company-id": cid } })).json();
      for (const area of ["collections", "project_budget", "supplier_performance", "cost_margin"]) {
        expect(r.areas[area], area).toMatchObject({ causeType: "hypothesis", requiresApproval: true });
      }
      expect(r.areas.project_budget.finding).toMatch(/bütçeyi aştı/);
      expect(r.areas.supplier_performance.finding).toMatch(/geç/);
    } finally {
      await app.close();
    }
  });

  it("ikinci çalıştırma atlanır (idempotent)", async () => {
    const before = (await owner.query(`select count(*)::int as n from companies`)).rows[0].n;
    await runScenario();
    await owner.query(`select set_config('app.company_id', (select id::text from companies where code = 'DEMO-ELK'), false)`);
    expect((await owner.query(`select count(*)::int as n from items where code = 'DEMO-KART-01'`)).rows[0].n).toBe(1);
    expect((await owner.query(`select count(*)::int as n from companies`)).rows[0].n).toBe(before);
  });
});
