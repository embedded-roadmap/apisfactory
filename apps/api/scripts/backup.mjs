// R46 — Yedek, geri yükleme ve kesintide talimat erişimi (W37 §28: "Veri tabanı, dosya, yapılandırma
// ve anahtar kurtarma planı birlikte çalışsın. Şifreli yedek ayrı hata alanında tutulsun.").
//
// TASARIM NOTU (dürüstlük): pg_dump'ı apis_owner (şema sahibi) ile doğrudan çalıştırmak yeterli
// DEĞİLDİR — 111 şirket-kapsamlı tablonun tamamında `force row level security` var, bu da tablo
// SAHİBİNİ de RLS'e tabi kılar; app.company_id ayarlanmamış bir oturumda bu tablolardan HİÇBİR satır
// görünmez (doğrudan `psql` ile doğrulandı: app.company_id yokken `select count(*) from items` 0
// döner, ayarlandığında gerçek satır sayısını döner). apis_owner'a BYPASSRLS vermek bunu çözerdi ama
// bu, hiçbir HTTP isteğinin kullanmadığı bir rolün yetkisini gerçek bir güvenlik gevşetmesiyle
// genişletmek anlamına gelirdi (Claude'un otomatik izin sınıflandırıcısı bu denemeyi "Security Weaken"
// olarak reddetti — haklı bir uyarıydı, geri alındı).
//
// Bunun yerine: her şirket için sırayla `app.company_id` ayarlanıp o şirketin GERÇEKTEN görünür olan
// satırları `\copy` ile dışa yazılır — yedekleme, uygulamanın kendi RLS sınırını hiç ihlal etmeden, tam
// olarak onun izin verdiği görünürlükle çalışır. (`companies` tablosu tek istisna: migration 006 ile
// FORCE RLS zaten kapatılmıştır — ilk şirket satırının oluşturulabilmesi için — bu script o kararı
// değiştirmez, yalnızca var olan görünürlüğü kullanır.)
//
// `users` tablosunda RLS hiç yok; apis_owner tablo sahibi olduğundan password_hash dahil tüm sütunları
// görür. Bu, R47'nin (şirket veri/dosya çıkış paketi — parola HARİÇ) kasıtlı olarak FARKLI bir kapsamı:
// R46 gerçek bir felaket kurtarma yedeğidir, kullanıcıların parola sıfırlamadan giriş yapabilmesi
// gerekir; R47 kullanıcıya kendi verisini vermek içindir, parola asla sızdırmaz.
//
// `sessions` tablosu BİLİNÇLİ OLARAK yedeklenmez — eski oturum jetonlarının geri yükleme sonrası hâlâ
// geçerli sayılması gereksiz bir güvenlik riski olurdu; herkes yeniden giriş yapar (normal pratik).
//
// Kullanım: BACKUP_ENCRYPTION_KEY=... node scripts/backup.mjs
// Önkoşul: MIGRATION_DATABASE_URL şema sahibine işaret etmeli; BACKUP_ENCRYPTION_KEY ZORUNLU (yoksa
// script şifresiz yedek YAZMAZ — "şifreli yedek" gereksinimi kod düzeyinde zorlanır).
// BACKUP_DIR: yedeğin yazılacağı dizin (varsayılan data/backups) — GERÇEK bir dağıtımda bu STORAGE_
// LOCAL_DIR ile aynı diskte/hostta OLMAMALI ("ayrı hata alanı", W37 §28); hangi ayrı disk/host/bulut
// depolamanın kullanılacağı bir dağıtım/DevOps kararıdır (dış bağımlılık) — bu script yalnızca hedef
// dizine yazar, o dizinin fiziksel olarak nerede olduğuna karışmaz.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = path.resolve(new URL("../migrations", import.meta.url).pathname);
const STORAGE_LOCAL_DIR = process.env.STORAGE_LOCAL_DIR ?? path.join(process.cwd(), "data", "objects");
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(process.cwd(), "data", "backups");
const MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL ?? "postgres://apis_owner:owner_dev_pw@localhost:5432/apisfactory";

/** Migration dosyalarını sırayla tarayıp `create table` ifadelerinden GERÇEK oluşturma/bağımlılık
 * sırasını çıkarır — restore bu sırayla insert ederse FK ihlali olmaz (bir tablo, referans verdiği
 * tablo yaratılmadan yaratılamayacağından, bu zaten şemanın kendi bağımlılık sırasıdır). */
