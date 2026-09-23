import type { FastifyInstance } from "fastify";
import { LoginInput, type Me, type Session, type Permission } from "@apisfactory/shared";
import { withUser } from "../db/pool";
import { config } from "../config";
import { signToken, verifyPassword } from "../lib/auth";
import { AppError } from "../lib/errors";
import { ctxOf, parse, requireCompany, tenant } from "../http/context";

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", { config: { public: true } }, async (req) => {
    const input = parse(LoginInput, req.body);
    // Kullanıcı bulunamasa da aynı hata: hesap varlığı sızdırılmaz.
    const invalid = new AppError(401, "invalid_credentials", "E-posta veya parola hatalı");
    const user = await withUser(null, async (db) => {
      const r = await db.query("select * from auth_lookup_user($1)", [input.email]);
      return r.rows[0] as { id: string; email: string; name: string; password_hash: string } | undefined;
    });
    if (!user || !(await verifyPassword(input.password, user.password_hash))) throw invalid;

    return withUser(user.id, async (db) => {
      const s = await db.query(
        "insert into sessions (user_id, expires_at) values ($1, now() + make_interval(hours => $2)) returning id",
        [user.id, config.sessionHours],
      );
      const companies = await db.query(
        `select c.id, c.name, c.code from companies c join memberships m on m.company_id = c.id
          where m.user_id = $1 and m.status = 'active' order by c.name`,
        [user.id],
      );
      const session: Session = {
        token: await signToken(user.id, s.rows[0].id),
        user: { id: user.id, email: user.email, name: user.name },
        companies: companies.rows,
      };
      return session;
    });
  });

  app.post("/api/auth/logout", async (req) => {
    const c = ctxOf(req);
    await withUser(c.userId, (db) => db.query("update sessions set revoked_at = now() where id = $1", [c.sessionId]));
    return { ok: true };
  });

  app.get("/api/companies", async (req) => {
    const c = ctxOf(req);
    return withUser(c.userId, async (db) => {
      const r = await db.query(
        `select c.id, c.name, c.code, c.is_demo as "isDemo" from companies c join memberships m on m.company_id = c.id
          where m.user_id = $1 and m.status = 'active' order by c.name`,
        [c.userId],
      );
      return r.rows;
    });
  });

  app.get("/api/me", async (req): Promise<Me> => {
    const c = requireCompany(req);
    return tenant(req, null, async (db) => {
      const u = await db.query("select id, email, name from users where id = $1", [c.userId]);
      const co = await db.query("select id, name, code from companies where id = app_company_id()");
      return {
        user: u.rows[0],
        company: co.rows[0],
        roles: c.roles,
        permissions: [...c.permissions] as Permission[],
      };
    });
  });
}
