import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { withUser, type Db } from "../db/pool";
import { hashPassword, verifyPassword } from "../lib/auth";
import { AppError, conflict, notFound, badRequest } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { ctxOf, parse, tenant } from "../http/context";

/**
 * Kullanıcı ve rol yönetimi (prompt §5).
 * - Yetki değişiklikleri olay defterine yazılır.
 * - Kimse kendi rollerini değiştiremez (kendine yetki verme engeli).
 * - E-posta bağlayıcısı olmadığından geçici parola bir kez gösterilir; kullanıcı ilk girişte değiştirmelidir.
 */
export async function adminRoutes(app: FastifyInstance) {
  app.get("/api/admin/roles", async (req) =>
    tenant(req, "admin.users", async (db) => {
      const r = await db.query(
        `select r.id, r.code, r.name, coalesce(array_agg(rp.permission order by rp.permission) filter (where rp.permission is not null), '{}') as permissions
           from roles r left join role_permissions rp on rp.role_id = r.id group by r.id order by r.name`,
      );
      return r.rows;
    }),
  );

  app.get("/api/admin/users", async (req) =>
    tenant(req, "admin.users", async (db) => {
      const r = await db.query(
        `select m.id as "membershipId", u.id as "userId", u.email, u.name, m.status, m.is_external as "isExternal",
                coalesce(array_agg(r.code order by r.code) filter (where r.code is not null), '{}') as roles
           from memberships m join users u on u.id = m.user_id
           left join membership_roles mr on mr.membership_id = m.id left join roles r on r.id = mr.role_id
          where m.company_id = app_company_id()
          group by m.id, u.id order by u.name`,
      );
      return r.rows;
    }),
  );

  /**
   * Kendi rolünü değiştirme kuralı: normalde yasak (kimse kendine yetki vermesin). Tek istisna: şirkette rolleri yönetebilen
   * (admin.roles) BAŞKA etkin üye yoksa — aksi halde tek yöneticili şirket kendine hiç iş rolü ekleyemez. Bu durumda gerekçe
   * zorunlu, rol yönetimi yetkisi kaldırılamaz (şirket kilitlenmesin) ve olay "selfChange" olarak kaydedilir.
   */
  async function otherRoleManagers(db: Db, membershipId: string) {
    return Number((await db.query(
      `select count(distinct m.id) n from memberships m join membership_roles mr on mr.membership_id = m.id
         join role_permissions rp on rp.role_id = mr.role_id
        where m.company_id = app_company_id() and m.status = 'active' and m.id <> $1 and rp.permission = 'admin.roles'`,
      [membershipId],
    )).rows[0].n);
  }

  app.get("/api/admin/self-role-change", async (req) =>
    tenant(req, "admin.roles", async (db, actor) => {
      const m = (await db.query(`select id from memberships where user_id = $1 and company_id = app_company_id()`, [actor.userId])).rows[0];
      return { allowed: Boolean(m) && (await otherRoleManagers(db, m.id)) === 0 };
    }),
  );

  app.post("/api/admin/users", async (req) => {
    const input = parse(
      z.object({ email: z.string().email(), name: z.string().min(2).max(120), roles: z.array(z.string()).min(1), isExternal: z.boolean().default(false) }),
      req.body,
    );
    return tenant(req, "admin.users", async (db, actor) => {
      const temporaryPassword = randomBytes(9).toString("base64url");
      const ensured = (await db.query(`select * from admin_ensure_invited_user($1, $2, $3)`, [input.email, input.name, await hashPassword(temporaryPassword)])).rows[0];
      const userId = ensured.user_id as string;
      if (userId === actor.userId) throw conflict("self_change", "Kendi üyeliğinizi bu ekrandan değiştiremezsiniz");
      const existing = await db.query(`select id from memberships where user_id = $1 and company_id = app_company_id()`, [userId]);
      if (existing.rows[0]) throw conflict("duplicate", "Bu kullanıcı şirkette zaten var");
      const m = await db.query(
        `insert into memberships (company_id, user_id, is_external) values (app_company_id(), $1, $2) returning id`,
        [userId, input.isExternal],
      );
      const roles = await db.query(`select id, code from roles where code = any($1)`, [input.roles]);
      if (roles.rowCount !== input.roles.length) throw conflict("unknown_role", "Bilinmeyen rol");
      for (const r of roles.rows) await db.query(`insert into membership_roles (company_id, membership_id, role_id) values (app_company_id(), $1, $2)`, [m.rows[0].id, r.id]);
      await recordEvent(db, actor, { entityType: "membership", entityId: m.rows[0].id, eventType: "created", after: { email: input.email, roles: input.roles } });
      // Yeni hesaplarda geçici parola döner; hesabı zaten olan kullanıcının parolası değiştirilmez.
      return { membershipId: m.rows[0].id, userId, temporaryPassword: ensured.created ? temporaryPassword : null };
    });
  });

  app.post("/api/admin/users/:membershipId/roles", async (req) => {
    const { membershipId } = req.params as { membershipId: string };
    const input = parse(z.object({ roles: z.array(z.string()), reason: z.string().trim().max(500).optional() }), req.body);
    return tenant(req, "admin.roles", async (db, actor) => {
      const m = await db.query(`select id, user_id from memberships where id = $1 and company_id = app_company_id() for update`, [membershipId]);
      if (!m.rows[0]) throw notFound("Üyelik");
      const self = m.rows[0].user_id === actor.userId;
      if (self && (await otherRoleManagers(db, membershipId)) > 0) throw conflict("self_change", "Kendi rollerinizi değiştiremezsiniz; başka bir yöneticiden isteyin");
      if (self && (input.reason ?? "").length < 10) throw badRequest("Kendi rolünüzü değiştirirken gerekçe zorunlu (en az 10 karakter)");
      const before = await db.query(`select r.code from membership_roles mr join roles r on r.id = mr.role_id where mr.membership_id = $1`, [membershipId]);
      const roles = await db.query(`select id, code from roles where code = any($1)`, [input.roles]);
      if (roles.rowCount !== input.roles.length) throw conflict("unknown_role", "Bilinmeyen rol");
      if (self) {
        const keeps = (await db.query(`select 1 from role_permissions where role_id = any($1) and permission = 'admin.roles' limit 1`, [roles.rows.map((r) => r.id)])).rowCount;
        if (!keeps) throw conflict("last_admin", "Şirketin tek yöneticisi olarak rol yönetimi yetkinizi kaldıramazsınız; önce başka bir yönetici ekleyin");
      }
      await db.query(`delete from membership_roles where membership_id = $1`, [membershipId]);
      for (const r of roles.rows) await db.query(`insert into membership_roles (company_id, membership_id, role_id) values (app_company_id(), $1, $2)`, [membershipId, r.id]);
      await recordEvent(db, actor, { entityType: "membership", entityId: membershipId, eventType: "roles.changed", before: before.rows.map((x) => x.code), after: input.roles, ...(self ? { reason: `Kendi rolünü değiştirdi (şirketin tek yöneticisi): ${input.reason}` } : {}) });
      return { membershipId, roles: input.roles };
    });
  });

  app.post("/api/admin/users/:membershipId/status", async (req) => {
    const { membershipId } = req.params as { membershipId: string };
    const input = parse(z.object({ status: z.enum(["active", "suspended"]), reason: z.string().min(3) }), req.body);
    return tenant(req, "admin.users", async (db, actor) => {
      const m = await db.query(`select id, user_id, status from memberships where id = $1 and company_id = app_company_id() for update`, [membershipId]);
      if (!m.rows[0]) throw notFound("Üyelik");
      if (m.rows[0].user_id === actor.userId) throw conflict("self_change", "Kendi üyeliğinizi askıya alamazsınız");
      await db.query(`update memberships set status = $2 where id = $1`, [membershipId, input.status]);
      await recordEvent(db, actor, { entityType: "membership", entityId: membershipId, eventType: `status.${input.status}`, before: { status: m.rows[0].status }, after: { status: input.status }, reason: input.reason });
      return { membershipId, status: input.status };
    });
  });

  /** Parola değiştirme: mevcut parola doğrulanır; diğer oturumlar sonlandırılır. */
  app.post("/api/auth/password", async (req) => {
    const c = ctxOf(req);
    const input = parse(z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }), req.body);
    if (input.next === input.current) throw new AppError(400, "password_unchanged", "Yeni parola mevcut paroladan farklı olmalı");
    await withUser(c.userId, async (db) => {
      const hash = (await db.query(`select auth_password_hash() as h`)).rows[0].h as string;
      if (!(await verifyPassword(input.current, hash))) throw new AppError(400, "invalid_credentials", "Mevcut parola hatalı");
      await db.query(`select set_config('app.session_id', $1, true)`, [c.sessionId]);
      await db.query(`select auth_set_password($1)`, [await hashPassword(input.next)]);
    });
    return { ok: true };
  });
}
