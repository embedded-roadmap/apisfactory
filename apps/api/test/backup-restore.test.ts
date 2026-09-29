/**
 * R46 — Yedek, geri yükleme ve kesintide talimat erişimi (W37 §28: "Geri yükleme tatbikatında
 * kayıt-dosya-yetki ilişkisini doğrula."). Bu test GERÇEK `backup.mjs`/`restore.mjs` script'lerini,
 * gerçek bir KAYNAK ve gerçek (ayrı, scratch) bir HEDEF Postgres veritabanına karşı uçtan uca çalıştırır
 * — hiçbir adım mock'lanmaz. "Kayıt" (satır sayısı uzlaşması) ve "dosya" (sha256 bütünlüğü) doğrulaması
 * zaten restore.mjs'in kendi raporunda var; bu test onu tüketir. Buraya EK olarak spec'in "yetki"
 * bacağını ekler: restore.mjs'in kendi yorumunda "ayrıca test/backup-restore.test.ts'de gerçek bir
 * ikinci API sunucusu ile doğrulanır" dediği kısım — bkz. scripts/restore-login-probe.mts.
 *
 * Hedef veritabanı, apis_owner'ın CREATEDB yetkisi olmadığından (bilinçli bir sınır — bkz. restore.mjs
 * başlığı), bir PostgreSQL YÖNETİCİ bağlantısıyla oluşturulur/silinir: TEST_ADMIN_DATABASE_URL (varsayılan:
 * docker-compose'daki `postgres` kullanıcısı). Bu bağlantı kurulamazsa Linux'ta eski yol (`sudo -n -u postgres
 * psql`) denenir. Oturum 41'den beri betikler ve bu test psql/bash/pnpm gerektirmez — Windows'ta da koşar.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool } from "../src/db/pool";

const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const SOURCE_MIGRATION_URL = process.env.MIGRATION_DATABASE_URL!;
const TARGET_DB_NAME = `apisfactory_br_test_${Date.now()}`;
const TARGET_MIGRATION_URL = `postgres://apis_owner:owner_dev_pw@localhost:5432/${TARGET_DB_NAME}`;
const TARGET_APP_URL = `postgres://apis_app:app_dev_pw@localhost:5432/${TARGET_DB_NAME}`;

let app: FastifyInstance;
let owner: pg.Client;
let workDir: string;
let email: string;
let password: string;
let companyCode: string;
let taskTitle: string;

/** Yönetici SQL'i: önce doğrudan yönetici bağlantısı; kurulamazsa (Linux sandbox) sudo + psql. */
async function admin(sql: string, database?: string) {
  const url = new URL(ADMIN_URL);
  if (database) url.pathname = `/${database}`;
  const c = new pg.Client({ connectionString: url.toString() });
  try {
    await c.connect();
  } catch (connectError) {
    if (process.platform === "win32") throw new Error(`Yönetici bağlantısı kurulamadı (${ADMIN_URL}): ${(connectError as Error).message}`);
    const r = spawnSync("sudo", ["-n", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", ...(database ? ["-d", database] : []), "-c", sql], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Yönetici psql başarısız: ${r.stderr || r.stdout}`);
    return;
  }
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: SOURCE_MIGRATION_URL });
  await owner.connect();
  await owner.query("drop schema public cascade; create schema public; grant usage on schema public to apis_app;");
  await migrate(SOURCE_MIGRATION_URL, () => {});
  app = await buildApp();

  password = "yedek-tatbikat-parola-1";
  email = `backup-restore-${Date.now()}@test.com`;
  companyCode = `BR-${Date.now()}`;
  taskTitle = "Yedek tatbikatı test görevi";

  const signup = await app.inject({
    method: "POST",
    url: "/api/setup/company",
    payload: { companyName: "Yedek Tatbikat Ltd.", companyCode, adminName: "Kurucu Yönetici", adminEmail: email, adminPassword: password },
  });
  expect(signup.statusCode).toBe(200);
  const s = signup.json();
  const t = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { authorization: `Bearer ${s.token}`, "x-company-id": s.companies[0].id },
    payload: { title: taskTitle, assigneeUserId: s.user.id },
  });
  expect(t.statusCode).toBe(200);

  workDir = await mkdtemp(path.join(tmpdir(), "backup-restore-test-"));

  await admin(`drop database if exists ${TARGET_DB_NAME}`);
  await admin(`create database ${TARGET_DB_NAME} owner apis_owner`);
  await admin(`grant connect on database ${TARGET_DB_NAME} to apis_app`, TARGET_DB_NAME);
  await admin("grant usage, create on schema public to apis_owner", TARGET_DB_NAME);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await owner.end();
  await closePool();
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  await admin(`drop database if exists ${TARGET_DB_NAME}`);
}, 30_000);

