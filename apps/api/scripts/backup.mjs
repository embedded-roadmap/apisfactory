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
//
// PLATFORM (oturum 41): betik yalnız Node + PostgreSQL bağlantısıyla çalışır — psql/bash/openssl/tar
// komut satırı araçlarına bağımlılık kaldırıldı (Windows'ta `bash` WSL'e gidiyordu, psql kurulu değildi).
// COPY aynı SQL ile pg-copy-streams üzerinden, arşiv `tar` paketiyle (aynı .tar.gz), şifreleme Node
// crypto ile `openssl enc -aes-256-cbc -pbkdf2 -salt` ile BİREBİR aynı dosya biçiminde yapılır — önceki
// yedekler bu betiklerle, bu betiklerin yedekleri openssl ile açılabilir.

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import copyStreams from "pg-copy-streams";
import * as tar from "tar";

const { to: copyTo, from: copyFrom } = copyStreams;

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

// ---- openssl enc -aes-256-cbc -pbkdf2 -salt uyumlu şifreleme -------------------------------------------
// Biçim: "Salted__" + 8 bayt tuz + şifreli metin; anahtar+IV = PBKDF2-HMAC-SHA256(parola, tuz, 10000, 48 bayt).
const OPENSSL_MAGIC = Buffer.from("Salted__", "latin1");
const opensslKeyIv = (pass, salt) => {
  const kiv = pbkdf2Sync(Buffer.from(pass, "utf8"), salt, 10000, 48, "sha256");
  return { key: kiv.subarray(0, 32), iv: kiv.subarray(32, 48) };
};

export async function encryptFile(inPath, outPath, pass) {
  const salt = randomBytes(8);
  const { key, iv } = opensslKeyIv(pass, salt);
  const out = createWriteStream(outPath);
  out.write(Buffer.concat([OPENSSL_MAGIC, salt]));
  await pipeline(createReadStream(inPath), createCipheriv("aes-256-cbc", key, iv), out);
}

export async function decryptFile(inPath, outPath, pass) {
  const fh = await open(inPath, "r");
  const head = Buffer.alloc(16);
  try {
    await fh.read(head, 0, 16, 0);
  } finally {
    await fh.close();
  }
  if (!head.subarray(0, 8).equals(OPENSSL_MAGIC)) throw new Error("Yedek dosyası tanınmadı (openssl 'Salted__' başlığı yok)");
  const { key, iv } = opensslKeyIv(pass, head.subarray(8, 16));
  try {
    await pipeline(createReadStream(inPath, { start: 16 }), createDecipheriv("aes-256-cbc", key, iv), createWriteStream(outPath));
  } catch {
    throw new Error("Şifre çözme başarısız — yanlış anahtar veya bozuk dosya");
  }
}

export async function createArchive(tarPath, cwd, entries) {
  await tar.c({ gzip: true, file: tarPath, cwd, portable: true }, entries);
}

export async function extractArchive(tarPath, cwd) {
  await tar.x({ file: tarPath, cwd });
}

/** Dizini (içeriğiyle) kopyalar ve kopyalanan dosya sayısını döner; kaynak yoksa 0. */
export async function copyDirectory(src, dest) {
  if (!existsSync(src)) return 0;
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
  return (await readdir(src, { recursive: true, withFileTypes: true })).filter((d) => d.isFile()).length;
}

/** Bir CSV'deki veri satırı sayısı — `tail -n +2 | wc -l` ile AYNI anlam (başlıktan sonraki satır sonu sayısı),
 * böylece önceki yedeklerin manifest'teki toplamlarıyla uzlaşma bozulmaz. */
export async function countCsvRows(file) {
  if (!existsSync(file)) return 0;
  const buf = await readFile(file);
  let n = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
  return Math.max(0, n - 1);
}

export const isMainModule = (metaUrl) => Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
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

/** Bir tabloyu CSV'ye döker (`COPY (select …) TO STDOUT WITH CSV HEADER` — psql `\copy` ile aynı çıktı).
 * `companyId` verilirse önce oturumda app.company_id ayarlanır (SET LOCAL değil — aynı bağlantıda kalıcı). */
