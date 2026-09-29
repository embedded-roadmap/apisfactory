// R46 — Yedek, geri yükleme ve kesintide talimat erişimi (W37 §28: "Geri yükleme tatbikatında
// kayıt-dosya-yetki ilişkisini doğrula.").
//
// GÜVENLİK: bu script yeni bir veritabanı OLUŞTURMAZ (apis_owner'ın CREATEDB yetkisi yok — bu bilinçli
// bir sınırdır, gerçek dağıtımda veritabanı hazırlama bir DBA/altyapı kararıdır). Hedef veritabanı
// ÖNCEDEN VAR olmalı (boş olabilir) ve `--target-migration-url` bu hedefe işaret
// etmelidir. Hedef, çalışan MIGRATION_DATABASE_URL/DATABASE_URL ile AYNI olamaz — yanlışlıkla canlı
// veritabanının üzerine yazılmasını önlemek için bu script bunu reddeder.
//
// Adımlar: 1) yedeği çöz/aç, 2) hedefe TAM ŞEMAYI gerçek migration script'iyle uygula (kod tekrarı
// yok — `src/db/migrate.ts` aynen çağrılır), 3) global tabloları (subscription_plans, users,
// companies) geri yükle, 4) her şirket için `app.company_id` ayarlayıp kendi tablolarını RLS sınırı
// içinde geri yükle (yaratma sırasına göre — FK ihlali olmaz), 5) dosya eklerini hedef depolama
// dizinine aç, 6) DOĞRULA: satır sayısı uzlaşması + her dosya ekinin gerçekten diskte olup sha256'sının
// eşleştiği kontrolü ("kayıt-dosya ilişkisi"). "Yetki" (RLS/rol) doğrulaması ayrıca
// `test/backup-restore.test.ts`'de gerçek bir ikinci API sunucusu hedefe bağlanıp gerçek giriş
// yapılarak yapılır — bu script yalnızca veri/dosya bütünlüğünü kontrol eder.
//
// Kullanım:
//   BACKUP_ENCRYPTION_KEY=... node scripts/restore.mjs <yedek-dosyası.tar.gz.enc> \
//     --target-migration-url postgres://apis_owner:...@host/hedef_db \
//     --target-storage-dir /path/to/restored-objects

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import pg from "pg";
import { copyCsvIntoTable, copyDirectory, countCsvRows, decryptFile, extractArchive, foreignKeysOn, guardTriggers, identityColumnInfo, isMainModule } from "./backup.mjs";

// subscription_plans HİÇ COPY EDİLMEZ (bkz. backup.mjs) — hedef veritabanında migration 041 kendi
// satırlarını KENDİ (yeni, rastgele) id'leriyle zaten oluşturur. Bu yüzden yedekteki eski
// subscription_plan_id / from_plan_id / to_plan_id değerleri hedefte YOK olan id'lere işaret eder.
// Çözüm: yedekteki subscription_plans.csv yalnızca (eski id → code) eşlemesi için okunur (code,
// migration'lar arasında SABİT kalan tek alan); hedefteki gerçek satırlardan (code → yeni id) eşlemesi
// çıkarılır; ikisi birleştirilip bu 3 FK sütunu restore sonrasında yeni id'lere göre GÜNCELLENİR.
async function buildPlanIdRemap(work, targetClient) {
  const f = path.join(work, "global", "subscription_plans.csv");
  if (!existsSync(f)) return new Map();
  const raw = await readFile(f, "utf8");
  const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const oldIdToCode = new Map(parsed.data.map((row) => [row.id, row.code]));
  const target = await targetClient.query(`select id, code from subscription_plans`);
  const codeToNewId = new Map(target.rows.map((r) => [r.code, r.id]));
  const remap = new Map();
  for (const [oldId, code] of oldIdToCode) {
    const newId = codeToNewId.get(code);
    if (newId) remap.set(oldId, newId);
  }
  return remap;
}

