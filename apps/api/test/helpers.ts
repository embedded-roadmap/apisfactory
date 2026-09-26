import pg from "pg";
import type { FastifyInstance } from "fastify";
import type { RoleCode } from "@apisfactory/shared";
import { buildApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { createCompany, createUser } from "../src/db/seed";

export const PASSWORD = "test-password-1";

export type World = {
  app: FastifyInstance;
  owner: pg.Client;
  a: { companyId: string; locations: Record<string, string>; roleIds: Record<string, string> };
  b: { companyId: string; locations: Record<string, string>; roleIds: Record<string, string> };
};

/** Test veri tabanını sıfırlar, migration'ları uygular, iki ayrı şirket ve rol kullanıcıları açar. */
export async function setupWorld(): Promise<World> {
  const url = process.env.MIGRATION_DATABASE_URL!;
  const owner = new pg.Client({ connectionString: url });
  await owner.connect();
  await owner.query("drop schema public cascade; create schema public; grant usage on schema public to apis_app;");
  await migrate(url, () => {});

  const a = await createCompany(owner, { code: "A", name: "Şirket A" });
  const roles: RoleCode[] = ["rd", "production", "quality", "warehouse", "sales", "purchasing", "admin", "technician", "manager", "accounting"];
  for (const r of roles) await createUser(owner, { email: `${r}@a.test`, name: `A ${r}`, password: PASSWORD, companyId: a.companyId, roles: [r], roleIds: a.roleIds });
  const b = await createCompany(owner, { code: "B", name: "Şirket B" });
  await createUser(owner, {
    email: "all@b.test",
    name: "B herkes",
    password: PASSWORD,
    companyId: b.companyId,
    roles: ["rd", "production", "quality", "warehouse", "sales", "purchasing", "manager"],
    roleIds: b.roleIds,
  });
  const app = await buildApp();
  return { app, owner, a, b };
}

const tokens = new Map<string, string>();

export async function login(app: FastifyInstance, email: string): Promise<string> {
  const cached = tokens.get(email);
  if (cached) return cached;
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  if (r.statusCode !== 200) throw new Error(`login ${email}: ${r.body}`);
  const t = r.json().token as string;
  tokens.set(email, t);
  return t;
}

export function clearTokens() {
  tokens.clear();
}

export type Call = { status: number; body: any };

export async function call(
  app: FastifyInstance,
  as: string,
  companyId: string,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Call> {
  const token = await login(app, as);
  const r = await app.inject({
    method,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${token}`, "x-company-id": companyId, ...headers },
  });
  let body: any = r.body;
  try {
    body = r.json();
  } catch {
    /* metin yanıt */
  }
  return { status: r.statusCode, body };
}

export function expectOk(c: Call): any {
  if (c.status >= 300) throw new Error(`HTTP ${c.status}: ${JSON.stringify(c.body)}`);
  return c.body;
}