export async function copyTableToCsv(client, table, outFile, companyId) {
  await client.query(`select set_config('app.company_id', $1, false), set_config('app.system_scope', 'backup', false)`, [companyId ?? ""]);
  try {
    await pipeline(client.query(copyTo(`COPY (select * from ${quoteIdent(table)}) TO STDOUT WITH CSV HEADER`)), createWriteStream(outFile));
  } catch (e) {
    throw new Error(`COPY başarısız (${table}): ${e.message}`);
  }
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
export async function copyCsvIntoTable(client, table, inFile, companyId, identity) {
  const t = quoteIdent(table);
  const load = (target) => pipeline(createReadStream(inFile), client.query(copyFrom(`COPY ${target} FROM STDIN WITH CSV HEADER`)));
  try {
    if (companyId) {
      await client.query(`select set_config('app.company_id', $1, false), set_config('app.system_scope', 'backup', false)`, [companyId]);
      await client.query(`create temp table _restore_stage (like ${t} including all)`);
      try {
        await load("_restore_stage");
        if (identity && !identity.preserve) {
          const cols = (
            await client.query(
              `select string_agg(quote_ident(column_name), ',' order by ordinal_position) as cols from information_schema.columns
                where table_schema = 'public' and table_name = $1 and column_name <> $2`,
              [table, identity.column],
            )
          ).rows[0].cols;
          await client.query(`insert into ${t} (${cols}) select ${cols} from _restore_stage`);
        } else {
          await client.query(`insert into ${t} overriding system value select * from _restore_stage`);
        }
      } finally {
        await client.query(`drop table if exists _restore_stage`);
      }
    } else {
      await load(t);
    }
  } catch (e) {
    throw new Error(`Geri yükleme COPY başarısız (${table}): ${e.message}`);
  }
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
      await copyTableToCsv(client, t, path.join(globalDir, `${t}.csv`), null);
    }
    // subscription_plans GERİ YÜKLEME için COPY edilmez — bu bir uygulama verisi değil, şema/referans
    // katalogudur ve migration 041 tarafından zaten şemayla birlikte (her seferinde YENİ rastgele id
    // ile) yeniden oluşturulur; doğrudan geri COPY etmeye çalışmak unique kod çakışması verir (gerçekten
    // test edilip görüldü). Yine de burada (id, code) olarak dökülür — restore.mjs, eski id'lerin hangi
    // koda ait olduğunu bulup companies.subscription_plan_id / subscription_events.*_plan_id gibi
    // referansları hedefin YENİ id'lerine eşlemek için bunu kullanır (kod her migration çalışmasında
    // sabit kalır, id değil).
    await copyTableToCsv(client, "subscription_plans", path.join(globalDir, "subscription_plans.csv"), null);

    const companies = (await client.query(`select id, code from companies order by created_at`)).rows;
    let totalRows = 0;
    for (const co of companies) {
      const dir = path.join(companyDir, co.id);
      await mkdir(dir, { recursive: true });
      for (const t of fullOrder) {
        const outFile = path.join(dir, `${t}.csv`);
        await copyTableToCsv(client, t, outFile, co.id);
        totalRows += await countCsvRows(outFile);
      }
      console.log(`  şirket ${co.code} (${co.id}) yedeklendi — ${fullOrder.length} tablo`);
    }

    const filesDir = path.join(work, "files");
    await copyDirectory(STORAGE_LOCAL_DIR, filesDir);

    await writeFile(
      path.join(work, "manifest.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), companies: companies.map((c) => ({ id: c.id, code: c.code })), tableCount: fullOrder.length, totalRows }, null, 2),
    );

    await mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const tarPath = path.join(work, "backup.tar.gz");
    const encPath = path.join(BACKUP_DIR, `apisfactory-backup-${stamp}.tar.gz.enc`);

    const entries = ["manifest.json", "global", "companies"];
    if (existsSync(filesDir)) entries.push("files");
    await createArchive(tarPath, work, entries);
    await encryptFile(tarPath, encPath, ENC_KEY);

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

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { main as runBackup };