export async function tableCreationOrder(migrationsDir = MIGRATIONS_DIR) {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const order = [];
  const seen = new Set();
  for (const f of files) {
    const sql = await readFile(path.join(migrationsDir, f), "utf8");
    const re = /create table\s+(?:if not exists\s+)?([a-z_][a-z0-9_]*)/gi;
    let m;
    while ((m = re.exec(sql))) {
      const t = m[1].toLowerCase();
      if (!seen.has(t)) {
        seen.add(t);
        order.push(t);
      }
    }
  }
  return order;
}

/** Verilen tablo kümesindeki (child) TÜM foreign key kısıtlarını, tam yeniden-oluşturma tanımlarıyla
 * (pg_get_constraintdef) birlikte döner. Restore, veriyi YÜKLEMEDEN ÖNCE bunların tümünü kaldırıp
 * TÜM veri yüklendikten SONRA aynı tanımla yeniden ekler — bu, hem migration dosyalarının "create
 * table" GÖRÜNME sırasının gerçek FK bağımlılık sırasıyla uyuşmadığı durumları (gerçek bir restore
 * denemesinde görüldü: `purchase_order_lines`, ona bağımlı olduğu `purchase_orders`'tan çok önceki bir
 * migration'da tanımlanmış) hem de DÖNGÜSEL FK'leri (gerçek denemede görüldü: `rfqs.awarded_quote` ↔
 * `rfq_quotes.rfq_id`) tek bir mekanizmayla, hiçbir elle sıralama gerektirmeden çözer — pg_dump/
 * pg_restore'un kendi verileri geri yüklerken kısıtları sona bırakmasıyla aynı, standart bir toplu-
 * yükleme pratiğidir; RLS/güvenlik sınırıyla ilgisi yoktur. */
export async function foreignKeysOn(client, tables) {
  const r = await client.query(
    `select conrelid::regclass::text as table_name, conname as name, pg_get_constraintdef(oid) as definition
       from pg_constraint
      where contype = 'f' and connamespace = 'public'::regnamespace and conrelid::regclass::text = any($1::text[])`,
    [tables],
  );
  return r.rows;
}

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Güvensiz tablo adı: ${name}`);
  return `"${name}"`;
}

/** psql'in `\copy` istemci-taraflı komutuyla bir tabloyu CSV'ye döker; gerekirse önce app.company_id
 * ayarlar. Aynı psql çağrısı içindeki iki -c bayrağı AYNI oturumu (bağlantıyı) paylaşır, bu yüzden
 * SET (SET LOCAL değil) burada güvenle kalıcıdır. */
export function copyTableToCsv(url, table, outFile, companyId) {
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", url];
  if (companyId) args.push("-c", `select set_config('app.company_id', '${companyId}', false)`);
  args.push("-c", `\\copy (select * from ${quoteIdent(table)}) to '${outFile}' with csv header`);
  const r = spawnSync("psql", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`COPY başarısız (${table}): ${r.stderr}`);
}

/** Şemadaki `generated always as identity` sütunlu tabloları, bu sütunun BAŞKA bir tablodan FK ile
 * referans alıp almadığıyla birlikte döner. Gerçek şema sorgulanarak bulundu (varsayım değil): yalnızca
 * connector_calls, document_dispatches, events, lot_costs, outbox, stock_moves, subscription_events
 * identity sütuna sahip ve BUNLARIN HİÇBİRİ başka bir tablodan FK ile referans alınmıyor — yani kimliği
 * (id) her zaman sadece o tablonun kendi içinde anlamlıdır, dışarıdan hiçbir referans bağlı değildir. */
export async function identityColumnInfo(client) {
  const identityCols = await client.query(
    `select table_name, column_name from information_schema.columns where table_schema = 'public' and is_identity = 'YES'`,
  );
  const referenced = await client.query(
    `select distinct ccu.table_name from information_schema.table_constraints tc
       join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'`,
  );
  const referencedTables = new Set(referenced.rows.map((r) => r.table_name));
  const map = new Map();
  for (const row of identityCols.rows) {
    map.set(row.table_name, { column: row.column_name, preserve: referencedTables.has(row.table_name) });
  }
  return map;
}

/** Şemadaki "yayımlandıktan/kapandıktan/kesildikten sonra değiştirilemez" iş kuralı tetikleyicilerini
 * (ör. `bom_lines_guard`, `customer_invoices_guard`) bulur — bunlar RLS/güvenlikle İLGİSİZ, saf iş
 * kuralı denetimleridir ("yayımlanmış BOM sürümü değiştirilemez" vb.). Geri yükleme, KAYNAK
 * veritabanında zaten bu kuralları geçmiş gerçek geçmiş veriyi aynen yeniden oynattığından (yeni bir
 * ihlal YARATMAZ), bu tetikleyiciler yükleme sırasında geçici olarak devre dışı bırakılıp hemen sonra
 * yeniden etkinleştirilir — pg_dump/pg_restore'un kendi verileri geri yüklerken kısıt/tetikleyicileri
 * sona bırakmasıyla aynı, standart bir toplu-yükleme pratiğidir. */
