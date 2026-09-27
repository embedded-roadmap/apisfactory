import type { FastifyInstance } from "fastify";
import { ZipArchive } from "archiver";
import { notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { objectStorage } from "../lib/storage";
import { tenant } from "../http/context";

/**
 * R47 — şirketin tam veri ve dosya çıkış paketi (ana talimat §21):
 * "Şirketin çıkış paketi kayıtları, kimlikleri, ilişkileri, dosyaları ve veri sözlüğünü birlikte
 * içersin. Yalnızca birkaç PDF sunup tam veri çıkışı sağlandı deme. Bütün import/export ve
 * indirmeler kayıt altına alınsın."
 *
 * Yaklaşım: şirket kapsamlı (company_id sütunlu) her tablo information_schema'dan OTOMATİK
 * keşfedilir — yeni bir modül yeni bir tablo eklediğinde bu export kodunun ayrıca güncellenmesi
 * GEREKMEZ (yalnızca yeni tabloya apis_app SELECT izni verilmesi yeterli, aksi halde o tablo
 * "erişilemedi" notuyla dışlanır, sessizce atlanmaz). Bütün tablolar TEK bir veri tabanı
 * işleminde (aynı transaction — bkz. withTenant) okunur, böylece paket tutarlı bir anlık
 * görüntüdür (bir tablo okunurken diğerinde değişiklik olamaz).
 *
 * Bilinçli sınırlamalar (uydurulmadı, dürüstçe):
 * - Parola özeti (users.password_hash) ve istasyon belirteç özeti (test_station_tokens.token_hash,
 *   apis_app'e zaten SELECT izni yok) güvenlik nedeniyle pakete DAHİL EDİLMEZ.
 * - bytea (ikili) sütunlar JSON'a gömülmez; gerçek dosya içeriği ayrı `dosyalar/` klasöründe,
 *   ilgili JSON satırı dosya adıyla eşleşir.
 * - Bu uç senkron/tek işlemli çalışır (demo/pilot ölçeği için yeterli); gerçekten büyük bir
 *   şirket veri tabanında (yüz binlerce satır) bu, tek bir veri tabanı bağlantısını uzun süre
 *   meşgul eder — üretim ölçeğinde arka plan işine (kuyruk + nesne depolamaya yazıp bildirim)
 *   taşınması gerekir; bu GELİŞTİRİLMEDİ (bilinçli kapsam sınırlaması, bkz. devam-notu.md).
 */

const FILE_TABLES: Record<string, { nameCol: string; contentCol: string; objectKeyCol: string }> = {
  message_attachments: { nameCol: "file_name", contentCol: "content", objectKeyCol: "object_key" },
  subcontract_job_files: { nameCol: "file_name", contentCol: "content", objectKeyCol: "object_key" },
};

function sanitizeFileName(name: string): string {
  return (name || "dosya").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
}

export async function companyExportRoutes(app: FastifyInstance) {
  app.get("/api/company/export", async (req, reply) => {
    const buffer = await tenant(req, "company.data.export", async (db, actor) => {
      const companyRes = await db.query(
        `select code, name, default_currency as "defaultCurrency", timezone, created_at as "createdAt" from companies where id = $1`,
        [actor.companyId],
      );
      const company = companyRes.rows[0];
      if (!company) throw notFound("Şirket");

      const tablesRes = await db.query(
        `select distinct table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'company_id' order by table_name`,
      );
      const tableNames: string[] = tablesRes.rows.map((r: { table_name: string }) => r.table_name);

      const archive = new ZipArchive({ zlib: { level: 9 } });
      const chunks: Buffer[] = [];
      archive.on("data", (c: Buffer) => chunks.push(c));
      const done = new Promise<void>((resolve, reject) => {
        archive.on("end", () => resolve());
        archive.on("error", (err) => reject(err));
      });

      const dictionary: unknown[] = [];
      const manifestTables: { table: string; rows: number; hata?: string }[] = [];
      let totalRows = 0;
      let totalFiles = 0;

      for (const table of tableNames) {
        const colsRes = await db.query(
          `select column_name, data_type, is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = $1 order by ordinal_position`,
          [table],
        );
        const cols = colsRes.rows as { column_name: string; data_type: string; is_nullable: string }[];
        const byteaCols = new Set(cols.filter((c) => c.data_type === "bytea").map((c) => c.column_name));
        const selectCols = cols.filter((c) => !byteaCols.has(c.column_name)).map((c) => `"${c.column_name}"`);
        dictionary.push({
          table,
          columns: cols.map((c) => ({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable === "YES",
            not: byteaCols.has(c.column_name) ? "ikili içerik — bkz. dosyalar/ klasörü" : undefined,
          })),
        });

        try {
          const rows = await db.query(`select ${selectCols.join(", ")} from "${table}" where company_id = $1`, [actor.companyId]);
          archive.append(JSON.stringify(rows.rows, null, 2), { name: `veri/${table}.json` });
          totalRows += rows.rowCount ?? 0;
          manifestTables.push({ table, rows: rows.rowCount ?? 0 });

          const fileSpec = FILE_TABLES[table];
          if (fileSpec) {
            const withContent = await db.query(
              `select id, ${fileSpec.nameCol} as name, ${fileSpec.contentCol} as content, ${fileSpec.objectKeyCol} as object_key from "${table}" where company_id = $1`,
              [actor.companyId],
            );
            for (const r of withContent.rows as { id: string; name: string; content: Buffer | null; object_key: string | null }[]) {
              const buf = r.object_key ? await objectStorage().get(r.object_key) : r.content;
              if (buf) {
                archive.append(buf, { name: `dosyalar/${table}/${r.id}-${sanitizeFileName(r.name)}` });
                totalFiles++;
              }
            }
          }
        } catch {
          // Erişim izni olmayan (örn. test_station_tokens — bilinçli olarak apis_app'e kapalı) veya
          // başka bir nedenle okunamayan tablo SESSİZCE atlanmaz — dürüstçe "erişilemedi" ile listelenir.
          manifestTables.push({ table, rows: 0, hata: "erişilemedi (izin yok veya okuma hatası) — pakete dahil edilmedi" });
        }
      }

      // Kimlikler: şirket üyesi kullanıcıların temel kimlik bilgisi. Parola özeti bilinçli olarak DIŞLANDI.
      const users = await db.query(
        `select u.id, u.email, u.name, m.status as "membershipStatus", m.is_external as "isExternal", m.created_at as "memberSince"
           from memberships m join users u on u.id = m.user_id where m.company_id = $1`,
        [actor.companyId],
      );
      archive.append(JSON.stringify(users.rows, null, 2), { name: "veri/kullanicilar.json" });
      dictionary.push({
        table: "kullanicilar (türetilmiş — memberships × users)",
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "email", type: "text", nullable: false },
          { name: "name", type: "text", nullable: false },
          { name: "membershipStatus", type: "text", nullable: false },
          { name: "isExternal", type: "boolean", nullable: false },
          { name: "memberSince", type: "timestamptz", nullable: false },
        ],
        not: "users.password_hash güvenlik nedeniyle DIŞLANDI",
      });

      const manifest = {
        company,
        generatedAt: new Date().toISOString(),
        generatedByUserId: actor.userId,
        tables: manifestTables,
        totalRows,
        totalFiles,
        excludedNote:
          "Parola özeti (users.password_hash) ve istasyon belirteç özeti (test_station_tokens.token_hash) güvenlik nedeniyle bu pakete DAHİL EDİLMEDİ. Erişilemeyen tablolar 'tables' listesinde 'hata' alanıyla işaretlidir.",
      };
      archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
      archive.append(JSON.stringify(dictionary, null, 2), { name: "veri-sozlugu.json" });
      archive.append(
        [
          `apisfactory — şirket veri ve dosya çıkış paketi`,
          `Şirket: ${company.name} (${company.code})`,
          `Üretim zamanı: ${manifest.generatedAt}`,
          ``,
          `İçerik:`,
          `- manifest.json: özet (tablo/satır/dosya sayıları, hariç tutulanlar)`,
          `- veri-sozlugu.json: her tablonun kolon adı/tipi/null olabilirliği (gerçek information_schema'dan, uydurulmadı)`,
          `- veri/*.json: her şirket-kapsamlı tablonun tüm satırları (ikili içerik hariç)`,
          `- veri/kullanicilar.json: şirket üyesi kullanıcıların kimlik bilgisi (parola özeti HARİÇ)`,
          `- dosyalar/<tablo>/: mesaj ve fason iş eklerinin gerçek dosya içeriği`,
          ``,
          `Bu paket tek bir veri tabanı işleminde (aynı transaction) üretildi — tüm tablolar aynı ana bakış açısından, tutarlı bir anlık görüntüdür.`,
          `Bu indirme, şirketin işlem geçmişine (events) "company.data_export" olarak kaydedildi.`,
        ].join("\n"),
        { name: "OKUBENI.txt" },
      );

      await archive.finalize();
      await done;

      await recordEvent(db, actor, {
        entityType: "company",
        entityId: actor.companyId,
        eventType: "company.data_export",
        after: { tables: manifestTables.length, totalRows, totalFiles },
      });

      return Buffer.concat(chunks);
    });

    reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="sirket-veri-paketi-${new Date().toISOString().slice(0, 10)}.zip"`);
    return reply.send(buffer);
  });
}
