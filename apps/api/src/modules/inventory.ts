import type { FastifyInstance } from "fastify";
import { GoodsReceiptInput, InspectionInput, type ItemAvailability, USABLE_LOCATION_TYPES } from "@apisfactory/shared";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { closeTasks, idempotent, nextCode, openTask, recordEvent } from "../lib/records";
import { safeCell } from "../lib/csv";
import { fromMicro, toMicro } from "../lib/decimal";
import { idempotencyKey, parse, tenant } from "../http/context";

const USABLE = USABLE_LOCATION_TYPES as readonly string[];

/**
 * Fiziksel, kullanılabilir, rezerve, kontrol bekleyen, karantina ve fason miktarları ayrı hesaplanır (prompt §14).
 * Kullanılabilir = kullanılabilir konum tiplerindeki bakiye − aktif rezervasyon.
 */
export async function itemAvailability(db: Db, itemId: string): Promise<ItemAvailability> {
  const r = await db.query(
    `with bal as (
       select loc.type, sum(b.qty) as qty
         from stock_balances b join locations loc on loc.id = b.location_id
        where b.item_id = $1 group by loc.type
     )
     select
       coalesce((select sum(qty) from bal), 0) as physical,
       coalesce((select sum(qty) from bal where type = any($2)), 0) as usable,
       coalesce((select sum(qty) from reservations where item_id = $1 and status = 'active'), 0) as reserved,
       coalesce((select sum(qty) from bal where type = 'incoming_inspection'), 0) as inspection,
       coalesce((select sum(qty) from bal where type = 'quarantine'), 0) as quarantine,
       coalesce((select sum(qty) from bal where type = 'subcontractor'), 0) as subcontractor,
       coalesce((select sum(qty) from bal where type = 'returns'), 0) as returns,
       coalesce((select sum(qty_ordered - qty_received) from purchase_order_lines where item_id = $1 and status = 'open'), 0) as open_purchase`,
    [itemId, USABLE],
  );
  const x = r.rows[0];
  const n = (v: string) => fromMicro(toMicro(v));
  return {
    itemId,
    physical: n(x.physical),
    usable: n(x.usable),
    reserved: n(x.reserved),
    available: fromMicro(toMicro(x.usable) - toMicro(x.reserved)),
    inspection: n(x.inspection),
    quarantine: n(x.quarantine),
    subcontractor: n(x.subcontractor),
    returns: n(x.returns),
    openPurchase: n(x.open_purchase),
  };
}

async function locationByType(db: Db, type: string): Promise<string> {
  const r = await db.query(`select id from locations where type = $1 order by code limit 1`, [type]);
  if (!r.rows[0]) throw conflict("location_missing", `"${type}" tipinde konum tanımlı değil`);
  return r.rows[0].id;
}