export async function guardTriggers(client) {
  const r = await client.query(
    `select distinct event_object_table as table_name, trigger_name from information_schema.triggers where trigger_name like '%\\_guard' escape '\\' order by 1`,
  );
  return r.rows;
}

/** Bir CSV'yi tabloya geri yükler. `company_id` verilen (RLS'e tabi) tablolarda doğrudan
 * `COPY ... FROM` KULLANILAMAZ — PostgreSQL, FORCE ROW LEVEL SECURITY altındaki bir tabloya COPY FROM
 * yapılmasını, satır sahibi (owner) dahil, KOŞULSUZ reddeder ("COPY FROM not supported with row-level
 * security" — gerçek test ortamında karşılaşılıp doğrulandı, varsayım değil). BYPASSRLS bunu çözerdi
 * ama bu yol daha önce güvenlik gevşetmesi olarak reddedildi ve tekrar denenmeyecek.
 *
 * Bunun yerine: RLS'siz bir GEÇİCİ (temp) tabloya `COPY FROM` ile hızlıca yüklenir (temp tabloların
 * politikası yoktur, kısıtlama uygulanmaz), sonra sıradan bir `INSERT INTO ... SELECT ...` ile asıl
 * tabloya taşınır — INSERT, COPY'nin aksine RLS'nin WITH CHECK politikasına tabidir, yani bu adım
 * yalnızca `app.company_id` ile eşleşen satırların asıl tabloya girmesine izin verir; uygulamanın kendi
 * güvenlik sınırı burada da tam olarak korunur, hiçbir yetki genişletilmez.
 *
 * `identity`: o tablo için identityColumnInfo() sonucundan gelen { column, preserve } (yoksa undefined).
 * preserve=false olan (referans alınmayan) identity sütunlu tablolarda eski id DEĞERİ korunmaz — INSERT
 * sütun listesinden çıkarılır ve veritabanı YENİ bir id üretir. Bunun nedeni pratik: bu proje boyunca
 * farklı demo/E2E şirketleri ayrı seed akışlarıyla oluşturulduğundan, sırayla numaralanan bu tablolarda
 * (ör. outbox) şirketler arası id çakışması yaşanabiliyor (gerçek geri yükleme denemesinde görüldü);
 * hiçbir tablo bu id'lere FK ile bağlı olmadığından yeni id üretmek veri kaybı YARATMAZ. */
