// Oturum 41 — yerel diskteki nesneleri S3 uyumlu depolamaya (MinIO / yurt içi S3 uyumlu servis) taşır.
//
// Güvenli sıra: nesne yerelden okunur → kayıtlı sha256 ile karşılaştırılır → S3'e Content-MD5 ile yazılır → geri okunup
// sha256 yeniden doğrulanır → ANCAK BUNDAN SONRA satırın storage_backend değeri 's3' yapılır. Yerel dosya SİLİNMEZ
// (doğrulama sonrası silmek işletmecinin kararıdır). Uygulama okumayı satırın storage_backend değerine göre yaptığı için
// (lib/storage.ts storageFor) taşıma sırasında kesinti olmaz; betik tekrar çalıştırılabilir (yalnız 'local' satırları taşır).
//
// Kullanım (varsayılan KURU ÇALIŞMA — yalnız rapor):
//   MIGRATION_DATABASE_URL=... STORAGE_LOCAL_DIR=... S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
//     node scripts/migrate-storage.mjs [--apply]

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { isMainModule, OBJECT_TABLES } from "./backup.mjs";

export { OBJECT_TABLES };

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export async function runMigrateStorage({ databaseUrl, localDir, s3, apply, log = console.log }) {
  const client = new S3Client({ endpoint: s3.endpoint, region: s3.region, forcePathStyle: s3.forcePathStyle, credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } });
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const summary = { found: 0, moved: 0, missing: 0, mismatch: 0, errors: [] };
  try {
    const companies = (await db.query(`select id from companies order by created_at`)).rows;
    for (const co of companies) {
      // RLS: şirket bağlamı + yedek kapsamı (birebir mesaj ekleri dahil tüm satırlar görünür).
      await db.query(`select set_config('app.company_id', $1, false), set_config('app.system_scope', 'backup', false)`, [co.id]);
      for (const t of OBJECT_TABLES) {
        const rows = (await db.query(
          `select id, ${t.key} as key${t.sha ? `, ${t.sha} as sha` : ""} from ${t.table} where ${t.key} is not null and ${t.backend} = 'local' order by id`,
        )).rows;
        for (const r of rows) {
          summary.found++;
          let data;
          try {
            data = await readFile(path.join(localDir, r.key));
          } catch {
            summary.missing++;
            summary.errors.push(`${t.table}/${r.id}: yerel dosya yok (${r.key})`);
            continue;
          }
          if (r.sha && sha256(data) !== r.sha) {
            summary.mismatch++;
            summary.errors.push(`${t.table}/${r.id}: yerel dosya özeti kayıtla uyuşmuyor — taşınmadı`);
            continue;
          }
          if (!apply) continue;
          try {
            await client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: r.key, Body: data, ContentLength: data.length, ContentMD5: createHash("md5").update(data).digest("base64") }));
            const back = await client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: r.key }));
            const got = Buffer.from(await back.Body.transformToByteArray());
            if (sha256(got) !== sha256(data)) throw new Error("geri okunan içerik uyuşmuyor");
            await db.query(`update ${t.table} set ${t.backend} = 's3' where id = $1 and ${t.backend} = 'local'`, [r.id]);
            summary.moved++;
          } catch (e) {
            summary.errors.push(`${t.table}/${r.id}: ${e.message}`);
          }
        }
      }
    }
  } finally {
    await db.end();
  }
  log(`${apply ? "Taşıma" : "KURU ÇALIŞMA"}: ${summary.found} nesne bulundu, ${summary.moved} taşındı, ${summary.missing} yerelde yok, ${summary.mismatch} özet uyuşmazlığı.`);
  for (const e of summary.errors) log(`  - ${e}`);
  if (!apply) log("Gerçekten taşımak için --apply ile çalıştırın. Yerel dosyalar silinmez.");
  return summary;
}

if (isMainModule(import.meta.url)) {
  const env = process.env;
  const need = ["MIGRATION_DATABASE_URL", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
  if (need.length) {
    console.error(`Eksik ortam değişkeni: ${need.join(", ")}`);
    process.exit(2);
  }
  runMigrateStorage({
    databaseUrl: env.MIGRATION_DATABASE_URL,
    localDir: env.STORAGE_LOCAL_DIR ?? path.join(process.cwd(), "data", "objects"),
    s3: { endpoint: env.S3_ENDPOINT, region: env.S3_REGION || "tr-1", bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true") !== "false" },
    apply: process.argv.includes("--apply"),
  })
    .then((s) => process.exit(s.errors.length ? 1 : 0))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
