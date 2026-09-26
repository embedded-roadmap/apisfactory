import type { FastifyInstance } from "fastify";
import {
  ApInvoiceImportPreviewInput,
  ArInvoiceImportPreviewInput,
  BomImportPreviewInput,
  CustomerImportPreviewInput,
  PurchaseOrderImportPreviewInput,
  SalesOrderImportPreviewInput,
  StockImportPreviewInput,
  SupplierImportPreviewInput,
  WorkOrderImportPreviewInput,
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
import { nextCode, recordEvent } from "../lib/records";
import { can, parse, tenant } from "../http/context";
import { recordLotCost } from "./costing";
import { refreshPoStatus } from "./procurement";

type BomRowValues = { mpn: string; manufacturer: string; qty: string; refdes: string; description: string; dnp: string; internalCode: string; itemId?: string };
type StockRowValues = { itemCode: string; qty: string; lotNo: string; locationCode: string; rev: string; unitCost?: string; currency?: string; itemId?: string; locationId?: string; revisionId?: string };
type CustomerRowValues = { code: string; name: string };
type SupplierRowValues = { code: string; name: string; contactEmail: string; leadTimeDays: string };
type SalesOrderRowValues = {
  orderCode: string;
  customerCode: string;
  customerId?: string;
  productCode: string;
  rev: string;
  productRevisionId?: string;
  qty: string;
  unitPrice: string;
  currency: string;
  requestedDate: string;
  status: string;
};
type PurchaseOrderRowValues = {
  poCode: string;
  supplierCode: string;
  supplierId?: string;
  itemCode: string;
  itemId?: string;
  qty: string;
  qtyReceived: string;
  unitPrice: string;
  currency: string;
  requestedDate: string;
  confirmedDate: string;
};
type WorkOrderRowValues = {
  woCode: string;
  productCode: string;
  rev: string;
  productRevisionId?: string;
  bomVersionId?: string;
  itemId?: string;
  qtyGood: string;
  qtyScrap: string;
  completedDate: string;
  unitCost: string;
  currency: string;
};
type ArInvoiceRowValues = {
  invoiceNo: string;
  customerCode: string;
  customerId?: string;
  paymentTermsDays?: number;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  netAmount: string;
  taxAmount: string;
  taxRate: string;
  description: string;
  receivedAmount: string;
  receivedDate: string;
};
type ApInvoiceRowValues = {
  supplierCode: string;
  supplierId?: string;
  paymentTermsDays?: number;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  netAmount: string;
  taxAmount: string;
  description: string;
  paidAmount: string;
  paidDate: string;
};

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
        if (m.unitCost) {
          const rawCost = (raw[m.unitCost] ?? "").trim();
          if (rawCost) {
            if (!can(req, "lot.cost.record")) messages.push("Birim maliyet sütunu için maliyet kayıt yetkisi gerekir");
            const cost = normalizeDecimal(rawCost, input.decimalSeparator);
            if (!cost || Number(cost) < 0) messages.push(`Birim maliyet geçersiz: "${rawCost}"`);
            else {
              v.unitCost = cost;
              v.currency = input.currency;
            }
          }
        }
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

  /**
   * W39 devamı (tarihsel veri geçişi): müşteri ana veri içe aktarımı. Hareket değil upsert'tir — kod
   * eşleşirse ad güncellenir, yoksa yeni müşteri açılır; bu yüzden "ambiguous"/"new_item" yok, yalnız "ok"/"error".
   */
  app.post("/api/imports/customers/preview", async (req): Promise<ImportPreview> => {
    const input = parse(CustomerImportPreviewInput, req.body);
    return tenant(req, "sales.create", async (db, actor) => {
      const hash = sha256(input.content);
      const { rows } = parseCsv(input.content);
      const m = input.mapping;
      const out: ImportPreviewRow[] = [];
      const seen = new Set<string>();
      for (const [i, raw] of rows.entries()) {
        const v: CustomerRowValues = { code: (raw[m.code] ?? "").trim(), name: (raw[m.name] ?? "").trim() };
        const messages: string[] = [];
        if (!v.code) messages.push("Müşteri kodu boş");
        if (!v.name) messages.push("Müşteri adı boş");
        if (v.code) {
          if (seen.has(v.code)) messages.push("Dosyada mükerrer kod");
          seen.add(v.code);
        }
        out.push({ row: i + 2, status: messages.length ? "error" : "ok", messages, values: v as unknown as Record<string, string> });
      }
      const job = await db.query(
        `insert into import_jobs (company_id, kind, file_name, file_hash, mapping, preview, created_by)
         values (app_company_id(), 'customers', $1, $2, $3, $4, $5) returning id`,
        [input.fileName, hash, JSON.stringify(m), JSON.stringify(out), actor.userId],
      );
      return { jobId: job.rows[0].id, fileHash: hash, duplicateOf: await existingCommitted(db, "customers", null, hash), rows: out, summary: summarize(out) };
    });
  });

  /** W39 devamı: tedarikçi ana veri içe aktarımı — aynı upsert deseni (bkz. müşteri içe aktarımı üstte). */
  app.post("/api/imports/suppliers/preview", async (req): Promise<ImportPreview> => {
    const input = parse(SupplierImportPreviewInput, req.body);
    return tenant(req, "supplier.manage", async (db, actor) => {
      const hash = sha256(input.content);
      const { rows } = parseCsv(input.content);
      const m = input.mapping;
      const out: ImportPreviewRow[] = [];
      const seen = new Set<string>();
      for (const [i, raw] of rows.entries()) {
        const v: SupplierRowValues = {
          code: (raw[m.code] ?? "").trim(),
          name: (raw[m.name] ?? "").trim(),
          contactEmail: m.contactEmail ? (raw[m.contactEmail] ?? "").trim() : "",
          leadTimeDays: m.leadTimeDays ? (raw[m.leadTimeDays] ?? "").trim() : "",
        };
        const messages: string[] = [];
        if (!v.code) messages.push("Tedarikçi kodu boş");
        if (!v.name) messages.push("Tedarikçi adı boş");
        if (v.leadTimeDays) {
          const n = Number(v.leadTimeDays);
          if (!Number.isInteger(n) || n < 0 || n > 365) messages.push(`Teslim süresi geçersiz: "${v.leadTimeDays}"`);
        }
        if (v.code) {
          if (seen.has(v.code)) messages.push("Dosyada mükerrer kod");
          seen.add(v.code);
        }
        out.push({ row: i + 2, status: messages.length ? "error" : "ok", messages, values: v as unknown as Record<string, string> });
      }
      const job = await db.query(
        `insert into import_jobs (company_id, kind, file_name, file_hash, mapping, preview, created_by)
         values (app_company_id(), 'suppliers', $1, $2, $3, $4, $5) returning id`,
        [input.fileName, hash, JSON.stringify(m), JSON.stringify(out), actor.userId],
      );
      return { jobId: job.rows[0].id, fileHash: hash, duplicateOf: await existingCommitted(db, "suppliers", null, hash), rows: out, summary: summarize(out) };
    });
  });

  /**
   * W39 devamı: açık (tarihsel) satış siparişi geçişi. **Canlı sipariş oluşturma akışından
   * (POST /api/sales-orders) bilinçli olarak farklıdır**: burada uygunluk hesaplanmaz, rezervasyon
   * yazılmaz, üretim ihtiyacı/satın alma talebi açılmaz, kredi kontrolü çalıştırılmaz — geçmişten
   * taşınan bir sipariş için sistem hiçbir talep/arz sinyali UYDURMAZ. Yalnızca sipariş ve satırları,
   * CSV'de ne yazıyorsa o şekilde (müşteri/ürün/revizyon/miktar/fiyat/tarih/durum) kaydedilir; ekranda
   * "uygunluk hesaplanmadı (geçmiş veri)" görünür (confirmResult null kalır).
   * Aynı "Sipariş kodu" sütunundaki birden çok satır tek siparişin birden çok kalemi olarak gruplanır;
   * boş bırakılırsa her satır kendi (yeni üretilen) koduyla ayrı bir tek kalemli sipariş olur.
   */
  app.post("/api/imports/sales-orders/preview", async (req): Promise<ImportPreview> => {
    const input = parse(SalesOrderImportPreviewInput, req.body);
    return tenant(req, "sales.create", async (db, actor) => {
      const hash = sha256(input.content);
      const { rows } = parseCsv(input.content);
      const m = input.mapping;
      const out: ImportPreviewRow[] = [];
      const orderCustomer = new Map<string, string>();
      for (const [i, raw] of rows.entries()) {
        const v: SalesOrderRowValues = {
          orderCode: m.orderCode ? (raw[m.orderCode] ?? "").trim() : "",
          customerCode: (raw[m.customerCode] ?? "").trim(),
          productCode: (raw[m.productCode] ?? "").trim(),
          rev: m.rev ? (raw[m.rev] ?? "").trim() : "",
          qty: (raw[m.qty] ?? "").trim(),
          unitPrice: m.unitPrice ? (raw[m.unitPrice] ?? "").trim() : "",
          currency: m.currency ? (raw[m.currency] ?? "").trim() : "",
          requestedDate: (raw[m.requestedDate] ?? "").trim(),
          status: m.status ? (raw[m.status] ?? "").trim() : "",
        };
        const messages: string[] = [];

        const qty = normalizeDecimal(v.qty, input.decimalSeparator);
        if (!qty || Number(qty) <= 0) messages.push(`Miktar geçersiz: "${v.qty}"`);
        else v.qty = qty;

        if (v.unitPrice) {
          const price = normalizeDecimal(v.unitPrice, input.decimalSeparator);
          if (!price || Number(price) < 0) messages.push(`Birim fiyat geçersiz: "${v.unitPrice}"`);
          else v.unitPrice = price;
        }

        if (!v.requestedDate || Number.isNaN(Date.parse(v.requestedDate))) messages.push(`İstenen tarih geçersiz: "${v.requestedDate}"`);

        if (v.status && v.status !== "draft" && v.status !== "firm") messages.push(`Durum yalnızca "draft" veya "firm" olabilir: "${v.status}"`);
        else if (!v.status) v.status = "firm";

        if (!v.customerCode) messages.push("Müşteri kodu boş");
        else {
          const c = await db.query(`select id from customers where code = $1`, [v.customerCode]);
          if (!c.rows[0]) messages.push(`Müşteri bulunamadı: ${v.customerCode}`);
          else v.customerId = c.rows[0].id;
        }

        if (!v.productCode) messages.push("Ürün kodu boş");
        else {
          const p = await db.query(`select id from products where code = $1`, [v.productCode]);
          if (!p.rows[0]) messages.push(`Ürün bulunamadı: ${v.productCode}`);
          else if (v.rev) {
            const rv = await db.query(`select id from product_revisions where product_id = $1 and rev = $2`, [p.rows[0].id, v.rev]);
            if (!rv.rows[0]) messages.push(`Revizyon bulunamadı: ${v.productCode} Rev.${v.rev}`);
            else v.productRevisionId = rv.rows[0].id;
          } else {
            const rv = await db.query(
              `select id from product_revisions where product_id = $1 and status = 'released' order by released_at desc nulls last limit 1`,
              [p.rows[0].id],
            );
            if (!rv.rows[0]) messages.push(`Ürünün yayımlanmış (released) revizyonu yok, revizyon sütunu belirtilmeli: ${v.productCode}`);
            else v.productRevisionId = rv.rows[0].id;
          }
        }

        if (v.orderCode) {
          const prevCustomer = orderCustomer.get(v.orderCode);
          if (prevCustomer && prevCustomer !== v.customerCode) messages.push(`Sipariş kodu ${v.orderCode} dosya içinde farklı müşterilerle kullanılmış`);
          else orderCustomer.set(v.orderCode, v.customerCode);
          const existing = await db.query(`select id from sales_orders where code = $1`, [v.orderCode]);
          if (existing.rows[0]) messages.push(`Sipariş kodu zaten kullanımda: ${v.orderCode}`);
        }

        out.push({ row: i + 2, status: messages.length ? "error" : "ok", messages, values: v as unknown as Record<string, string> });
      }
      const job = await db.query(
        `insert into import_jobs (company_id, kind, file_name, file_hash, mapping, preview, created_by)
         values (app_company_id(), 'sales_orders', $1, $2, $3, $4, $5) returning id`,
        [input.fileName, hash, JSON.stringify(m), JSON.stringify(out), actor.userId],
      );
      return { jobId: job.rows[0].id, fileHash: hash, duplicateOf: await existingCommitted(db, "sales_orders", null, hash), rows: out, summary: summarize(out) };
    });
  });

  /**
   * W39 devamı: açık tedarikçi borcu (AP) tarihsel geçişi. **Canlı fatura giriş akışından
   * (POST /api/supplier-invoices) bilinçli olarak farklıdır**: üç yönlü eşleştirme (sipariş – kalite
   * kabulü – fatura) ÇALIŞTIRILMAZ — geçmiş faturaların bu sistemde izlenen bir siparişe/mal kabulüne
   * bağlı olması beklenmez, olmayan bir siparişe karşı "eşleşmiyor" bayrağı basmak yanıltıcı olur.
   * Fatura doğrudan `status='approved'` (ödemeye hazır) kaydedilir; `match_result` alanına bunun
   * neden yapılmadığı açıkça yazılır. Hiçbir lot maliyeti yazılmaz — yazılacak gerçek bir sipariş/mal
   * kabul/lot bağlantısı yok (uydurulmaz). Kısmi/tam ödeme belirtilirse (opsiyonel) gerçek bir
   * `supplier_payments` kaydı olarak girilir; ödeme tarihi verilmeden ödeme tutarı kabul edilmez.
   */
  app.post("/api/imports/ap-invoices/preview", async (req): Promise<ImportPreview> => {
    const input = parse(ApInvoiceImportPreviewInput, req.body);
    return tenant(req, "invoice.manage", async (db, actor) => {
      const hash = sha256(input.content);
      const { rows } = parseCsv(input.content);
      const m = input.mapping;
      const out: ImportPreviewRow[] = [];
      const seen = new Set<string>();
      for (const [i, raw] of rows.entries()) {
        const v: ApInvoiceRowValues = {
          supplierCode: (raw[m.supplierCode] ?? "").trim(),
          invoiceNo: (raw[m.invoiceNo] ?? "").trim(),
          invoiceDate: (raw[m.invoiceDate] ?? "").trim(),
          dueDate: m.dueDate ? (raw[m.dueDate] ?? "").trim() : "",
          currency: m.currency ? (raw[m.currency] ?? "").trim() : "",
          netAmount: (raw[m.netAmount] ?? "").trim(),
          taxAmount: m.taxAmount ? (raw[m.taxAmount] ?? "").trim() : "",
          description: m.description ? (raw[m.description] ?? "").trim() : "",
          paidAmount: m.paidAmount ? (raw[m.paidAmount] ?? "").trim() : "",
          paidDate: m.paidDate ? (raw[m.paidDate] ?? "").trim() : "",
        };
        const messages: string[] = [];

        if (!v.currency) v.currency = "TRY";
        else if (!/^[A-Z]{3}$/.test(v.currency)) messages.push(`Para birimi geçersiz: "${v.currency}"`);

        const net = normalizeDecimal(v.netAmount, input.decimalSeparator);
        if (!net || Number(net) < 0) messages.push(`Net tutar geçersiz: "${v.netAmount}"`);
        else v.netAmount = net;

        if (v.taxAmount) {
          const tax = normalizeDecimal(v.taxAmount, input.decimalSeparator);
          if (!tax || Number(tax) < 0) messages.push(`Vergi tutarı geçersiz: "${v.taxAmount}"`);
          else v.taxAmount = tax;
        } else v.taxAmount = "0";

        if (!v.invoiceDate || Number.isNaN(Date.parse(v.invoiceDate))) messages.push(`Fatura tarihi geçersiz: "${v.invoiceDate}"`);

        if (v.dueDate) {
          if (Number.isNaN(Date.parse(v.dueDate))) messages.push(`Vade tarihi geçersiz: "${v.dueDate}"`);
          else if (v.invoiceDate && v.dueDate < v.invoiceDate) messages.push("Vade tarihi fatura tarihinden önce olamaz");
        }

        if (!v.invoiceNo) messages.push("Fatura numarası boş");

        if (!v.supplierCode) messages.push("Tedarikçi kodu boş");
        else {
          const s = await db.query(`select id, payment_terms_days from suppliers where code = $1`, [v.supplierCode]);
          if (!s.rows[0]) messages.push(`Tedarikçi bulunamadı: ${v.supplierCode}`);
          else {
            v.supplierId = s.rows[0].id;
            v.paymentTermsDays = s.rows[0].payment_terms_days;
          }
        }

        if (v.paidAmount) {
          const paid = normalizeDecimal(v.paidAmount, input.decimalSeparator);
          const gross = Number(net || 0) + Number(v.taxAmount || 0);
          if (!paid || Number(paid) < 0) messages.push(`Ödenen tutar geçersiz: "${v.paidAmount}"`);
          else if (Number(paid) > gross + 1e-9) messages.push(`Ödenen tutar (${paid}) brüt tutarı (${gross.toFixed(2)}) aşamaz`);
          else v.paidAmount = paid;
          if (!v.paidDate) messages.push("Ödenen tutar verilmişse ödeme tarihi de gerekli");
          else if (Number.isNaN(Date.parse(v.paidDate))) messages.push(`Ödeme tarihi geçersiz: "${v.paidDate}"`);
        }

        if (v.supplierCode && v.invoiceNo) {
          const k = `${v.supplierCode}|${v.invoiceNo}`;
          if (seen.has(k)) messages.push("Dosyada mükerrer tedarikçi + fatura no");
          seen.add(k);
          if (v.supplierId) {
            const existing = await db.query(`select code from supplier_invoices where supplier_id = $1 and invoice_no = $2`, [v.supplierId, v.invoiceNo]);
            if (existing.rows[0]) messages.push(`Bu tedarikçinin ${v.invoiceNo} numaralı faturası zaten kayıtlı (${existing.rows[0].code})`);
          }
        }

        out.push({ row: i + 2, status: messages.length ? "error" : "ok", messages, values: v as unknown as Record<string, string> });
      }
      const job = await db.query(
        `insert into import_jobs (company_id, kind, file_name, file_hash, mapping, preview, created_by)
         values (app_company_id(), 'ap_invoices', $1, $2, $3, $4, $5) returning id`,
        [input.fileName, hash, JSON.stringify(m), JSON.stringify(out), actor.userId],
      );
      return { jobId: job.rows[0].id, fileHash: hash, duplicateOf: await existingCommitted(db, "ap_invoices", null, hash), rows: out, summary: summarize(out) };
    });
  });

  /**
   * W39 devamı: açık satın alma siparişi tarihsel geçişi. **Canlı akıştan (RFQ → teklif karşılaştırma →
   * award) bilinçli olarak farklıdır**: RFQ, teklif, satın alma talebi veya tahsisat (purchase_allocations)
   * HİÇBİR ŞEKİLDE otomatik oluşturulmaz — geçmiş bir sipariş için hayali bir teklif karşılaştırması veya
   * üretim ihtiyacı bağlantısı uydurulmaz. Sipariş başlığının durumu (gönderildi/teyitli/kısmen teslim
   * alındı/teslim alındı) fabrikasyon değil, satırlarda VERİLEN gerçek teyit tarihi ve teslim alınan
   * miktardan canlı sistemle AYNI türetme fonksiyonuyla (`refreshPoStatus`) hesaplanır.
   */
  app.post("/api/imports/purchase-orders/preview", async (req): Promise<ImportPreview> => {
    const input = parse(PurchaseOrderImportPreviewInput, req.body);
    return tenant(req, "purchase.order.manage", async (db, actor) => {
      const hash = sha256(input.content);
      const { rows } = parseCsv(input.content);
      const m = input.mapping;
      const out: ImportPreviewRow[] = [];
      const poSupplier = new Map<string, string>();
      const poCurrency = new Map<string, string>();
      for (const [i, raw] of rows.entries()) {
        const v: PurchaseOrderRowValues = {
          poCode: m.poCode ? (raw[m.poCode] ?? "").trim() : "",
          supplierCode: (raw[m.supplierCode] ?? "").trim(),
          itemCode: (raw[m.itemCode] ?? "").trim(),
          qty: (raw[m.qty] ?? "").trim(),
          qtyReceived: m.qtyReceived ? (raw[m.qtyReceived] ?? "").trim() : "",
          unitPrice: m.unitPrice ? (raw[m.unitPrice] ?? "").trim() : "",
          currency: m.currency ? (raw[m.currency] ?? "").trim() : "",
          requestedDate: m.requestedDate ? (raw[m.requestedDate] ?? "").trim() : "",
          confirmedDate: m.confirmedDate ? (raw[m.confirmedDate] ?? "").trim() : "",
        };
        const messages: string[] = [];

        if (!v.currency) v.currency = "TRY";
        else if (!/^[A-Z]{3}$/.test(v.currency)) messages.push(`Para birimi geçersiz: "${v.currency}"`);

        const qty = normalizeDecimal(v.qty, input.decimalSeparator);
        if (!qty || Number(qty) <= 0) messages.push(`Miktar geçersiz: "${v.qty}"`);
        else v.qty = qty;

        if (v.qtyReceived) {
          const received = normalizeDecimal(v.qtyReceived, input.decimalSeparator);
          if (!received || Number(received) < 0) messages.push(`Teslim alınan miktar geçersiz: "${v.qtyReceived}"`);
          else if (qty && Number(received) > Number(qty) + 1e-9) messages.push(`Teslim alınan miktar (${received}) sipariş miktarını (${qty}) aşamaz`);
          else v.qtyReceived = received;
        } else v.qtyReceived = "0";

        if (v.unitPrice) {
          const price = normalizeDecimal(v.unitPrice, input.decimalSeparator);
          if (!price || Number(price) < 0) messages.push(`Birim fiyat geçersiz: "${v.unitPrice}"`);
          else v.unitPrice = price;
        }

        if (v.requestedDate && Number.isNaN(Date.parse(v.requestedDate))) messages.push(`İstenen tarih geçersiz: "${v.requestedDate}"`);
        if (v.confirmedDate && Number.isNaN(Date.parse(v.confirmedDate))) messages.push(`Teyit tarihi geçersiz: "${v.confirmedDate}"`);

        if (!v.supplierCode) messages.push("Tedarikçi kodu boş");
        else {
          const s = await db.query(`select id from suppliers where code = $1`, [v.supplierCode]);
          if (!s.rows[0]) messages.push(`Tedarikçi bulunamadı: ${v.supplierCode}`);
          else v.supplierId = s.rows[0].id;
        }

        if (!v.itemCode) messages.push("Kalem kodu boş");
        else {
          const it = await db.query(`select id from items where code = $1`, [v.itemCode]);
          if (!it.rows[0]) messages.push(`Kalem bulunamadı: ${v.itemCode}`);
          else v.itemId = it.rows[0].id;
        }

        if (v.poCode) {
          const prevSupplier = poSupplier.get(v.poCode);
          if (prevSupplier && prevSupplier !== v.supplierCode) messages.push(`Sipariş kodu ${v.poCode} dosya içinde farklı tedarikçilerle kullanılmış`);
          else poSupplier.set(v.poCode, v.supplierCode);
          const prevCurrency = poCurrency.get(v.poCode);
          if (prevCurrency && prevCurrency !== v.currency) messages.push(`Sipariş kodu ${v.poCode} dosya içinde farklı para birimleriyle kullanılmış`);
          else poCurrency.set(v.poCode, v.currency);
          const existing = await db.query(`select id from purchase_orders where code = $1`, [v.poCode]);
          if (existing.rows[0]) messages.push(`Sipariş kodu zaten kullanımda: ${v.poCode}`);
        }

        out.push({ row: i + 2, status: messages.length ? "error" : "ok", messages, values: v as unknown as Record<string, string> });
      }
      const job = await db.query(
        `insert into import_jobs (company_id, kind, file_name, file_hash, mapping, preview, created_by)
         values (app_company_id(), 'purchase_orders', $1, $2, $3, $4, $5) returning id`,
        [input.fileName, hash, JSON.stringify(m), JSON.stringify(out), actor.userId],
      );
      return { jobId: job.rows[0].id, fileHash: hash, duplicateOf: await existingCommitted(db, "purchase_orders", null, hash), rows: out, summary: summarize(out) };
    });
  });

  /**
   * W39 devamı: açık alacak (AR) tarihsel geçişi. **Canlı fatura akışından (sevkiyattan taslak → kes)
   * bilinçli olarak farklıdır**: gerçek bir satış siparişi/sevkiyat bağlantısı HİÇBİR ŞEKİLDE uydurulmaz
   * (`sales_order_id`/`shipment_id` boş bırakılır — bkz. migration 039). Fatura doğrudan `status='issued'`
   * (tamamı tahsil edilmişse `'paid'`) kaydedilir ve `migrated=true` ile işaretlenir; arayüzde bu durum
   * açıkça belirtilir. KDV oranı, verilen net/KDV tutarından geriye doğru hesaplanır (uydurulmaz) — oran
   * %100'ü aşarsa (tutarlar tutarsızsa) satır reddedilir.
   */
  app.post("/api/imports/ar-invoices/preview", async (req): Promise<ImportPreview> => {
    const input = parse(ArInvoiceImportPreviewInput, req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const hash = sha256(input.content);
      const { rows } = parseCsv(input.content);
      const m = input.mapping;
      const out: ImportPreviewRow[] = [];
      const seen = new Set<string>();
      for (const [i, raw] of rows.entries()) {
        const v: ArInvoiceRowValues = {
          invoiceNo: m.invoiceNo ? (raw[m.invoiceNo] ?? "").trim() : "",
          customerCode: (raw[m.customerCode] ?? "").trim(),
          invoiceDate: (raw[m.invoiceDate] ?? "").trim(),
          dueDate: m.dueDate ? (raw[m.dueDate] ?? "").trim() : "",
          currency: m.currency ? (raw[m.currency] ?? "").trim() : "",
          netAmount: (raw[m.netAmount] ?? "").trim(),
          taxAmount: m.taxAmount ? (raw[m.taxAmount] ?? "").trim() : "",
          taxRate: "",
          description: m.description ? (raw[m.description] ?? "").trim() : "",
          receivedAmount: m.receivedAmount ? (raw[m.receivedAmount] ?? "").trim() : "",
          receivedDate: m.receivedDate ? (raw[m.receivedDate] ?? "").trim() : "",
        };
        const messages: string[] = [];

        if (!v.currency) v.currency = "TRY";
        else if (!/^[A-Z]{3}$/.test(v.currency)) messages.push(`Para birimi geçersiz: "${v.currency}"`);

        const net = normalizeDecimal(v.netAmount, input.decimalSeparator);
        let netValid = false;
        if (!net || Number(net) < 0) messages.push(`Net tutar geçersiz: "${v.netAmount}"`);
        else { v.netAmount = net; netValid = true; }

        let taxValid = false;
        if (v.taxAmount) {
          const tax = normalizeDecimal(v.taxAmount, input.decimalSeparator);
          if (!tax || Number(tax) < 0) messages.push(`KDV tutarı geçersiz: "${v.taxAmount}"`);
          else { v.taxAmount = tax; taxValid = true; }
        } else { v.taxAmount = "0"; taxValid = true; }

        if (netValid && taxValid) {
          const netN = Number(v.netAmount);
          const taxN = Number(v.taxAmount);
          const rate = netN > 0 ? Math.round((taxN / netN) * 10000) / 100 : 0;
          if (rate > 100) messages.push(`KDV oranı net/KDV tutarından hesaplanamıyor (%${rate} > %100) — tutarları kontrol edin`);
          else v.taxRate = rate.toFixed(2);
        }

        if (!v.invoiceDate || Number.isNaN(Date.parse(v.invoiceDate))) messages.push(`Fatura tarihi geçersiz: "${v.invoiceDate}"`);

        if (v.dueDate) {
          if (Number.isNaN(Date.parse(v.dueDate))) messages.push(`Vade tarihi geçersiz: "${v.dueDate}"`);
          else if (v.invoiceDate && v.dueDate < v.invoiceDate) messages.push("Vade tarihi fatura tarihinden önce olamaz");
        }

        if (!v.customerCode) messages.push("Müşteri kodu boş");
        else {
          const c = await db.query(`select id, payment_terms_days from customers where code = $1`, [v.customerCode]);
          if (!c.rows[0]) messages.push(`Müşteri bulunamadı: ${v.customerCode}`);
          else {
            v.customerId = c.rows[0].id;
            v.paymentTermsDays = c.rows[0].payment_terms_days;
          }
        }

        if (v.receivedAmount) {
          const received = normalizeDecimal(v.receivedAmount, input.decimalSeparator);
          const gross = Number(net || 0) + Number(v.taxAmount || 0);
          if (!received || Number(received) < 0) messages.push(`Tahsil edilen tutar geçersiz: "${v.receivedAmount}"`);
          else if (Number(received) > gross + 1e-9) messages.push(`Tahsil edilen tutar (${received}) brüt tutarı (${gross.toFixed(2)}) aşamaz`);
          else v.receivedAmount = received;
          if (!v.receivedDate) messages.push("Tahsil edilen tutar verilmişse tahsilat tarihi de gerekli");
          else if (Number.isNaN(Date.parse(v.receivedDate))) messages.push(`Tahsilat tarihi geçersiz: "${v.receivedDate}"`);
        }

        if (v.invoiceNo) {
          if (seen.has(v.invoiceNo)) messages.push("Dosyada mükerrer fatura no");
          seen.add(v.invoiceNo);
          const existing = await db.query(`select id from customer_invoices where code = $1`, [v.invoiceNo]);
          if (existing.rows[0]) messages.push(`Fatura numarası zaten kullanımda: ${v.invoiceNo}`);
        }

        out.push({ row: i + 2, status: messages.length ? "error" : "ok", messages, values: v as unknown as Record<string, string> });
      }
      const job = await db.query(
        `insert into import_jobs (company_id, kind, file_name, file_hash, mapping, preview, created_by)
         values (app_company_id(), 'ar_invoices', $1, $2, $3, $4, $5) returning id`,
        [input.fileName, hash, JSON.stringify(m), JSON.stringify(out), actor.userId],
      );
      return { jobId: job.rows[0].id, fileHash: hash, duplicateOf: await existingCommitted(db, "ar_invoices", null, hash), rows: out, summary: summarize(out) };
    });
  });

  /**
   * W39 devamı: tarihsel üretim (iş emri) geçişi. **Canlı akıştan (planla → yayımla → seri üret →
   * operasyon → test → kalite kapısı → serbest bırak) bilinçli olarak farklıdır**: geçmiş bir iş emrinin
   * hangi operasyonlardan geçtiği, hangi malzeme lotlarının tüketildiği ve cihaz bazlı test geçmişi bu
   * sistemde izlenmediğinden bunlar HİÇBİR ŞEKİLDE uydurulmaz — operasyon kaydı açılmaz, malzeme çıkışı
   * yazılmaz, test_runs oluşturulmaz. Yalnızca bilinen gerçek toplamlar kaydedilir: her satır bir iş emri;
   * ürün/revizyon (revizyon boşsa son yayımlanan), sağlam adet, hurda adet (opsiyonel) ve tamamlanma
   * tarihi zorunlu/verilir. Sağlam+hurda adet kadar sistem tarafından üretilen seri numaralı cihaz kaydı
   * açılır (canlı "yayımla" akışıyla aynı numaralandırma) — sağlam olanlar doğrudan bitmiş ürün lotuna
   * girer (canlı "son kalite serbest bırakma" ile aynı stok etkisi), hurda olanlar iz sürülür ama stok
   * etkisi yaratmaz. Bu, cihaz bazlı test geçmişini uydurmadan mevcut gösterge/maliyet altyapısıyla tutarlı
   * kalmayı sağlar (bkz. computeWorkOrderCost'taki migrated koruması).
   */
  app.post("/api/imports/work-orders/preview", async (req): Promise<ImportPreview> => {
    const input = parse(WorkOrderImportPreviewInput, req.body);
    return tenant(req, "production.plan", async (db, actor) => {
      const hash = sha256(input.content);
      const { rows } = parseCsv(input.content);
      const m = input.mapping;
      const out: ImportPreviewRow[] = [];
      const seen = new Set<string>();
      for (const [i, raw] of rows.entries()) {
        const v: WorkOrderRowValues = {
          woCode: m.woCode ? (raw[m.woCode] ?? "").trim() : "",
          productCode: (raw[m.productCode] ?? "").trim(),
          rev: m.rev ? (raw[m.rev] ?? "").trim() : "",
          qtyGood: (raw[m.qtyGood] ?? "").trim(),
          qtyScrap: m.qtyScrap ? (raw[m.qtyScrap] ?? "").trim() : "",
          completedDate: (raw[m.completedDate] ?? "").trim(),
          unitCost: m.unitCost ? (raw[m.unitCost] ?? "").trim() : "",
          currency: m.currency ? (raw[m.currency] ?? "").trim() : "",
        };
        const messages: string[] = [];

        if (!v.currency) v.currency = "TRY";
        else if (!/^[A-Z]{3}$/.test(v.currency)) messages.push(`Para birimi geçersiz: "${v.currency}"`);

        let good = 0;
        if (!/^\d+$/.test(v.qtyGood)) messages.push(`Sağlam adet geçersiz (tam sayı olmalı): "${v.qtyGood}"`);
        else good = Number(v.qtyGood);

        let scrap = 0;
        if (v.qtyScrap) {
          if (!/^\d+$/.test(v.qtyScrap)) messages.push(`Hurda adet geçersiz (tam sayı olmalı): "${v.qtyScrap}"`);
          else scrap = Number(v.qtyScrap);
        } else v.qtyScrap = "0";

        if (good + scrap <= 0) messages.push("Sağlam + hurda adet toplamı sıfırdan büyük olmalı");
        if (good + scrap > 10000) messages.push("Tek iş emrinde en fazla 10.000 seri kaydedilebilir");

        if (v.unitCost) {
          const cost = normalizeDecimal(v.unitCost, input.decimalSeparator);
          if (!cost || Number(cost) < 0) messages.push(`Birim maliyet geçersiz: "${v.unitCost}"`);
          else v.unitCost = cost;
        }

        if (!v.completedDate || Number.isNaN(Date.parse(v.completedDate))) messages.push(`Tamamlanma tarihi geçersiz: "${v.completedDate}"`);

        if (!v.productCode) messages.push("Ürün kodu boş");
        else {
          const p = await db.query(`select id, item_id from products where code = $1`, [v.productCode]);
          if (!p.rows[0]) messages.push(`Ürün bulunamadı: ${v.productCode}`);
          else {
            v.itemId = p.rows[0].item_id;
            let rev;
            if (v.rev) {
              rev = (await db.query(`select id, status, bom_version_id from product_revisions where product_id = $1 and rev = $2`, [p.rows[0].id, v.rev])).rows[0];
              if (!rev) messages.push(`Revizyon bulunamadı: ${v.productCode} Rev.${v.rev}`);
              else if (rev.status !== "released") messages.push(`Revizyon yayımlanmamış (released değil): ${v.productCode} Rev.${v.rev}`);
            } else {
              rev = (await db.query(`select id, bom_version_id from product_revisions where product_id = $1 and status = 'released' order by released_at desc nulls last limit 1`, [p.rows[0].id])).rows[0];
              if (!rev) messages.push(`Ürünün yayımlanmış (released) revizyonu yok, revizyon sütunu belirtilmeli: ${v.productCode}`);
            }
            if (rev) { v.productRevisionId = rev.id; v.bomVersionId = rev.bom_version_id; }
          }
        }

        if (v.woCode) {
          if (seen.has(v.woCode)) messages.push("Dosyada mükerrer iş emri kodu");
          seen.add(v.woCode);
          const existing = await db.query(`select id from work_orders where code = $1`, [v.woCode]);
          if (existing.rows[0]) messages.push(`İş emri kodu zaten kullanımda: ${v.woCode}`);
        }

        out.push({ row: i + 2, status: messages.length ? "error" : "ok", messages, values: v as unknown as Record<string, string> });
      }
      const job = await db.query(
        `insert into import_jobs (company_id, kind, file_name, file_hash, mapping, preview, created_by)
         values (app_company_id(), 'work_orders', $1, $2, $3, $4, $5) returning id`,
        [input.fileName, hash, JSON.stringify(m), JSON.stringify(out), actor.userId],
      );
      return { jobId: job.rows[0].id, fileHash: hash, duplicateOf: await existingCommitted(db, "work_orders", null, hash), rows: out, summary: summarize(out) };
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
      const perm =
        job.kind === "bom" ? "bom.import"
        : job.kind === "customers" || job.kind === "sales_orders" ? "sales.create"
        : job.kind === "suppliers" ? "supplier.manage"
        : job.kind === "ap_invoices" ? "invoice.manage"
        : job.kind === "purchase_orders" ? "purchase.order.manage"
        : job.kind === "ar_invoices" ? "receivable.manage"
        : job.kind === "work_orders" ? "production.plan"
        : "inventory.import";
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
      } else if (job.kind === "customers") {
        // Ana veri upsert'i: kod eşleşirse ad güncellenir, yoksa yeni müşteri açılır. Hareket/rezervasyon etkilenmez.
        let created = 0;
        let updated = 0;
        for (const r of rows) {
          const v = r.values as unknown as CustomerRowValues;
          const up = await db.query(
            `insert into customers (company_id, code, name) values (app_company_id(), $1, $2)
             on conflict (company_id, code) do update set name = excluded.name
             returning (xmax = 0) as inserted`,
            [v.code, v.name],
          );
          if (up.rows[0].inserted) created++;
          else updated++;
        }
        result = { created, updated };
        await recordEvent(db, importActor, { entityType: "import_job", entityId: id, eventType: "customers.imported", after: result, source: `import:${id}` });
      } else if (job.kind === "suppliers") {
        // Ana veri upsert'i: kod eşleşirse ad/iletişim/teslim süresi güncellenir, yoksa yeni tedarikçi açılır.
        let created = 0;
        let updated = 0;
        for (const r of rows) {
          const v = r.values as unknown as SupplierRowValues;
          const up = await db.query(
            `insert into suppliers (company_id, code, name, contact_email, default_lead_time_days) values (app_company_id(), $1, $2, $3, $4)
             on conflict (company_id, code) do update set name = excluded.name, contact_email = coalesce(excluded.contact_email, suppliers.contact_email),
               default_lead_time_days = coalesce(excluded.default_lead_time_days, suppliers.default_lead_time_days)
             returning (xmax = 0) as inserted`,
            [v.code, v.name, v.contactEmail || null, v.leadTimeDays ? Number(v.leadTimeDays) : null],
          );
          if (up.rows[0].inserted) created++;
          else updated++;
        }
        result = { created, updated };
        await recordEvent(db, importActor, { entityType: "import_job", entityId: id, eventType: "suppliers.imported", after: result, source: `import:${id}` });
      } else if (job.kind === "sales_orders") {
        // Tarihsel geçiş: rezervasyon/üretim ihtiyacı/satın alma talebi/kredi kontrolü çalıştırılmaz (bkz. önizleme uç noktasındaki açıklama).
        // Aynı sipariş kodundaki satırlar sırayla tek siparişin kalemleri olarak gruplanır.
        const groups = new Map<string, { customerId: string; status: string; requestedDate: string; lines: SalesOrderRowValues[] }>();
        const order: string[] = [];
        for (const r of rows) {
          const v = r.values as unknown as SalesOrderRowValues;
          const key = v.orderCode || `__auto__${r.row}`;
          if (!groups.has(key)) {
            groups.set(key, { customerId: v.customerId!, status: v.status, requestedDate: v.requestedDate, lines: [] });
            order.push(key);
          }
          groups.get(key)!.lines.push(v);
        }
        let ordersCreated = 0;
        let linesCreated = 0;
        for (const key of order) {
          const g = groups.get(key)!;
          const code = key.startsWith("__auto__") ? await nextCode(db, actor.companyId, "sales_order", "SS") : key;
          const o = await db.query(
            `insert into sales_orders (company_id, code, customer_id, status, requested_date, created_by, confirmed_at)
             values (app_company_id(), $1, $2, $3, $4, $5, $6) returning id`,
            [code, g.customerId, g.status, g.requestedDate, actor.userId, g.status === "firm" ? new Date() : null],
          );
          ordersCreated++;
          for (const [idx, v] of g.lines.entries()) {
            await db.query(
              `insert into sales_order_lines (company_id, order_id, line_no, product_revision_id, qty, unit_price, currency)
               values (app_company_id(), $1, $2, $3, $4, $5, $6)`,
              [o.rows[0].id, idx + 1, v.productRevisionId, v.qty, v.unitPrice || null, v.currency || "TRY"],
            );
            linesCreated++;
          }
          await recordEvent(db, importActor, {
            entityType: "sales_order",
            entityId: o.rows[0].id,
            eventType: "imported",
            after: { code, lines: g.lines.length, note: "tarihsel geçiş — uygunluk hesaplanmadı" },
            source: `import:${id}`,
          });
        }
        result = { orders: ordersCreated, lines: linesCreated };
      } else if (job.kind === "ap_invoices") {
        // Tarihsel geçiş: üç yönlü eşleştirme çalıştırılmaz, lot maliyeti yazılmaz (bkz. önizleme uç noktasındaki açıklama).
        // Fatura doğrudan 'approved' (veya tamamı ödenmişse 'paid') kaydedilir.
        let invoicesCreated = 0;
        let paymentsRecorded = 0;
        for (const r of rows) {
          const v = r.values as unknown as ApInvoiceRowValues;
          const net = Number(v.netAmount);
          const tax = Number(v.taxAmount || "0");
          const gross = net + tax;
          const due = v.dueDate || new Date(Date.parse(`${v.invoiceDate}T00:00:00Z`) + (v.paymentTermsDays ?? 30) * 864e5).toISOString().slice(0, 10);
          const code = await nextCode(db, actor.companyId, "supplier_invoice", "TF");
          const paidFull = v.paidAmount && Math.abs(Number(v.paidAmount) - gross) < 0.005;
          const matchResult = {
            migrated: true,
            note: "Tarihsel geçiş — sipariş/mal kabul bağlantısı olmadığından üç yönlü eşleştirme çalıştırılmadı; fatura doğrudan onaylı kaydedildi",
          };
          const inv = await db.query(
            `insert into supplier_invoices (company_id, code, supplier_id, invoice_no, invoice_date, due_date, currency, net_amount, tax_amount, gross_amount, status, match_result, entered_by)
             values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
            [code, v.supplierId, v.invoiceNo, v.invoiceDate, due, v.currency, net.toFixed(2), tax.toFixed(2), gross.toFixed(2), paidFull ? "paid" : "approved", JSON.stringify(matchResult), actor.userId],
          );
          await db.query(
            `insert into supplier_invoice_lines (company_id, invoice_id, line_no, description, qty, unit_price, amount)
             values (app_company_id(), $1, 1, $2, 1, $3, $3)`,
            [inv.rows[0].id, v.description || `Tarihsel geçiş — ${v.invoiceNo}`, net.toFixed(2)],
          );
          invoicesCreated++;
          if (v.paidAmount && Number(v.paidAmount) > 0) {
            await db.query(
              `insert into supplier_payments (company_id, invoice_id, amount, paid_on, reference, recorded_by) values (app_company_id(), $1, $2, $3, $4, $5)`,
              [inv.rows[0].id, v.paidAmount, v.paidDate, `Tarihsel geçiş — import:${id}`, actor.userId],
            );
            paymentsRecorded++;
          }
          await recordEvent(db, importActor, {
            entityType: "supplier_invoice",
            entityId: inv.rows[0].id,
            eventType: "imported",
            after: { code, invoiceNo: v.invoiceNo, gross: gross.toFixed(2), status: paidFull ? "paid" : "approved" },
            source: `import:${id}`,
          });
        }
        result = { invoices: invoicesCreated, payments: paymentsRecorded };
      } else if (job.kind === "purchase_orders") {
        // Tarihsel geçiş: RFQ/teklif/satın alma talebi/tahsisat çalıştırılmaz (bkz. önizleme uç noktasındaki açıklama).
        // Aynı sipariş kodundaki satırlar sırayla tek siparişin kalemleri olarak gruplanır. Durum, canlı sistemle
        // AYNI türetme fonksiyonuyla (refreshPoStatus) satırlardan hesaplanır — uydurulmaz.
        const groups = new Map<string, { supplierId: string; currency: string; lines: PurchaseOrderRowValues[] }>();
        const order: string[] = [];
        for (const r of rows) {
          const v = r.values as unknown as PurchaseOrderRowValues;
          const key = v.poCode || `__auto__${r.row}`;
          if (!groups.has(key)) {
            groups.set(key, { supplierId: v.supplierId!, currency: v.currency, lines: [] });
            order.push(key);
          }
          groups.get(key)!.lines.push(v);
        }
        let ordersCreated = 0;
        let linesCreated = 0;
        for (const key of order) {
          const g = groups.get(key)!;
          const code = key.startsWith("__auto__") ? await nextCode(db, actor.companyId, "purchase_order", "SAS") : key;
          const supplierName = (await db.query(`select name from suppliers where id = $1`, [g.supplierId])).rows[0].name as string;
          const po = await db.query(
            `insert into purchase_orders (company_id, code, supplier_id, currency, status, created_by)
             values (app_company_id(), $1, $2, $3, 'sent', $4) returning id`,
            [code, g.supplierId, g.currency, actor.userId],
          );
          ordersCreated++;
          for (const v of g.lines) {
            await db.query(
              `insert into purchase_order_lines (company_id, po_code, supplier_name, supplier_id, item_id, qty_ordered, qty_received, po_id, unit_price, currency, requested_date, confirmed_date)
               values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [code, supplierName, g.supplierId, v.itemId, v.qty, v.qtyReceived, po.rows[0].id, v.unitPrice || null, g.currency, v.requestedDate || null, v.confirmedDate || null],
            );
            linesCreated++;
          }
          // Sipariş başlığı durumunu (gönderildi/teyitli/kısmen teslim alındı/teslim alındı) satırlardaki gerçek
          // teyit tarihi/teslim alınan miktardan türet — canlı sistemle aynı fonksiyon, ayrı bir dürüstlük kontrolü.
          await refreshPoStatus(db, po.rows[0].id);
          await recordEvent(db, importActor, {
            entityType: "purchase_order",
            entityId: po.rows[0].id,
            eventType: "imported",
            after: { code, lines: g.lines.length, note: "tarihsel geçiş — RFQ/teklif/tahsisat oluşturulmadı" },
            source: `import:${id}`,
          });
        }
        result = { orders: ordersCreated, lines: linesCreated };
      } else if (job.kind === "ar_invoices") {
        // Tarihsel geçiş: sipariş/sevkiyat bağlantısı uydurulmaz (bkz. önizleme uç noktasındaki açıklama);
        // sales_order_id/shipment_id null kalır, migrated=true işaretlenir. Fatura önce 'draft' olarak
        // eklenir (satır ekleme yalnızca 'draft' durumunda izinlidir — customer_invoice_lines_guard),
        // satırı yazılır, sonra 'issued' (veya tamamı tahsil edilmişse 'paid') olarak işaretlenir —
        // canlı "kes" akışıyla aynı sıra (draft → issued), guard tetiğini bilerek ihlal etmiyor.
        let invoicesCreated = 0;
        let receiptsRecorded = 0;
        for (const r of rows) {
          const v = r.values as unknown as ArInvoiceRowValues;
          const net = Number(v.netAmount);
          const tax = Number(v.taxAmount || "0");
          const gross = net + tax;
          const due = v.dueDate || new Date(Date.parse(`${v.invoiceDate}T00:00:00Z`) + (v.paymentTermsDays ?? 30) * 864e5).toISOString().slice(0, 10);
          const code = v.invoiceNo || (await nextCode(db, actor.companyId, "customer_invoice_issued", "MF"));
          const receivedFull = v.receivedAmount && Math.abs(Number(v.receivedAmount) - gross) < 0.005;
          const inv = await db.query(
            `insert into customer_invoices (company_id, code, customer_id, sales_order_id, shipment_id, status, migrated, invoice_date, due_date, currency, tax_rate, net_amount, tax_amount, gross_amount, created_by, issued_by, issued_at)
             values (app_company_id(), $1, $2, null, null, 'draft', true, $3, $4, $5, $6, $7, $8, $9, $10, $10, now()) returning id`,
            [code, v.customerId, v.invoiceDate, due, v.currency, v.taxRate, net.toFixed(2), tax.toFixed(2), gross.toFixed(2), actor.userId],
          );
          await db.query(
            `insert into customer_invoice_lines (company_id, invoice_id, line_no, description, qty, unit_price, amount)
             values (app_company_id(), $1, 1, $2, 1, $3, $3)`,
            [inv.rows[0].id, v.description || `Tarihsel geçiş — ${code}`, net.toFixed(2)],
          );
          await db.query(`update customer_invoices set status = $2 where id = $1`, [inv.rows[0].id, receivedFull ? "paid" : "issued"]);
          invoicesCreated++;
          if (v.receivedAmount && Number(v.receivedAmount) > 0) {
            await db.query(
              `insert into customer_receipts (company_id, invoice_id, amount, received_on, reference, recorded_by) values (app_company_id(), $1, $2, $3, $4, $5)`,
              [inv.rows[0].id, v.receivedAmount, v.receivedDate, `Tarihsel geçiş — import:${id}`, actor.userId],
            );
            receiptsRecorded++;
          }
          await recordEvent(db, importActor, {
            entityType: "customer_invoice",
            entityId: inv.rows[0].id,
            eventType: "imported",
            after: { code, gross: gross.toFixed(2), status: receivedFull ? "paid" : "issued" },
            source: `import:${id}`,
          });
        }
        result = { invoices: invoicesCreated, receipts: receiptsRecorded };
      } else if (job.kind === "work_orders") {
        // Tarihsel geçiş: operasyon/malzeme çıkışı/test geçmişi bu sistemde izlenmediğinden uydurulmaz
        // (bkz. önizleme uç noktasındaki açıklama). Yalnızca bilinen gerçek toplamlar kaydedilir.
        const finished = (await db.query(`select id from locations where type = 'finished' order by code limit 1`)).rows[0];
        if (!finished) throw conflict("location_missing", `"finished" tipinde konum tanımlı değil`);
        let workOrdersCreated = 0;
        let devicesCreated = 0;
        for (const r of rows) {
          const v = r.values as unknown as WorkOrderRowValues;
          const good = Number(v.qtyGood);
          const scrap = Number(v.qtyScrap || "0");
          const total = good + scrap;
          const code = v.woCode || (await nextCode(db, actor.companyId, "work_order", "IE"));
          const wo = await db.query(
            `insert into work_orders (company_id, code, product_revision_id, bom_version_id, qty, status, migrated, created_by, released_at, completed_at)
             values (app_company_id(), $1, $2, $3, $4, 'completed', true, $5, $6, $6) returning id`,
            [code, v.productRevisionId, v.bomVersionId, String(total), actor.userId, v.completedDate],
          );
          workOrdersCreated++;
          let lotId: string | null = null;
          if (good > 0) {
            const lot = await db.query(
              `insert into lots (company_id, item_id, lot_no, product_revision_id) values (app_company_id(), $1, $2, $3)
               on conflict (company_id, item_id, lot_no) do update set lot_no = excluded.lot_no returning id`,
              [v.itemId, code, v.productRevisionId],
            );
            lotId = lot.rows[0].id;
            await db.query(
              `insert into stock_moves (company_id, item_id, lot_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
               values (app_company_id(), $1, $2, $3, $4, 'produce', 'work_order', $5, $6)`,
              [v.itemId, lotId, finished.id, String(good), wo.rows[0].id, actor.userId],
            );
            if (v.unitCost) {
              await recordLotCost(db, importActor, lotId!, { unitCost: v.unitCost, currency: v.currency, source: "production", reference: `${code} tarihsel geçiş (W39 devamı) — verilen birim maliyet` });
            }
          }
          for (let g = 1; g <= good; g++) {
            await db.query(
              `insert into devices (company_id, serial, work_order_id, product_revision_id, status, finished_lot_id)
               values (app_company_id(), $1, $2, $3, 'released', $4)`,
              [`${code}-${String(g).padStart(5, "0")}`, wo.rows[0].id, v.productRevisionId, lotId],
            );
            devicesCreated++;
          }
          for (let s = 1; s <= scrap; s++) {
            await db.query(
              `insert into devices (company_id, serial, work_order_id, product_revision_id, status)
               values (app_company_id(), $1, $2, $3, 'scrapped')`,
              [`${code}-${String(good + s).padStart(5, "0")}`, wo.rows[0].id, v.productRevisionId],
            );
            devicesCreated++;
          }
          await recordEvent(db, importActor, {
            entityType: "work_order",
            entityId: wo.rows[0].id,
            eventType: "imported",
            after: { code, qtyGood: good, qtyScrap: scrap, note: "tarihsel geçiş — operasyon/malzeme çıkışı/test geçmişi izlenmedi" },
            source: `import:${id}`,
          });
        }
        result = { workOrders: workOrdersCreated, devices: devicesCreated };
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
          if (v.unitCost) await recordLotCost(db, importActor, lot.rows[0].id, { unitCost: v.unitCost, currency: v.currency ?? "TRY", source: "opening", reference: `açılış içe aktarımı ${job.file_name}` });
          moves++;
        }
        result = { moves };
      }
      await db.query(`update import_jobs set status = 'committed', committed_at = now(), result = $2 where id = $1`, [id, JSON.stringify(result)]);
      await recordEvent(db, importActor, { entityType: "import_job", entityId: id, eventType: "committed", after: result, source: job.file_name });
      return { jobId: id, ...result };
    });
  });

  /**
   * W39 devamı: kaynak-hedef uzlaşma. Kaynak = onaylanan işin kaydettiği önizleme satır sayısı (T13
   * kapısı geçildiği için işlenmiş bir işte hatalı/çözümsüz belirsiz satır kalmamış olması garanti);
   * hedef = türe göre gerçekte oluşan kayıt sayısı (BOM satırı, stok hareketi, oluşturulan+güncellenen
   * ana veri). İkisi eşleşmezse (örn. bir kod çakışması sessizce atlanmışsa) sessizce geçilmez, işaretlenir.
   */
  function reconcile(kind: string, previewLen: number, result: Record<string, unknown> | null): { sourceRows: number; targetRows: number | null; matched: boolean | null } {
    if (!result) return { sourceRows: previewLen, targetRows: null, matched: null };
    const targetRows =
      kind === "bom" || kind === "sales_orders" || kind === "purchase_orders" ? Number(result.lines ?? 0)
      : kind === "stock_opening" ? Number(result.moves ?? 0)
      : kind === "customers" || kind === "suppliers" ? Number(result.created ?? 0) + Number(result.updated ?? 0)
      : kind === "ap_invoices" || kind === "ar_invoices" ? Number(result.invoices ?? 0)
      : kind === "work_orders" ? Number(result.workOrders ?? 0)
      : null;
    return { sourceRows: previewLen, targetRows, matched: targetRows === null ? null : targetRows === previewLen };
  }

  app.get("/api/imports", async (req) =>
    tenant(req, null, async (db) => {
      const r = await db.query(
        `select id, kind, file_name as "fileName", status, created_at as "createdAt", committed_at as "committedAt", result,
                jsonb_array_length(coalesce(preview, '[]'::jsonb)) as "previewLen"
           from import_jobs order by created_at desc limit 100`,
      );
      return r.rows.map((j: any) => {
        const { previewLen, ...rest } = j;
        return { ...rest, reconciliation: j.status === "committed" ? reconcile(j.kind, previewLen, j.result) : null };
      });
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