export async function inventoryRoutes(app: FastifyInstance) {
  app.get("/api/locations", async (req) =>
    tenant(req, "inventory.view", async (db) => (await db.query(`select id, code, name, type from locations order by code`)).rows),
  );

  app.get("/api/stock/balances", async (req) => {
    const q = z.object({ itemId: z.string().uuid().optional(), q: z.string().optional() }).parse(req.query);
    return tenant(req, "inventory.view", async (db) => {
      const r = await db.query(
        `select b.item_id as "itemId", i.code as "itemCode", i.name as "itemName", b.lot_id as "lotId", l.lot_no as "lotNo",
                b.location_id as "locationId", loc.code as "locationCode", loc.type as "locationType", b.qty,
                l.inspection_status as "inspectionStatus"
           from stock_balances b
           join items i on i.id = b.item_id join lots l on l.id = b.lot_id join locations loc on loc.id = b.location_id
          where ($1::uuid is null or b.item_id = $1)
            and ($2::text is null or i.code ilike '%'||$2||'%' or i.mpn ilike '%'||$2||'%' or l.lot_no ilike '%'||$2||'%')
          order by i.code, l.lot_no, loc.code limit 500`,
        [q.itemId ?? null, q.q ?? null],
      );
      return r.rows;
    });
  });

  app.get("/api/stock/availability/:itemId", async (req) => {
    const { itemId } = req.params as { itemId: string };
    return tenant(req, "inventory.view", (db) => itemAvailability(db, itemId));
  });

  /** Barkod/lot sorgusu (mobil). */
  app.get("/api/lots/lookup", async (req) => {
    const { code } = z.object({ code: z.string().min(1) }).parse(req.query);
    return tenant(req, "inventory.view", async (db) => {
      const r = await db.query(
        `select l.id, l.lot_no as "lotNo", l.inspection_status as "inspectionStatus", l.date_code as "dateCode",
                i.id as "itemId", i.code as "itemCode", i.name as "itemName", i.mpn, i.manufacturer,
                coalesce((select json_agg(json_build_object('locationCode', loc.code, 'locationType', loc.type, 'qty', b.qty))
                            from stock_balances b join locations loc on loc.id = b.location_id where b.lot_id = l.id), '[]') as balances
           from lots l join items i on i.id = l.item_id
          where l.lot_no = $1 or i.code = $1 or lower(i.mpn) = lower($1)
          order by l.created_at desc limit 20`,
        [code],
      );
      return r.rows;
    });
  });

  /**
   * Mal kabul: parça "giriş kontrolü" konumuna girer ve kullanılabilir sayılmaz (prompt §4, §14).
   * Kalite görevi açılır. Idempotency-Key ile tekrar gönderim çift kayıt oluşturmaz.
   */
  app.post("/api/receipts", async (req) => {
    const input = parse(GoodsReceiptInput, req.body);
    return tenant(req, "inventory.receive", (db, actor) =>
      idempotent(db, actor.companyId, "receipt", idempotencyKey(req), async () => {
        const inspectionLoc = await locationByType(db, "incoming_inspection");
        const code = await nextCode(db, actor.companyId, "receipt", "MK");
        const gr = await db.query(
          `insert into goods_receipts (company_id, code, supplier_name, po_line_id, received_by) values (app_company_id(), $1, $2, $3, $4) returning id`,
          [code, input.supplierName, input.purchaseOrderLineId ?? null, actor.userId],
        );
        const lines = [];
        for (const l of input.lines) {
          const lot = await db.query(
            `insert into lots (company_id, item_id, lot_no, date_code, supplier_name, inspection_status)
             values (app_company_id(), $1, $2, $3, $4, 'pending') returning id`,
            [l.itemId, l.lotNo, l.dateCode ?? null, input.supplierName],
          ).catch((e) => {
            if (e.code === "23505") throw conflict("lot_exists", `Bu kalem için lot zaten var: ${l.lotNo}`);
            throw e;
          });
          const line = await db.query(
            `insert into goods_receipt_lines (company_id, receipt_id, item_id, lot_id, qty) values (app_company_id(), $1, $2, $3, $4) returning id`,
            [gr.rows[0].id, l.itemId, lot.rows[0].id, l.qty],
          );
          await db.query(
            `insert into stock_moves (company_id, item_id, lot_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
             values (app_company_id(), $1, $2, $3, $4, 'receive', 'goods_receipt_line', $5, $6)`,
            [l.itemId, lot.rows[0].id, inspectionLoc, l.qty, line.rows[0].id, actor.userId],
          );
          if (input.purchaseOrderLineId) {
            await db.query(`update purchase_order_lines set qty_received = qty_received + $2 where id = $1`, [input.purchaseOrderLineId, l.qty]);
          }
          await openTask(db, actor.companyId, {
            kind: "incoming_inspection",
            title: `Giriş kalite kontrolü — ${code} / lot ${l.lotNo}`,
            entityType: "goods_receipt_line",
            entityId: line.rows[0].id,
            assigneeRole: "quality",
          });
          lines.push({ id: line.rows[0].id, lotId: lot.rows[0].id, itemId: l.itemId, qty: l.qty, lotNo: l.lotNo });
        }
        await recordEvent(db, actor, { entityType: "goods_receipt", entityId: gr.rows[0].id, eventType: "received", after: { code, lines } });
        return { id: gr.rows[0].id, code, lines };
      }),
    );
  });

  app.get("/api/receipts", async (req) => {
    const q = z.object({ pending: z.string().optional() }).parse(req.query);
    return tenant(req, "inventory.view", async (db) => {
      const r = await db.query(
        `select gl.id, g.code, g.supplier_name as "supplierName", g.received_at as "receivedAt",
                i.id as "itemId", i.code as "itemCode", i.name as "itemName", i.mpn, l.lot_no as "lotNo", gl.qty,
                l.inspection_status as "inspectionStatus",
                ins.accepted_qty as "acceptedQty", ins.rejected_qty as "rejectedQty"
           from goods_receipt_lines gl join goods_receipts g on g.id = gl.receipt_id
           join items i on i.id = gl.item_id join lots l on l.id = gl.lot_id
           left join inspections ins on ins.receipt_line_id = gl.id
          where ($1::text is null or l.inspection_status = 'pending')
          order by g.received_at desc limit 200`,
        [q.pending ? "1" : null],
      );
      return r.rows;
    });
  });

  /**
   * Giriş kalite kararı: kabul edilen miktar kullanılabilir stoğa, reddedilen karantinaya taşınır.
   * Kabul + ret = teslim miktarı olmalı. Karar tekildir; ikinci karar reddedilir.
   */
  app.post("/api/receipt-lines/:id/inspection", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(InspectionInput, req.body);
    return tenant(req, "quality.incoming.decide", async (db, actor) => {
      const r = await db.query(
        `select gl.*, l.inspection_status from goods_receipt_lines gl join lots l on l.id = gl.lot_id where gl.id = $1 for update of l`,
        [id],
      );
      const line = r.rows[0];
      if (!line) throw notFound("Mal kabul satırı");
      if (line.inspection_status !== "pending") throw conflict("already_decided", "Bu kabul için kalite kararı zaten verildi");
      const sum = await db.query(`select ($1::numeric + $2::numeric = $3::numeric) as ok, ($1::numeric >= 0 and $2::numeric >= 0) as nonneg`, [
        input.acceptedQty,
        input.rejectedQty,
        line.qty,
      ]);
      if (!sum.rows[0].nonneg) throw badRequest("Miktarlar negatif olamaz");
      if (!sum.rows[0].ok) throw badRequest(`Kabul + ret, teslim miktarına (${line.qty}) eşit olmalı`);

      const [inspectionLoc, stockLoc, quarantineLoc] = [
        await locationByType(db, "incoming_inspection"),
        await locationByType(db, "stock"),
        await locationByType(db, "quarantine"),
      ];
      const moves: [string, string, string][] = [];
      if (Number(input.acceptedQty) > 0) moves.push([stockLoc, input.acceptedQty, "inspect_accept"]);
      if (Number(input.rejectedQty) > 0) moves.push([quarantineLoc, input.rejectedQty, "inspect_reject"]);
      for (const [to, qty, type] of moves) {
        await db.query(
          `insert into stock_moves (company_id, item_id, lot_id, from_location_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
           values (app_company_id(), $1, $2, $3, $4, $5, $6, 'goods_receipt_line', $7, $8)`,
          [line.item_id, line.lot_id, inspectionLoc, to, qty, type, id, actor.userId],
        );
      }
      const status = Number(input.rejectedQty) === 0 ? "accepted" : Number(input.acceptedQty) === 0 ? "rejected" : "partial";
      await db.query(`update lots set inspection_status = $2 where id = $1`, [line.lot_id, status]);
      await db.query(
        `insert into inspections (company_id, receipt_line_id, lot_id, accepted_qty, rejected_qty, decided_by, note)
         values (app_company_id(), $1, $2, $3, $4, $5, $6)`,
        [id, line.lot_id, input.acceptedQty, input.rejectedQty, actor.userId, input.note ?? null],
      );
      await closeTasks(db, actor.companyId, "incoming_inspection", id);
      await recordEvent(db, actor, {
        entityType: "lot",
        entityId: line.lot_id,
        eventType: `inspection.${status}`,
        before: { inspectionStatus: "pending" },
        after: { inspectionStatus: status, acceptedQty: input.acceptedQty, rejectedQty: input.rejectedQty },
        reason: input.note,
      });
      return { lotId: line.lot_id, inspectionStatus: status, availability: await itemAvailability(db, line.item_id) };
    });
  });

  /** Yetkili dışa aktarım; formül enjeksiyonu kaçışlı, dosyaya filtre ve üretim zamanı yazılır, işlem kaydedilir. */
  app.get("/api/export/stock.csv", async (req, reply) => {
    const csv = await tenant(req, "export.run", async (db, actor) => {
      const r = await db.query(
        `select i.code, i.name, i.mpn, l.lot_no, loc.code as location, loc.type, b.qty
           from stock_balances b join items i on i.id = b.item_id join lots l on l.id = b.lot_id join locations loc on loc.id = b.location_id
          order by i.code, l.lot_no`,
      );
      await recordEvent(db, actor, { entityType: "export", entityId: actor.companyId, eventType: "stock.csv", after: { rows: r.rowCount } });
      const header = `# apisfactory stok dökümü; üretim=${new Date().toISOString()}; kapsam=tüm konumlar\n`;
      const lines = ["kod,ad,mpn,lot,konum,konum_tipi,miktar", ...r.rows.map((x) => [x.code, x.name, x.mpn, x.lot_no, x.location, x.type, x.qty].map(safeCell).join(","))];
      return header + lines.join("\n");
    });
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="stok.csv"');
    return csv;
  });
}
