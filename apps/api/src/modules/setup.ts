import type { FastifyInstance } from "fastify";
import { CompanySetupInput, type Session } from "@apisfactory/shared";
import { withUser, withTenant } from "../db/pool";
import { config } from "../config";
import { hashPassword, signToken } from "../lib/auth";
import { conflict } from "../lib/errors";
import { ctxOf, parse, requireCompany } from "../http/context";
import { createCompany, createUser } from "../db/seed";

/**
 * R39: Hazır akışlarla hızlı şirket kurulumu (ana talimat §10 tablo satırı; §25 "Başlangıç"
 * ekran grubu — şirket kurulumu, kullanıcı daveti, birimler, roller, veri yükleme, ilk üretim
 * rehberi). Önceden yalnızca `db/seed.ts`'teki `createCompany`/`createUser` migration script'inden
 * çağrılabiliyordu (W42 devamında yeni şirketler otomatik "deneme" paketiyle başlıyordu ama bu yalnız
 * seed script'ine özeldi) — kendi kendine (self-serve) gerçek bir kurulum ucu yoktu. Bu modül aynı
 * hazır şablonu (varsayılan roller, departmanlar, iş merkezleri, konumlar, deneme aboneliği —
 * W42'nin zaten kurduğu mantık) `POST /api/setup/company` üzerinden herkese açık, kimliksiz bir uçla
 * gerçekten çalıştırır; uydurma bir "sihirbaz arayüzü" değil, gerçek kayıt oluşturan bir uçtur.
 *
 * Kalan adımlar (kullanıcı daveti, departman/rol düzenleme, veri yükleme, ilk ürün) YENİDEN
 * İCAT EDİLMEDİ — mevcut `/admin`, `/imports`, `/products`, `/help` ekranları zaten bunları
 * karşılıyor; `GET /api/setup/status` bu adımların gerçek ilerleme durumunu (uydurma değil, gerçek
 * satır sayılarından) okuyup bir kontrol listesi olarak sunar.
 */
export async function setupRoutes(app: FastifyInstance) {
  app.post("/api/setup/company", { config: { public: true } }, async (req): Promise<Session> => {
    const input = parse(CompanySetupInput, req.body);

    return withUser(null, async (db) => {
      const existingCode = await db.query(`select 1 from companies where code = $1`, [input.companyCode]);
      if (existingCode.rowCount) throw conflict("duplicate_code", "Bu şirket kodu zaten kullanımda");
      const existingUser = await db.query(`select 1 from users where email = $1`, [input.adminEmail]);
      // Aynı e-posta ile ikinci bir kurulum, hangi parolanın geçerli olacağı belirsizliğini
      // uydurmadan reddedilir — zaten hesabı olan biri normal girişten mevcut şirketine ulaşır,
      // yeni şirket için ayrı bir e-posta kullanır (memberships zaten çoklu şirket destekler).
      if (existingUser.rowCount) throw conflict("existing_account", "Bu e-posta zaten kayıtlı; giriş yapıp yeni şirket için farklı bir e-posta kullanın");

      const a = await createCompany(db, { code: input.companyCode, name: input.companyName, isDemo: false });
      // İlk kullanıcı hem sistem yöneticisi (admin.users/admin.roles) hem de yönetici (iş kararları)
      // yetkisiyle başlar — kurucu şirketi gerçekten çalıştırabilsin diye; ayrı roller sonradan
      // /admin'den istendiği gibi düzenlenebilir.
      const userId = await createUser(db, {
        email: input.adminEmail,
        name: input.adminName,
        password: input.adminPassword,
        companyId: a.companyId,
        roles: ["admin", "manager"],
        roleIds: a.roleIds,
      });

      // Girişle aynı oturum açma deseni (auth.ts) — kurulumdan hemen sonra sihirbaza devam edilsin.
      await db.query(`select set_config('app.user_id', $1, true)`, [userId]);
      const s = await db.query(
        "insert into sessions (user_id, expires_at) values ($1, now() + make_interval(hours => $2)) returning id",
        [userId, config.sessionHours],
      );
      return {
        token: await signToken(userId, s.rows[0].id),
        user: { id: userId, email: input.adminEmail, name: input.adminName },
        companies: [{ id: a.companyId, name: input.companyName, code: input.companyCode }],
      };
    });
  });

  /** Kurulum kontrol listesi: gerçek satır sayılarından — hiçbir adım "tamamlandı" diye uydurulmaz. */
  app.get("/api/setup/status", async (req) => {
    const c = requireCompany(req);
    ctxOf(req);
    return withTenant({ companyId: c.companyId, userId: c.userId }, async (db) => {
      const [members, departments, imports, products, workOrders] = await Promise.all([
        db.query(`select count(*)::int as n from memberships where company_id = app_company_id() and status = 'active'`),
        db.query(`select count(*)::int as n from departments where company_id = app_company_id()`),
        db.query(`select count(*)::int as n from import_jobs where company_id = app_company_id()`),
        db.query(`select count(*)::int as n from products where company_id = app_company_id()`),
        db.query(`select count(*)::int as n from work_orders where company_id = app_company_id()`),
      ]);
      return {
        companyCreated: true,
        teamInvited: members.rows[0].n > 1,
        memberCount: members.rows[0].n,
        departmentCount: departments.rows[0].n,
        dataImported: imports.rows[0].n > 0,
        importCount: imports.rows[0].n,
        firstProductCreated: products.rows[0].n > 0,
        productCount: products.rows[0].n,
        firstWorkOrderCreated: workOrders.rows[0].n > 0,
      };
    });
  });
}
