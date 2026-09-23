import type { FastifyReply, FastifyRequest } from "fastify";
import type { Permission } from "@apisfactory/shared";
import type { ZodTypeAny, output } from "zod";
import { withTenant, withUser, type Db } from "../db/pool";
import { verifyToken } from "../lib/auth";
import { AppError, badRequest, forbidden } from "../lib/errors";
import type { Actor } from "../lib/records";

export type ReqCtx = {
  userId: string;
  sessionId: string;
  companyId: string | null;
  roles: string[];
  permissions: Set<string>;
};

declare module "fastify" {
  interface FastifyRequest {
    ctx?: ReqCtx;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kimlik ve şirket kapsamı: token doğrulanır, oturumun iptal edilmediği kontrol edilir,
 * X-Company-Id başlığındaki şirket için aktif üyelik ve izinler veri tabanından okunur.
 * Şirket kimliği istemcinin iddiası olarak kabul edilmez (prompt §28).
 */
export async function authenticate(req: FastifyRequest): Promise<ReqCtx> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new AppError(401, "unauthenticated", "Oturum gerekli");
  let userId: string;
  let sessionId: string;
  try {
    ({ userId, sessionId } = await verifyToken(header.slice(7)));
  } catch {
    throw new AppError(401, "unauthenticated", "Oturum geçersiz veya süresi dolmuş");
  }

  const active = await withUser(userId, async (db) => {
    const r = await db.query("select 1 from sessions where id = $1 and revoked_at is null and expires_at > now()", [sessionId]);
    return r.rowCount === 1;
  });
  if (!active) throw new AppError(401, "unauthenticated", "Oturum sonlandırılmış");

  const rawCompany = req.headers["x-company-id"];
  const companyId = typeof rawCompany === "string" && UUID.test(rawCompany) ? rawCompany : null;
  if (!companyId) return { userId, sessionId, companyId: null, roles: [], permissions: new Set() };

  const access = await withTenant({ companyId, userId }, async (db) => {
    const m = await db.query(
      "select id, is_external from memberships where company_id = app_company_id() and user_id = $1 and status = 'active'",
      [userId],
    );
    if (m.rowCount !== 1) return null;
    const perms = await db.query(
      `select distinct r.code as role, rp.permission
         from membership_roles mr join roles r on r.id = mr.role_id
         left join role_permissions rp on rp.role_id = r.id
        where mr.membership_id = $1`,
      [m.rows[0].id],
    );
    return {
      roles: [...new Set(perms.rows.map((r) => r.role as string))],
      permissions: new Set(perms.rows.map((r) => r.permission as string).filter(Boolean)),
    };
  });
  if (!access) throw forbidden();
  return { userId, sessionId, companyId, ...access };
}

export function ctxOf(req: FastifyRequest): ReqCtx {
  if (!req.ctx) throw new AppError(401, "unauthenticated", "Oturum gerekli");
  return req.ctx;
}

export function requireCompany(req: FastifyRequest): ReqCtx & { companyId: string } {
  const c = ctxOf(req);
  if (!c.companyId) throw badRequest("X-Company-Id başlığı gerekli");
  return c as ReqCtx & { companyId: string };
}

export function can(req: FastifyRequest, perm: Permission): boolean {
  return ctxOf(req).permissions.has(perm);
}

export function need(req: FastifyRequest, perm: Permission) {
  if (!can(req, perm)) throw forbidden(perm);
}

/** Yetki kontrolü + şirket bağlamlı işlem. */
export async function tenant<T>(req: FastifyRequest, perm: Permission | null, fn: (db: Db, actor: Actor & { userId: string }) => Promise<T>): Promise<T> {
  const c = requireCompany(req);
  if (perm) need(req, perm);
  const correlationId = typeof req.headers["x-correlation-id"] === "string" && UUID.test(req.headers["x-correlation-id"]) ? req.headers["x-correlation-id"] : undefined;
  return withTenant({ companyId: c.companyId, userId: c.userId }, (db) =>
    fn(db, { companyId: c.companyId, userId: c.userId, kind: "human", correlationId }),
  );
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest("Girdi doğrulanamadı", r.error.flatten());
  return r.data;
}

export function idempotencyKey(req: FastifyRequest): string | undefined {
  const k = req.headers["idempotency-key"];
  return typeof k === "string" && k.length > 0 && k.length <= 200 ? k : undefined;
}

export type Reply = FastifyReply;
