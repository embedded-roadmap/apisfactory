import pg from "pg";
import { config } from "../config";

// numeric → string (kayan nokta dönüşümü yok); date → 'YYYY-MM-DD' string.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => v); // bigint

export type Db = pg.PoolClient;

let appPool: pg.Pool | null = null;
export function pool(): pg.Pool {
  if (!appPool) appPool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
  return appPool;
}

export async function closePool() {
  await appPool?.end();
  appPool = null;
}

export type TenantCtx = { companyId: string; userId: string };

/**
 * Her iş işlemi tek bir veri tabanı işleminde, şirket ve kullanıcı bağlamı ayarlanarak çalışır.
 * RLS politikaları bu bağlama göre satırları süzer; hata olursa bütün işlem geri alınır.
 */
export async function withTenant<T>(ctx: TenantCtx, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)", [ctx.companyId, ctx.userId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Şirket seçilmeden önce (giriş, şirket listesi) yalnızca kullanıcı bağlamıyla çalışır. */
export async function withUser<T>(userId: string | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.user_id', $1, true)", [userId ?? ""]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}
