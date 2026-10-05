/**
 * R39 — Hazır akışlarla hızlı şirket kurulumu (ana talimat §10 tablo satırı, §25 "Başlangıç" ekranı).
 * `POST /api/setup/company` kimliksiz (public) bir uçla gerçek bir şirket + ilk yönetici kullanıcı
 * oluşturur — W42'nin zaten kurduğu "yeni şirket deneme paketiyle başlar" mantığını ve seed.ts'teki
 * hazır rol/departman/konum/iş merkezi şablonunu yeniden kullanır, hiçbir yeni iş kuralı uydurmaz.
 * `GET /api/setup/status` gerçek satır sayılarından (üyelik, import, ürün, iş emri) bir kontrol
 * listesi döner — hiçbir adım sahte "tamamlandı" göstermez.
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

describe("R39: hazır akışlarla hızlı şirket kurulumu", () => {
  it("yeni şirket + ilk yönetici kullanıcı gerçekten oluşturur, oturum döner, hazır şablon (departman/rol/deneme aboneliği) uygulanmış olur", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/setup/company",
      payload: { companyName: "Yeni Elektronik Ltd.", companyCode: "yeni-1", adminName: "Kurucu Yönetici", adminEmail: "kurucu@yeni.test", adminPassword: "kurucu-parola-1" },
    });
    expect(r.statusCode).toBe(200);
    const session = r.json();
    expect(session.token).toBeTruthy();
    expect(session.companies).toHaveLength(1);
    expect(session.companies[0].code).toBe("YENI-1"); // uppercase'e normalize edilir

    const companyId = session.companies[0].id as string;
    // Gerçek `/api/me` çağrısı: kurucu hem admin hem manager rolüyle geldiğini kanıtlar (uydurma değil).
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${session.token}`, "x-company-id": companyId } });
    expect(me.statusCode).toBe(200);
    const meBody = me.json();
    expect(meBody.roles.sort()).toEqual(["admin", "manager"]);
    expect(meBody.permissions).toContain("product.view");
    expect(meBody.permissions).toContain("admin.users");

    // Hazır şablon gerçekten uygulanmış: 7 varsayılan departman (seed.ts ile aynı fonksiyon).
    const departments = await app.inject({ method: "GET", url: "/api/setup/status", headers: { authorization: `Bearer ${session.token}`, "x-company-id": companyId } });
    expect(departments.statusCode).toBe(200);
    const status = departments.json();
    expect(status.departmentCount).toBe(7);
    expect(status.memberCount).toBe(1);
    expect(status.teamInvited).toBe(false);
    expect(status.dataImported).toBe(false);
    expect(status.firstProductCreated).toBe(false);

    // Deneme aboneliği gerçekten atanmış (W42'nin kurduğu mantık, uydurulmadı).
    const sub = await app.inject({ method: "GET", url: "/api/subscription", headers: { authorization: `Bearer ${session.token}`, "x-company-id": companyId } });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().status).toBe("trial");
  });

  it("'tüm işleri ben yapıyorum' seçilirse kurucu iş rollerini de alır ve ilk ürününü açabilir", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/setup/company",
      payload: { companyName: "Tek Kişilik Ltd.", companyCode: "tek-1", adminName: "Kurucu", adminEmail: "kurucu@tek.test", adminPassword: "kurucu-parola-1", founderDoesAll: true },
    });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    const h = { authorization: `Bearer ${s.token}`, "x-company-id": s.companies[0].id };
    const me = (await app.inject({ method: "GET", url: "/api/me", headers: h })).json();
    expect(me.roles.sort()).toEqual(["accounting", "admin", "manager", "production", "purchasing", "quality", "rd", "sales", "warehouse"]);
    expect(me.permissions).toContain("product.create");
    expect(me.roles).not.toContain("subcontractor");
    expect(me.roles).not.toContain("technician");
  });

  it("mükerrer şirket kodu reddedilir", async () => {
    await app.inject({
      method: "POST",
      url: "/api/setup/company",
      payload: { companyName: "İlk", companyCode: "TEKRAR-1", adminName: "Ada", adminEmail: "ilk@tekrar.test", adminPassword: "parola-1234" },
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/setup/company",
      payload: { companyName: "İkinci", companyCode: "tekrar-1", adminName: "Beta", adminEmail: "ikinci@tekrar.test", adminPassword: "parola-1234" },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("duplicate_code");
  });

  it("zaten kayıtlı e-posta ile ikinci kurulum reddedilir (hangi parolanın geçerli olacağı uydurulmaz)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/setup/company",
      payload: { companyName: "Üçüncü", companyCode: "UCUNCU-1", adminName: "Ceyda", adminEmail: "tekrar-eposta@test.com", adminPassword: "parola-1234" },
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/setup/company",
      payload: { companyName: "Dördüncü", companyCode: "DORDUNCU-1", adminName: "Deniz", adminEmail: "tekrar-eposta@test.com", adminPassword: "baska-parola-1" },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("existing_account");
  });

  it("iki farklı yeni şirket birbirinden RLS ile tamamen izole (T18 deseniyle tutarlı)", async () => {
    const r1 = await app.inject({
      method: "POST",
      url: "/api/setup/company",
      payload: { companyName: "İzolasyon A", companyCode: "IZOA-1", adminName: "Ada", adminEmail: "izoa@test.com", adminPassword: "parola-1234" },
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/api/setup/company",
      payload: { companyName: "İzolasyon B", companyCode: "IZOB-1", adminName: "Beta", adminEmail: "izob@test.com", adminPassword: "parola-1234" },
    });
    const s1 = r1.json();
    const s2 = r2.json();
    // B'nin oturumuyla A'nın şirket kimliği verilirse üyelik bulunamaz → 403.
    const cross = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${s2.token}`, "x-company-id": s1.companies[0].id },
    });
    expect(cross.statusCode).toBe(403);
  });

  it("geçersiz şirket kodu (özel karakter) reddedilir", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/setup/company",
      payload: { companyName: "Geçersiz", companyCode: "geçersiz kod!", adminName: "Erol", adminEmail: "gecersiz@test.com", adminPassword: "parola-1234" },
    });
    expect(r.statusCode).toBe(400);
  });
});