describe("R46: yedekleme ve geri yükleme tatbikatı (gerçek script'ler, gerçek veritabanları)", () => {
  it(
    "gerçek yedek alınır, gerçek bir hedefe geri yüklenir; kayıt/dosya doğrulaması GEÇER ve restore sonrası GERÇEK giriş + RLS izolasyonu çalışır",
    async () => {
      const backupDir = path.join(workDir, "backups");
      const storageDir = path.join(workDir, "restored-objects");

      // backup.mjs/restore.mjs, ortam değişkenlerini MODÜL YÜKLENİRKEN (bir kez) okur — bu yüzden
      // dinamik import, değişkenler ayarlandıktan SONRA yapılır (statik import olsaydı bu test
      // dosyasının üstündeki import'lar, değişkenler ayarlanmadan ÖNCE değerlendirilirdi).
      process.env.BACKUP_DIR = backupDir;
      process.env.BACKUP_ENCRYPTION_KEY = "test-suite-yedek-anahtari";
      // STORAGE_LOCAL_DIR kasıtlı olarak DEĞİŞTİRİLMEZ — kaynağın gerçek nesne dizini zaten var olmayan
      // bir test dizinine değiştirilirse backup.mjs onu boş bulur (mevcut nesneler yanlışlıkla atlanmaz,
      // sadece bu testin şirketi hiç dosya eki oluşturmadığından döngü boş satırla geçer — bu dürüst bir
      // no-op'tur, sahte bir PASS değil).
      // @ts-expect-error - .mjs script'lerinin tip tanımı yok, yalnızca çalışma zamanında JS olarak import edilir
      const { runBackup } = await import("../scripts/backup.mjs");
      const backupResult = await runBackup();
      expect(backupResult.encPath).toBeTruthy();
      expect(backupResult.totalRows).toBeGreaterThan(0);

      // @ts-expect-error - .mjs script'lerinin tip tanımı yok, yalnızca çalışma zamanında JS olarak import edilir
      const { runRestore } = await import("../scripts/restore.mjs");
      const restoreResult = await runRestore({
        backupFile: backupResult.encPath,
        targetMigrationUrl: TARGET_MIGRATION_URL,
        targetStorageDir: storageDir,
        encryptionKey: "test-suite-yedek-anahtari",
      });

      // ---- KAYIT + DOSYA (restore.mjs'in kendi doğrulaması) ----
      expect(restoreResult.pass).toBe(true);
      expect(restoreResult.rowCountOk).toBe(true);
      expect(restoreResult.fileIntegrityOk).toBe(true);
      expect(restoreResult.restoredRows).toBe(backupResult.totalRows);

      // ---- YETKİ (RLS/rol) — gerçek ikinci bir API sunucusu, ayrı süreçte, restore edilmiş hedefe
      // bağlanır ve backup ÖNCESİ oluşturulan gerçek kullanıcıyla GERÇEKTEN giriş yapar. ----
      const probe = spawnSync(process.execPath, ["--import", "tsx", "scripts/restore-login-probe.mts"], {
        cwd: API_DIR,
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: TARGET_APP_URL,
          MIGRATION_DATABASE_URL: TARGET_MIGRATION_URL,
          PROBE_EMAIL: email,
          PROBE_PASSWORD: password,
        },
      });
      if (probe.status !== 0) throw new Error(`restore-login-probe başarısız: ${probe.stderr || probe.stdout}`);
      const lastLine = probe.stdout.trim().split("\n").filter(Boolean).pop()!;
      const probeResult = JSON.parse(lastLine);

      expect(probeResult.ok).toBe(true);
      expect(probeResult.loginStatus).toBe(200); // restore edilmiş password_hash ile GERÇEK giriş çalıştı
      expect(probeResult.meStatus).toBe(200);
      expect(probeResult.me.company.code).toBe(companyCode); // doğru (ve TEK) şirket
      expect(probeResult.companyCount).toBe(1); // başka hiçbir şirkete üyelik "sızmamış"

      // ---- KAYIT — sadece satır SAYISI değil, GERÇEK içerik: backup öncesi oluşturulan görev, aynı
      // başlıkla hedefte gerçekten var mı? ----
      const check = new pg.Client({ connectionString: TARGET_MIGRATION_URL });
      await check.connect();
      try {
        await check.query(`select set_config('app.company_id', $1, false)`, [probeResult.companyId]);
        const r = await check.query(`select title from tasks where title = $1`, [taskTitle]);
        expect(r.rows).toHaveLength(1);
      } finally {
        await check.end();
      }
    },
    120_000,
  );
});