export function copyCsvIntoTable(url, table, inFile, companyId, identity) {
  const t = quoteIdent(table);
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", url];
  if (companyId) {
    args.push("-c", `select set_config('app.company_id', '${companyId}', false)`);
    args.push("-c", `create temp table _restore_stage (like ${t} including all)`);
    args.push("-c", `\\copy _restore_stage from '${inFile}' with csv header`);
    if (identity && !identity.preserve) {
      const colsRes = spawnSync(
        "psql",
        [
          "-X", "-t", "-A", "-q", "-v", "ON_ERROR_STOP=1", url,
          "-c",
          `select string_agg(quote_ident(column_name), ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = '${table}' and column_name <> '${identity.column}'`,
        ],
        { encoding: "utf8" },
      );
      if (colsRes.status !== 0) throw new Error(`Sütun listesi alınamadı (${table}): ${colsRes.stderr}`);
      const cols = colsRes.stdout.trim();
      args.push("-c", `insert into ${t} (${cols}) select ${cols} from _restore_stage`);
    } else {
      args.push("-c", `insert into ${t} overriding system value select * from _restore_stage`);
    }
    args.push("-c", `drop table _restore_stage`);
  } else {
    args.push("-c", `\\copy ${t} from '${inFile}' with csv header`);
  }
  const r = spawnSync("psql", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Geri yükleme COPY başarısız (${table}): ${r.stderr}`);
}

function countCsvRows(file) {
  if (!existsSync(file)) return 0;
  const r = spawnSync("bash", ["-c", `tail -n +2 "${file}" | wc -l`], { encoding: "utf8" });
  return Number(r.stdout.trim()) || 0;
}

async function companyScopedTables(client) {
  const r = await client.query(
    `select distinct c.table_name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'company_id'`,
  );
  return new Set(r.rows.map((row) => row.table_name));
}

async function main() {
  const ENC_KEY = process.env.BACKUP_ENCRYPTION_KEY;
  if (!ENC_KEY) {
    console.error("HATA: BACKUP_ENCRYPTION_KEY tanımlı değil — şifresiz yedek yazılmaz (W37 §28: 'şifreli yedek ayrı hata alanında tutulsun'). Durduruldu.");
    process.exit(1);
  }

  const t0 = Date.now();
  const client = new pg.Client({ connectionString: MIGRATION_DATABASE_URL });
  await client.connect();
  const work = await mkdtemp(path.join(tmpdir(), "apisfactory-backup-"));
  const companyDir = path.join(work, "companies");
  const globalDir = path.join(work, "global");
  await mkdir(companyDir, { recursive: true });
  await mkdir(globalDir, { recursive: true });

  try {
    const scoped = await companyScopedTables(client);
    const created = await tableCreationOrder();
    const order = created.filter((t) => scoped.has(t));
    const missing = [...scoped].filter((t) => !order.includes(t));
    const fullOrder = [...order, ...missing];

    for (const t of ["users", "companies"]) {
      copyTableToCsv(MIGRATION_DATABASE_URL, t, path.join(globalDir, `${t}.csv`), null);
    }
    // subscription_plans GERİ YÜKLEME için COPY edilmez — bu bir uygulama verisi değil, şema/referans
    // katalogudur ve migration 041 tarafından zaten şemayla birlikte (her seferinde YENİ rastgele id
    // ile) yeniden oluşturulur; doğrudan geri COPY etmeye çalışmak unique kod çakışması verir (gerçekten
    // test edilip görüldü). Yine de burada (id, code) olarak dökülür — restore.mjs, eski id'lerin hangi
    // koda ait olduğunu bulup companies.subscription_plan_id / subscription_events.*_plan_id gibi
    // referansları hedefin YENİ id'lerine eşlemek için bunu kullanır (kod her migration çalışmasında
    // sabit kalır, id değil).
    copyTableToCsv(MIGRATION_DATABASE_URL, "subscription_plans", path.join(globalDir, "subscription_plans.csv"), null);

    const companies = (await client.query(`select id, code from companies order by created_at`)).rows;
    let totalRows = 0;
    for (const co of companies) {
      const dir = path.join(companyDir, co.id);
      await mkdir(dir, { recursive: true });
      for (const t of fullOrder) {
        const outFile = path.join(dir, `${t}.csv`);
        copyTableToCsv(MIGRATION_DATABASE_URL, t, outFile, co.id);
        totalRows += countCsvRows(outFile);
      }
      console.log(`  şirket ${co.code} (${co.id}) yedeklendi — ${fullOrder.length} tablo`);
    }

    const filesDir = path.join(work, "files");
    if (existsSync(STORAGE_LOCAL_DIR)) {
      await mkdir(filesDir, { recursive: true });
      execFileSync("bash", ["-c", `cp -r "${STORAGE_LOCAL_DIR}"/. "${filesDir}"/ 2>/dev/null || true`]);
    }

    await writeFile(
      path.join(work, "manifest.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), companies: companies.map((c) => ({ id: c.id, code: c.code })), tableCount: fullOrder.length, totalRows }, null, 2),
    );

    await mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tarPath = path.join(work, "backup.tar.gz");
    const encPath = path.join(BACKUP_DIR, `apisfactory-backup-${stamp}.tar.gz.enc`);

    const tarArgs = ["-czf", tarPath, "-C", work, "manifest.json", "global", "companies"];
    if (existsSync(filesDir)) tarArgs.push("files");
    execFileSync("tar", tarArgs, { stdio: "inherit" });

    const enc = spawnSync("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-in", tarPath, "-out", encPath, "-pass", `pass:${ENC_KEY}`], { stdio: "inherit" });
    if (enc.status !== 0) throw new Error("openssl şifreleme başarısız");

    const { size } = await stat(encPath);
    const secs = (Date.now() - t0) / 1000;
    console.log(`\nYedek tamam: ${encPath} (${(size / 1024 / 1024).toFixed(2)} MB, ${secs.toFixed(1)} sn, ${companies.length} şirket, ${totalRows} satır)`);
    console.log(`Bu dizin (${BACKUP_DIR}) GERÇEK bir dağıtımda ${STORAGE_LOCAL_DIR}'dan ayrı bir disk/host'a taşınmalıdır (W37 §28 "ayrı hata alanı") — bu script bunu yapmaz, bir sonraki adım operasyon kararıdır.`);
    return { encPath, companies: companies.length, totalRows, seconds: secs };
  } finally {
    await client.end();
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { main as runBackup };
