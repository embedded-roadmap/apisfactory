import type { FastifyInstance } from "fastify";
import {
  BomImportPreviewInput,
  StockImportPreviewInput,
  type BomDiff,
  type BomLine,
  type BomVersion,
  type ImportPreview,
  type ImportPreviewRow,
} from "@apisfactory/shared";
import { z } from "zod";
import type { Db } from "../db/pool";
import { conflict, forbidden, notFound } from "../lib/errors";
import { normalizeDecimal, parseCsv, parseFlag, sha256 } from "../lib/csv";
import { recordEvent } from "../lib/records";
import { can, parse, tenant } from "../http/context";

type BomRowValues = { mpn: string; manufacturer: string; qty: string; refdes: string; description: string; dnp: string; internalCode: string; itemId?: string };
type StockRowValues = { itemCode: string; qty: string; lotNo: string; locationCode: string; rev: string; itemId?: string; locationId?: string; revisionId?: string };

async function existingCommitted(db: Db, kind: string, targetId: string | null, hash: string) {
  const r = await db.query(
    `select id from import_jobs where kind = $1 and coalesce(target_id,'00000000-0000-0000-0000-000000000000') = coalesce($2::uuid,'00000000-0000-0000-0000-000000000000') and file_hash = $3 and status = 'committed'`,
    [kind, targetId, hash],
  );
  return (r.rows[0]?.id as string) ?? null;
}

function summarize(rows: ImportPreviewRow[]) {
  return {
    total: rows.length,
    ok: rows.filter((r) => r.status === "ok").length,
    newItems: rows.filter((r) => r.status === "new_item").length,
    ambiguous: rows.filter((r) => r.status === "ambiguous").length,
    errors: rows.filter((r) => r.status === "error").length,
  };
}

export async function loadBom(db: Db, id: string): Promise<BomVersion> {
  const b = await db.query(`select id, product_id as "productId", version_no as "versionNo", status from bom_versions where id = $1`, [id]);
  if (!b.rows[0]) throw notFound("BOM sürümü");
  const lines = await db.query(
    `select l.id, l.line_no as "lineNo", l.item_id as "itemId", i.code as "itemCode", i.manufacturer, i.mpn,
            l.description, l.qty_per as "qtyPer", l.refdes, l.dnp
       from bom_lines l join items i on i.id = l.item_id where l.bom_version_id = $1 order by l.line_no`,
    [id],
  );
  return { ...b.rows[0], lines: lines.rows };
}

/** BOM farkı: referans tasarımcı varsa onunla, yoksa kalemle eşleştirir. */
export function diffBoms(a: BomLine[], b: BomLine[]): BomDiff {
  const key = (l: BomLine) => (l.refdes ? `ref:${l.refdes.split(/[\s,]+/).sort().join(",")}` : `item:${l.itemId}`);
  const ma = new Map(a.map((l) => [key(l), l]));
  const mb = new Map(b.map((l) => [key(l), l]));
  const diff: BomDiff = { added: [], removed: [], changed: [] };
  for (const [k, l] of mb) if (!ma.has(k)) diff.added.push(l);
  for (const [k, l] of ma) {
    const n = mb.get(k);
    if (!n) {
      diff.removed.push(l);
      continue;
    }
    const fields: ("qtyPer" | "mpn" | "dnp")[] = [];
    if (Number(l.qtyPer) !== Number(n.qtyPer)) fields.push("qtyPer");
    if ((l.mpn ?? "") !== (n.mpn ?? "") || l.itemId !== n.itemId) fields.push("mpn");
    if (l.dnp !== n.dnp) fields.push("dnp");
    if (fields.length) diff.changed.push({ key: k, before: l, after: n, fields });
  }
  return diff;
}

