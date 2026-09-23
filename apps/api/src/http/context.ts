import type { FastifyReply, FastifyRequest } from "fastify";
import { DELEGABLE_PERMISSIONS, type Permission } from "@apisfactory/shared";
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
  /** Vekâletle gelen izin → vekâlet veren kullanıcı (kendi izni olan eklenmez). */
  delegated: Record<string, string>;
  /** Aktif vekâlet verenler ve rolleri (görev listesi ve limit hesabı için). */
  delegators: { userId: string; roles: string[]; permissions: string[] }[];
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
  if (!companyId) return { userId, sessionId, companyId: null, roles: [], permissions: new Set(), delegated: {}, delegators: [] };

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
    const own = new Set(perms.rows.map((r) => r.permission as string).filter(Boolean));
    // Vekâlet (prompt §5): süreli, kapsamlı; yalnızca vekâlet verenin hâlâ sahip olduğu onay izinleri geçer.
    const dl = await db.query(
      `select d.delegator_user_id, d.permissions,
              array_agg(distinct r.code) filter (where r.code is not null) as roles,
              array_agg(distinct rp.permission) filter (where rp.permission is not null) as perms
         from delegations d
         join memberships m on m.user_id = d.delegator_user_id and m.company_id = app_company_id() and m.status = 'active'
         left join membership_roles mr on mr.membership_id = m.id left join roles r on r.id = mr.role_id
         left join role_permissions rp on rp.role_id = r.id
        where d.delegate_user_id = $1 and d.revoked_at is null and now() >= d.valid_from and now() < d.valid_to
        group by d.id, d.delegator_user_id, d.permissions`,
      [userId],
    );
    const delegated: Record<string, string> = {};
    const delegators: { userId: string; roles: string[]; permissions: string[] }[] = [];
    for (const d of dl.rows) {
      const granted = (d.permissions as string[]).filter((p) => (d.perms ?? []).includes(p) && (DELEGABLE_PERMISSIONS as readonly string[]).includes(p));
      if (!granted.length) continue;
      delegators.push({ userId: d.delegator_user_id, roles: d.roles ?? [], permissions: granted });
      for (const p of granted) if (!own.has(p) && !delegated[p]) delegated[p] = d.delegator_user_id;
    }
    return {
      roles: [...new Set(perms.rows.map((r) => r.role as string))],
      permissions: new Set([...own, ...Object.keys(delegated)]),
      delegated,
      delegators,
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
    fn(db, { companyId: c.companyId, userId: c.userId, kind: "human", correlationId, onBehalfOf: perm ? c.delegated[perm] : undefined }),
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
