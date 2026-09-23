import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { config } from "../config";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/** Sıralı SQL migration'larını şema sahibi rolüyle uygular. Uygulananlar schema_migrations tablosunda tutulur. */
export async function migrate(url = config.migrationDatabaseUrl, log = console.log) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name as string));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(dir, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [f]);
        await client.query("commit");
        log(`migration uygulandı: ${f}`);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`migration başarısız: ${f}: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().then(
    () => console.log("migration tamam"),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