export async function importRoutes(app: FastifyInstance) {
  /**
   * BOM içe aktarım önizlemesi (prompt §8, §21): kolon eşleştirme, tip/birim kontrolü.
   * Üretici + tam MPN birebir eşleşirse kalem eşlenir; yalnızca MPN eşleşirse "belirsiz" kalır ve
   * kullanıcı çözümü olmadan kesinleştirilmez; hiç yoksa yeni komponent önerilir.
   */
  app.post("/api/imports/bom/preview", async (req): Promise<ImportPreview> => {
    const input = parse(BomImportPreviewInput, req.body);
    return tenant(req, "bom.import", async (db, actor) => {
      const product = await db.query(`select id from products where id = $1`, [input.productId]);
      if (!product.rows[0]) throw notFound("Ürün");
      const hash = sha256(input.content);
      const { rows } = parseCsv(input.content);
      const m = input.mapping;
      const out: ImportPreviewRow[] = [];
      const seenRef = new Set<string>();

      for (const [i, raw] of rows.entries()) {
        const v: BomRowValues = {
          mpn: (raw[m.mpn] ?? "").trim(),
          manufacturer: m.manufacturer ? (raw[m.manufacturer] ?? "").trim() : "",
          qty: m.qty ? (raw[m.qty] ?? "").trim() : "",
          refdes: m.refdes ? (raw[m.refdes] ?? "").trim() : "",
          description: m.description ? (raw[m.description] ?? "").trim() : "",
          dnp: m.dnp ? (raw[m.dnp] ?? "").trim() : "",
          internalCode: m.internalCode ? (raw[m.internalCode] ?? "").trim() : "",
        };
        const messages: string[] = [];
        let status: ImportPreviewRow["status"] = "ok";
        const qty = normalizeDecimal(v.qty, input.decimalSeparator);
        if (!v.mpn) messages.push("MPN boş");
        if (!qty || Number(qty) <= 0) messages.push(`Miktar geçersiz: "${v.qty}"`);
        else v.qty = qty;
        for (const ref of v.refdes.split(/[\s,]+/).filter(Boolean)) {
          if (seenRef.has(ref)) messages.push(`Referans tekrar ediyor: ${ref}`);
          seenRef.add(ref);
        }
        if (messages.length) status = "error";
        else {
          const exact = v.manufacturer
            ? await db.query(`select id from items where lower(manufacturer) = lower($1) and lower(mpn) = lower($2)`, [v.manufacturer, v.mpn])
            : { rows: [] as { id: string }[] };
          if (exact.rows.length === 1) v.itemId = exact.rows[0]!.id;
          else {
            const loose = await db.query(`select id, manufacturer from items where lower(mpn) = lower($1)`, [v.mpn]);
            if (loose.rows.length > 0) {
              status = "ambiguous";
              messages.push(
                `MPN ${loose.rows.length} kayıtla eşleşiyor ama üretici ${v.manufacturer ? "farklı" : "belirtilmemiş"}; otomatik kesinleştirilmedi`,
              );
            } else if (!v.manufacturer) {
              status = "error";
              messages.push("Yeni parça için üretici zorunlu");
            } else {
              status = "new_item";
              messages.push("Yeni komponent olarak açılacak");
            }
          }
        }
        out.push({ row: i + 2, status, messages, values: v as unknown as Record<string, string> });
      }

      const job = await db.query(
        `insert into import_jobs (company_id, kind, target_id, file_name, file_hash, mapping, preview, created_by)
         values (app_company_id(), 'bom', $1, $2, $3, $4, $5, $6) returning id`,
        [input.productId, input.fileName, hash, JSON.stringify(m), JSON.stringify(out), actor.userId],
      );
      return {
        jobId: job.rows[0].id,
        fileHash: hash,
        duplicateOf: await existingCommitted(db, "bom", input.productId, hash),
        rows: out,
        summary: summarize(out),
      };
    });
  });

  app.post("/api/imports/stock/preview", async (req): Promise<ImportPreview> => {
    const input = parse(StockImportPreviewInput, req.body);
    return tenant(req, "inventory.import", async (db, actor) => {
      const hash = sha256(input.content);
      const { rows } = parseCsv(input.content);
      const m = input.mapping;
      const out: ImportPreviewRow[] = [];
      const seen = new Set<string>();
      for (const [i, raw] of rows.entries()) {
        const v: StockRowValues = {
          itemCode: (raw[m.itemCode] ?? "").trim(),
          qty: (raw[m.qty] ?? "").trim(),
          lotNo: (raw[m.lotNo] ?? "").trim(),
          locationCode: (raw[m.locationCode] ?? "").trim(),
          rev: m.rev ? (raw[m.rev] ?? "").trim() : "",
        };
        const messages: string[] = [];
        const qty = normalizeDecimal(v.qty, input.decimalSeparator);
        if (!qty || Number(qty) <= 0) messages.push(`Miktar geçersiz: "${v.qty}"`);
        else v.qty = qty;
        if (!v.lotNo) messages.push("Lot numarası boş");
        const item = await db.query(`select id, kind from items where code = $1`, [v.itemCode]);
        if (!item.rows[0]) messages.push(`Kalem bulunamadı: ${v.itemCode}`);
        else {
          v.itemId = item.rows[0].id;
          if (item.rows[0].kind === "product") {
            // Bitmiş ürün stoğu revizyonla birlikte girilir; revizyonsuz bitmiş ürün satışa uygun sayılmaz.
            const rev = await db.query(
              `select pr.id from product_revisions pr join products p on p.id = pr.product_id where p.item_id = $1 and pr.rev = $2`,
              [v.itemId, v.rev],
            );
            if (!rev.rows[0]) messages.push(`Bitmiş ürün için geçerli revizyon gerekli (${v.rev || "boş"})`);
            else v.revisionId = rev.rows[0].id;
          }
        }
        const loc = await db.query(`select id from locations where code = $1`, [v.locationCode]);
        if (!loc.rows[0]) messages.push(`Konum bulunamadı: ${v.locationCode}`);
        else v.locationId = loc.rows[0].id;
        const k = `${v.itemCode}|${v.lotNo}|${v.locationCode}`;
        if (seen.has(k)) messages.push("Dosyada mükerrer satır");
        seen.add(k);
        out.push({ row: i + 2, status: messages.length ? "error" : "ok", messages, values: v as unknown as Record<string, string> });
      }
      const job = await db.query(
        `insert into import_jobs (company_id, kind, file_name, file_hash, mapping, preview, created_by)
         values (app_company_id(), 'stock_opening', $1, $2, $3, $4, $5) returning id`,
        [input.fileName, hash, JSON.stringify(m), JSON.stringify(out), actor.userId],
      );
      return { jobId: job.rows[0].id, fileHash: hash, duplicateOf: await existingCommitted(db, "stock_opening", null, hash), rows: out, summary: summarize(out) };
    });
  });

  /** Onay: hatalı veya çözümsüz belirsiz satır varken işlenmez. Aynı dosya aynı hedefe ikinci kez işlenmez (T13). */
  app.post("/api/imports/:id/commit", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ resolutions: z.record(z.string(), z.string().uuid()).default({}) }), req.body ?? {});
    return tenant(req, null, async (db, actor) => {
      const j = await db.query(`select * from import_jobs where id = $1 for update`, [id]);
      const job = j.rows[0];
      if (!job) throw notFound("İçe aktarım işi");
      const perm = job.kind === "bom" ? "bom.import" : "inventory.import";
      if (!can(req, perm)) throw forbidden(perm);
      if (job.status !== "previewed") throw conflict("import_state", `İş durumu uygun değil: ${job.status}`);
      const dup = await existingCommitted(db, job.kind, job.target_id, job.file_hash);
      if (dup) throw conflict("duplicate_import", "Bu dosya daha önce işlendi; kayıt ve miktarlar çoğaltılmadı", { previousJobId: dup });

      const rows = job.preview as ImportPreviewRow[];
      const blocking = rows.filter((r) => r.status === "error" || (r.status === "ambiguous" && !body.resolutions[String(r.row)]));
      if (blocking.length) throw conflict("import_has_errors", "Hatalı veya çözümsüz satırlar var", { rows: blocking.map((r) => r.row) });

      const importActor = { ...actor, kind: "import" as const };
      let result: Record<string, unknown>;
      if (job.kind === "bom") {
        const next = await db.query(`select coalesce(max(version_no),0)+1 as n from bom_versions where product_id = $1`, [job.target_id]);
        const bom = await db.query(
          `insert into bom_versions (company_id, product_id, version_no, source_import_id, created_by)
           values (app_company_id(), $1, $2, $3, $4) returning id`,
          [job.target_id, next.rows[0].n, id, actor.userId],
        );
        let created = 0;
        for (const [idx, r] of rows.entries()) {
          const v = r.values as unknown as BomRowValues;
          let itemId = v.itemId ?? body.resolutions[String(r.row)];
          if (!itemId) {
            const code = v.internalCode || `CMP-${v.manufacturer}-${v.mpn}`.toUpperCase().replace(/[^A-Z0-9-]+/g, "-").slice(0, 64);
            const ins = await db.query(
              `insert into items (company_id, code, name, kind, manufacturer, mpn) values (app_company_id(), $1, $2, 'component', $3, $4)
               on conflict (company_id, code) do nothing returning id`,
              [code, v.description || v.mpn, v.manufacturer, v.mpn],
            );
            if (!ins.rows[0]) throw conflict("item_code_taken", `Kalem kodu kullanımda: ${code}`, { row: r.row });
            itemId = ins.rows[0].id;
            created++;
            await recordEvent(db, importActor, { entityType: "item", entityId: itemId!, eventType: "created", after: { code, mpn: v.mpn }, source: `import:${id}` });
          }
          await db.query(
            `insert into bom_lines (company_id, bom_version_id, line_no, item_id, qty_per, refdes, description, dnp)
             values (app_company_id(), $1, $2, $3, $4, $5, $6, $7)`,
            [bom.rows[0].id, idx + 1, itemId, v.qty, v.refdes || null, v.description || null, parseFlag(v.dnp)],
          );
        }
        result = { bomVersionId: bom.rows[0].id, versionNo: next.rows[0].n, lines: rows.length, createdItems: created };
        await recordEvent(db, importActor, { entityType: "bom_version", entityId: bom.rows[0].id, eventType: "imported", after: result, source: `import:${id}` });
      } else {
        // Açılış stoğu: miktar doğrudan yazılmaz, "opening" hareketi oluşturulur. Dış işlem tetiklenmez (prompt §4).
        let moves = 0;
        for (const r of rows) {
          const v = r.values as unknown as StockRowValues;
          const lot = await db.query(
            `insert into lots (company_id, item_id, lot_no, product_revision_id) values (app_company_id(), $1, $2, $3)
             on conflict (company_id, item_id, lot_no) do update set lot_no = excluded.lot_no returning id`,
            [v.itemId, v.lotNo, v.revisionId ?? null],
          );
          await db.query(
            `insert into stock_moves (company_id, item_id, lot_id, to_location_id, qty, move_type, ref_type, ref_id, idempotency_key, created_by)
             values (app_company_id(), $1, $2, $3, $4, 'opening', 'import_job', $5, $6, $7)`,
            [v.itemId, lot.rows[0].id, v.locationId, v.qty, id, `import:${id}:${r.row}`, actor.userId],
          );
          moves++;
        }
        result = { moves };
      }
      await db.query(`update import_jobs set status = 'committed', committed_at = now(), result = $2 where id = $1`, [id, JSON.stringify(result)]);
      await recordEvent(db, importActor, { entityType: "import_job", entityId: id, eventType: "committed", after: result, source: job.file_name });
      return { jobId: id, ...result };
    });
  });

  app.get("/api/imports", async (req) =>
    tenant(req, null, async (db) => {
      const r = await db.query(
        `select id, kind, file_name as "fileName", status, created_at as "createdAt", committed_at as "committedAt", result
           from import_jobs order by created_at desc limit 100`,
      );
      return r.rows;
    }),
  );

  app.get("/api/boms/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "bom.view", (db) => loadBom(db, id));
  });

  app.post("/api/boms/:id/publish", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "bom.publish", async (db, actor) => {
      const b = await db.query(`select status from bom_versions where id = $1 for update`, [id]);
      if (!b.rows[0]) throw notFound("BOM sürümü");
      if (b.rows[0].status !== "draft") throw conflict("invalid_transition", "Yalnızca taslak BOM yayımlanabilir");
      const n = await db.query(`select count(*)::int as n from bom_lines where bom_version_id = $1 and not dnp`, [id]);
      if (n.rows[0].n === 0) throw conflict("bom_empty", "Dizilecek satırı olmayan BOM yayımlanamaz");
      await db.query(`update bom_versions set status = 'published', published_at = now() where id = $1`, [id]);
      await recordEvent(db, actor, { entityType: "bom_version", entityId: id, eventType: "status.published", before: { status: "draft" }, after: { status: "published" } });
      return loadBom(db, id);
    });
  });

  app.get("/api/boms/:a/diff/:b", async (req) => {
    const { a, b } = req.params as { a: string; b: string };
    return tenant(req, "bom.view", async (db) => {
      const [ba, bb] = [await loadBom(db, a), await loadBom(db, b)];
      if (ba.productId !== bb.productId) throw conflict("bom_mismatch", "Farklı ürünlerin BOM'ları karşılaştırılamaz");
      return diffBoms(ba.lines, bb.lines);
    });
  });
}