const API_DIR = fileURLToPath(new URL("..", import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Güvensiz tablo adı: ${name}`);
  return `"${name}"`;
}

export async function runRestore({ backupFile, targetMigrationUrl, targetStorageDir, encryptionKey }) {
  if (!encryptionKey) throw new Error("BACKUP_ENCRYPTION_KEY gerekli — yedek şifreli");
  if (!targetMigrationUrl) throw new Error("--target-migration-url gerekli");
  if (targetMigrationUrl === (process.env.MIGRATION_DATABASE_URL ?? "")) {
    throw new Error("Hedef, çalışan MIGRATION_DATABASE_URL ile aynı olamaz — canlı veritabanının üzerine yazılmasını önlemek için durduruldu.");
  }

  const t0 = Date.now();
  const work = await mkdtemp(path.join(tmpdir(), "apisfactory-restore-"));
  try {
    const tarPath = path.join(work, "backup.tar.gz");
    await decryptFile(backupFile, tarPath, encryptionKey);
    await extractArchive(tarPath, work);

    const manifest = JSON.parse(await readFile(path.join(work, "manifest.json"), "utf8"));
    console.log(`Yedek çözüldü: ${manifest.createdAt}, ${manifest.companies.length} şirket, ${manifest.totalRows} satır (kaydedilmiş)`);

    console.log("Şema uygulanıyor (gerçek migration script'i, hedef veritabanına)...");
    // Aynı Node çalıştırıcısı + tsx yükleyicisi (pnpm'in PATH'te olması gerekmez — Windows dahil).
    const migrateResult = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], {
      cwd: API_DIR,
      env: { ...process.env, MIGRATION_DATABASE_URL: targetMigrationUrl },
      encoding: "utf8",
    });
    if (migrateResult.status !== 0) throw new Error(`Şema uygulama başarısız: ${migrateResult.stderr || migrateResult.stdout}`);
    console.log(migrateResult.stdout.trim().split("\n").slice(-3).join("\n"));

    // İlk şirketin dizin listesi, yedeklenen tüm şirket-kapsamlı tablo adlarının tam kümesini verir
    // (backup.mjs her şirket için AYNI fullOrder kümesini, boş olsa bile başlık satırıyla yazar).
    const firstCompanyDir = manifest.companies.length > 0 ? path.join(work, "companies", manifest.companies[0].id) : null;
    const allTableNames = firstCompanyDir && existsSync(firstCompanyDir)
      ? (await readdir(firstCompanyDir)).filter((f) => f.endsWith(".csv")).map((f) => f.replace(/\.csv$/, ""))
      : [];
    const allRestoreTables = ["users", "companies", ...allTableNames];

    // subscription_plans id remap (bkz. buildPlanIdRemap yorumu): yedekteki companies/subscription_events
    // satırları hedefte ARTIK VAR OLMAYAN eski plan id'lerini taşıyor. Bu yüzden — ve genel olarak
    // hiçbir tablonun yaratma/yükleme sırasını elle çözmek zorunda kalmamak için (bkz. foreignKeysOn
    // yorumu: hem migration-sırası hem döngüsel FK sorunları gerçek denemede görüldü) — TÜM foreign
    // key kısıtları veri yüklenmeden önce kaldırılır, veri HERHANGİ bir sırada yüklenir, id'ler
    // eşlenir/temizlenir, sonra TÜMÜ aynı tanımla yeniden eklenir (bu noktada tüm değerler geçerlidir).
    // Bu, hedef veritabanının KENDİ sahibi (apis_owner) olarak yapılan sıradan bir DDL işlemidir —
    // RLS/güvenlik sınırıyla ilgisi yoktur, hiçbir yetki genişletilmez.
    const ddlClient = new pg.Client({ connectionString: targetMigrationUrl });
    await ddlClient.connect();
    let guards;
    let droppedFks;
    let identityInfo;
    try {
      guards = await guardTriggers(ddlClient);
      for (const g of guards) await ddlClient.query(`alter table ${quoteIdent(g.table_name)} disable trigger ${quoteIdent(g.trigger_name)}`);
      if (guards.length > 0) console.log(`${guards.length} iş kuralı tetikleyicisi (ör. "yayımlanmış değiştirilemez") geri yükleme süresince geçici olarak devre dışı bırakıldı — kaynakta zaten geçerli olan geçmiş veri yeniden oynatılıyor, yeni bir ihlal yok.`);

      droppedFks = await foreignKeysOn(ddlClient, allRestoreTables);
      for (const fk of droppedFks) await ddlClient.query(`alter table ${quoteIdent(fk.table_name)} drop constraint ${quoteIdent(fk.name)}`);
      console.log(`${droppedFks.length} foreign key kısıtı veri yüklemesi süresince geçici olarak kaldırıldı — tüm veri yüklendikten sonra aynı tanımla yeniden eklenecek.`);

      identityInfo = await identityColumnInfo(ddlClient);
    } finally {
      await ddlClient.end();
    }

    const globalDir = path.join(work, "global");
    // Tüm COPY yüklemeleri tek bağlantı üzerinden (şirket bağlamı her tabloda yeniden ayarlanır).
    const loadClient = new pg.Client({ connectionString: targetMigrationUrl });
    await loadClient.connect();
    let planIdRemap;
    let restoredRows = 0;
    try {
      for (const t of ["users", "companies"]) {
        const f = path.join(globalDir, `${t}.csv`);
        if (existsSync(f)) await copyCsvIntoTable(loadClient, t, f, null);
      }

      const remapClient = new pg.Client({ connectionString: targetMigrationUrl });
      await remapClient.connect();
      try {
        planIdRemap = await buildPlanIdRemap(work, remapClient);
        let companiesRemapped = 0;
        for (const [oldId, newId] of planIdRemap) {
          const r = await remapClient.query(`update companies set subscription_plan_id = $1 where subscription_plan_id = $2`, [newId, oldId]);
          companiesRemapped += r.rowCount ?? 0;
        }
        if (planIdRemap.size > 0) console.log(`subscription_plans id eşlemesi: ${planIdRemap.size} paket kodu eşlendi, companies.subscription_plan_id ${companiesRemapped} satırda güncellendi`);
      } finally {
        await remapClient.end();
      }

      for (const co of manifest.companies) {
        const dir = path.join(work, "companies", co.id);
        if (!existsSync(dir)) continue;
        const files = (await readdir(dir)).filter((f) => f.endsWith(".csv"));
        const tablesHere = files.map((f) => f.replace(/\.csv$/, ""));
        for (const t of tablesHere) {
          const f = path.join(dir, `${t}.csv`);
          await copyCsvIntoTable(loadClient, t, f, co.id, identityInfo.get(t));
          restoredRows += await countCsvRows(f);
        }

        // subscription_events.from_plan_id / to_plan_id da aynı şekilde eski plan id'lerini taşır —
        // FORCE RLS altında olduğu için şirketin kendi app.company_id bağlamında güncellenmeli.
        if (tablesHere.includes("subscription_events") && planIdRemap.size > 0) {
          const evClient = new pg.Client({ connectionString: targetMigrationUrl });
          await evClient.connect();
          try {
            await evClient.query("begin");
            await evClient.query(`select set_config('app.company_id', $1, true), set_config('app.system_scope', 'backup', true)`, [co.id]);
            for (const [oldId, newId] of planIdRemap) {
              await evClient.query(`update subscription_events set from_plan_id = $1 where from_plan_id = $2`, [newId, oldId]);
              await evClient.query(`update subscription_events set to_plan_id = $1 where to_plan_id = $2`, [newId, oldId]);
            }
            await evClient.query("commit");
          } finally {
            await evClient.end();
          }
        }

        console.log(`  şirket ${co.code} geri yüklendi — ${tablesHere.length} tablo`);
      }
    } finally {
      await loadClient.end();
    }

    // Kısıtları yeniden ekle. Kod eşleşmesi bulunamayan (artık var olmayan bir paket koduna işaret
    // eden) satırlar varsa önce NULL'a çekilir — sessizce veri kaybı değil, dürüstçe raporlanan bir
    // durum (aşağıdaki details listesine düşer).
    const planRefColumns = [
      { table: "companies", col: "subscription_plan_id" },
      { table: "subscription_events", col: "from_plan_id" },
      { table: "subscription_events", col: "to_plan_id" },
    ];
    const restoreDdlClient = new pg.Client({ connectionString: targetMigrationUrl });
    await restoreDdlClient.connect();
    let orphanedPlanRefs = 0;
    try {
      for (const c of planRefColumns) {
        const r = await restoreDdlClient.query(
          `update ${quoteIdent(c.table)} set ${quoteIdent(c.col)} = null where ${quoteIdent(c.col)} is not null and ${quoteIdent(c.col)} not in (select id from subscription_plans)`,
        );
        orphanedPlanRefs += r.rowCount ?? 0;
      }
      for (const fk of droppedFks) {
        await restoreDdlClient.query(`alter table ${quoteIdent(fk.table_name)} add constraint ${quoteIdent(fk.name)} ${fk.definition}`);
      }
      for (const g of guards) await restoreDdlClient.query(`alter table ${quoteIdent(g.table_name)} enable trigger ${quoteIdent(g.trigger_name)}`);
    } finally {
      await restoreDdlClient.end();
    }
    if (orphanedPlanRefs > 0) console.log(`UYARI: ${orphanedPlanRefs} satırda eşlenemeyen paket referansı NULL'a çekildi (hedefte karşılık gelen paket kodu bulunamadı)`);
    console.log(`${droppedFks.length} foreign key kısıtı yeniden eklendi.`);

    let filesRestored = 0;
    const filesDir = path.join(work, "files");
    if (existsSync(filesDir) && targetStorageDir) {
      filesRestored = await copyDirectory(filesDir, targetStorageDir);
    }

    // ---- DOĞRULAMA -----------------------------------------------------------------------------
    const client = new pg.Client({ connectionString: targetMigrationUrl });
    await client.connect();
    const report = { rowCountOk: true, fileIntegrityOk: true, details: [] };
    try {
      const rowCheck = await client.query(`select count(*)::int as n from companies`);
      report.details.push(`companies tablosu: ${rowCheck.rows[0].n} satır (beklenen ${manifest.companies.length})`);
      if (rowCheck.rows[0].n !== manifest.companies.length) report.rowCountOk = false;

      if (manifest.totalRows !== restoredRows) {
        report.rowCountOk = false;
        report.details.push(`UYUŞMAZLIK: yedekte ${manifest.totalRows} satır kaydedilmişti, geri yüklemede ${restoredRows} satır işlendi`);
      } else {
        report.details.push(`Satır sayısı uzlaşması: yedek=${manifest.totalRows}, geri yüklenen=${restoredRows} — eşleşti`);
      }

      if (targetStorageDir && filesDir && existsSync(filesDir)) {
        for (const co of manifest.companies) {
          await client.query("begin");
          await client.query(`select set_config('app.company_id', $1, true), set_config('app.system_scope', 'backup', true)`, [co.id]);
          const atts = await client.query(`select object_key as "objectKey", sha256 from message_attachments where object_key is not null`);
          for (const row of atts.rows) {
            const p = path.join(targetStorageDir, row.objectKey);
            if (!existsSync(p)) {
              report.fileIntegrityOk = false;
              report.details.push(`EKSİK DOSYA: ${row.objectKey}`);
              continue;
            }
            const actual = createHash("sha256").update(readFileSync(p)).digest("hex");
            if (actual !== row.sha256) {
              report.fileIntegrityOk = false;
              report.details.push(`SHA256 UYUŞMAZLIĞI: ${row.objectKey}`);
            } else {
              report.details.push(`Dosya doğrulandı: ${row.objectKey} (sha256 eşleşti)`);
            }
          }
          await client.query("commit");
        }
      }
    } finally {
      await client.end();
    }

    const seconds = (Date.now() - t0) / 1000;
    const pass = report.rowCountOk && report.fileIntegrityOk;
    console.log(`\n${pass ? "GEÇTİ" : "BAŞARISIZ"} — geri yükleme tatbikatı (${seconds.toFixed(1)} sn)`);
    report.details.forEach((d) => console.log(`  - ${d}`));
    return { pass, seconds, filesRestored, restoredRows, ...report };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  runRestore({
    backupFile: args._[0],
    targetMigrationUrl: args["target-migration-url"],
    targetStorageDir: args["target-storage-dir"],
    encryptionKey: process.env.BACKUP_ENCRYPTION_KEY,
  })
    .then((r) => process.exit(r.pass ? 0 : 1))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
