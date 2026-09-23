import type { FastifyInstance, FastifyRequest } from "fastify";
import { CreateCustomerInput, CreateSalesOrderInput, USABLE_LOCATION_TYPES, type ConfirmResult, type SalesOrder } from "@apisfactory/shared";
import type { Db } from "../db/pool";
import { conflict, notFound } from "../lib/errors";
import { enqueue, idempotent, nextCode, openTask, recordEvent, type Actor } from "../lib/records";
import { fromMicro, max, min, mul, toMicro } from "../lib/decimal";
import { can, idempotencyKey, parse, tenant } from "../http/context";

const USABLE = USABLE_LOCATION_TYPES as readonly string[];

type LineRow = { id: string; line_no: number; qty: string; product_revision_id: string; rev: string; rev_status: string; bom_version_id: string | null; item_id: string; product_code: string };
type LinePlan = ConfirmResult["lines"][number];

async function loadOrder(db: Db, id: string, req: FastifyRequest): Promise<SalesOrder> {
  const o = await db.query(
    `select so.id, so.code, so.customer_id as "customerId", c.name as "customerName", so.status, so.requested_date as "requestedDate"
       from sales_orders so join customers c on c.id = so.customer_id where so.id = $1`,
    [id],
  );
  if (!o.rows[0]) throw notFound("Satış siparişi");
  const lines = await db.query(
    `select l.id, l.product_revision_id as "productRevisionId", p.code as "productCode", pr.rev, l.qty, l.unit_price as "unitPrice", l.currency
       from sales_order_lines l join product_revisions pr on pr.id = l.product_revision_id join products p on p.id = pr.product_id
      where l.order_id = $1 order by l.line_no`,
    [id],
  );
  // Alan izni: satış fiyatı yetkisiz rollere API seviyesinde de gönderilmez (prompt §5, §25).
  const showPrice = can(req, "field.price.view");
  return { ...o.rows[0], lines: lines.rows.map((l) => (showPrice ? l : { ...l, unitPrice: undefined })) };
}

async function orderLines(db: Db, orderId: string): Promise<LineRow[]> {
  const r = await db.query(
    `select l.id, l.line_no, l.qty, l.product_revision_id, pr.rev, pr.status as rev_status, pr.bom_version_id, p.item_id, p.code as product_code
       from sales_order_lines l join product_revisions pr on pr.id = l.product_revision_id join products p on p.id = pr.product_id
      where l.order_id = $1 order by l.line_no`,
    [orderId],
  );
  return r.rows;
}

/** Kalemin kullanılabilir (ayrılmamış) miktarı: kullanılabilir konum bakiyesi − aktif rezervasyon. */
async function freeQty(db: Db, itemId: string): Promise<bigint> {
  const r = await db.query(
    `select coalesce((select sum(b.qty) from stock_balances b join locations loc on loc.id = b.location_id
                       where b.item_id = $1 and loc.type = any($2)), 0) as usable,
            coalesce((select sum(qty) from reservations where item_id = $1 and status = 'active'), 0) as reserved`,
    [itemId, USABLE],
  );
  return toMicro(r.rows[0].usable) - toMicro(r.rows[0].reserved);
}

/**
 * Satır planı (prompt §12):
 *  1) Kalitece serbest bırakılmış, doğru revizyondaki bitmiş stoktan rezervasyon.
 *  2) Kalan için üretim ihtiyacı (BOM sürümü sabitlenir).
 *  3) Net malzeme = brüt − ayrılmamış kullanılabilir stok − ihtiyaç tarihine yetişen teyitli ve ayrılmamış açık alım.
 *     Karantina, giriş kontrolü, fason ve başka işe ayrılmış miktar uygun sayılmaz.
 * write=false iken hiçbir şey yazılmaz (uygunluk önizlemesi).
 */
async function planLine(db: Db, actor: Actor, line: LineRow, requestedDate: string, write: boolean): Promise<LinePlan> {
  const qty = toMicro(line.qty);

  // 1) Bitmiş ürün: lot bazında serbest miktar.
  const lots = await db.query(
    `select b.lot_id, sum(b.qty) as usable,
            coalesce((select sum(r.qty) from reservations r where r.lot_id = b.lot_id and r.status = 'active'), 0) as reserved
       from stock_balances b join locations loc on loc.id = b.location_id join lots l on l.id = b.lot_id
      where b.item_id = $1 and l.product_revision_id = $2 and loc.type = any($3)
      group by b.lot_id, l.created_at order by l.created_at`,
    [line.item_id, line.product_revision_id, USABLE],
  );
  let remaining = qty;
  let reserved = 0n;
  for (const lot of lots.rows) {
    if (remaining <= 0n) break;
    const free = toMicro(lot.usable) - toMicro(lot.reserved);
    const take = min(free, remaining);
    if (take <= 0n) continue;
    if (write) {
      await db.query(
        `insert into reservations (company_id, item_id, lot_id, qty, demand_type, demand_id) values (app_company_id(), $1, $2, $3, 'sales_order_line', $4)`,
        [line.item_id, lot.lot_id, fromMicro(take), line.id],
      );
    }
    reserved += take;
    remaining -= take;
  }

  const plan: LinePlan = { lineId: line.id, reservedQty: fromMicro(reserved), productionNeedQty: fromMicro(remaining), materials: [] };
  if (remaining <= 0n) return plan;
  if (!line.bom_version_id) throw conflict("no_bom", `Revizyonun BOM sürümü yok: ${line.product_code} Rev.${line.rev}`);

  let needId: string | null = null;
  if (write) {
    const n = await db.query(
      `insert into production_needs (company_id, sales_order_line_id, product_revision_id, bom_version_id, qty)
       values (app_company_id(), $1, $2, $3, $4) returning id`,
      [line.id, line.product_revision_id, line.bom_version_id, fromMicro(remaining)],
    );
    needId = n.rows[0].id;
    await openTask(db, actor.companyId, {
      kind: "production_planning",
      title: `Üretim planla — ${line.product_code} Rev.${line.rev} × ${fromMicro(remaining)}`,
      entityType: "production_need",
      entityId: needId!,
      assigneeRole: "production",
    });
  }

  // 2-3) Malzemeler (DNP hariç, aynı kalem birleştirilir).
  const bom = await db.query(
    `select bl.item_id, i.code, sum(bl.qty_per) as qty_per from bom_lines bl join items i on i.id = bl.item_id
      where bl.bom_version_id = $1 and not bl.dnp group by bl.item_id, i.code order by i.code`,
    [line.bom_version_id],
  );
  for (const m of bom.rows) {
    const gross = mul(remaining, toMicro(m.qty_per));
    const free = max(0n, await freeQty(db, m.item_id));
    const resQty = min(gross, free);
    let rem = gross - resQty;
    if (write && resQty > 0n) {
      await db.query(
        `insert into reservations (company_id, item_id, qty, demand_type, demand_id) values (app_company_id(), $1, $2, 'production_need', $3)`,
        [m.item_id, fromMicro(resQty), needId],
      );
    }
    // Teyitli, ihtiyaç tarihine yetişen, ayrılmamış açık alım.
    const pos = await db.query(
      `select po.id, po.qty_ordered - po.qty_received - coalesce((select sum(a.qty) from purchase_allocations a where a.po_line_id = po.id), 0) as free
         from purchase_order_lines po
        where po.item_id = $1 and po.status = 'open' and po.confirmed_date is not null and po.confirmed_date <= $2
        order by po.confirmed_date`,
      [m.item_id, requestedDate],
    );
    let fromPo = 0n;
    for (const po of pos.rows) {
      if (rem <= 0n) break;
      const take = min(toMicro(po.free), rem);
      if (take <= 0n) continue;
      if (write) {
        await db.query(`insert into purchase_allocations (company_id, po_line_id, production_need_id, qty) values (app_company_id(), $1, $2, $3)`, [
          po.id,
          needId,
          fromMicro(take),
        ]);
      }
      fromPo += take;
      rem -= take;
    }
    let prId: string | null = null;
    if (write && rem > 0n) {
      const code = await nextCode(db, actor.companyId, "purchase_request", "SAT");
      const pr = await db.query(
        `insert into purchase_requests (company_id, code, item_id, qty, need_date, source_type, source_id)
         values (app_company_id(), $1, $2, $3, $4, 'production_need', $5) returning id`,
        [code, m.item_id, fromMicro(rem), requestedDate, needId],
      );
      prId = pr.rows[0].id;
      await openTask(db, actor.companyId, {
        kind: "purchase_request_review",
        title: `Satın alma talebi ${code} — ${m.code} × ${fromMicro(rem)}`,
        entityType: "purchase_request",
        entityId: prId!,
        assigneeRole: "purchasing",
      });
      await recordEvent(db, { ...actor, kind: "automation" }, { entityType: "purchase_request", entityId: prId!, eventType: "created", after: { code, itemId: m.item_id, qty: fromMicro(rem), source: needId } });
    }
    plan.materials.push({
      itemId: m.item_id,
      itemCode: m.code,
      grossQty: fromMicro(gross),
      reservedQty: fromMicro(resQty),
      openPurchaseQty: fromMicro(fromPo),
      netQty: fromMicro(rem),
      purchaseRequestId: prId,
    });
  }
  return plan;
}

/** Eşzamanlı kesinleştirmeler aynı kalemleri sırayla kilitler; aynı miktar iki işe ayrılamaz (T03). */
async function lockItems(db: Db, lines: LineRow[]) {
  const ids = new Set<string>();
  for (const l of lines) {
    ids.add(l.item_id);
    if (l.bom_version_id) {
      const r = await db.query(`select distinct item_id from bom_lines where bom_version_id = $1`, [l.bom_version_id]);
      r.rows.forEach((x) => ids.add(x.item_id));
    }
  }
  await db.query(`select id from items where id = any($1::uuid[]) order by id for update`, [[...ids]]);
}

export async function salesRoutes(app: FastifyInstance) {
  app.get("/api/customers", async (req) =>
    tenant(req, "sales.view", async (db) => (await db.query(`select id, code, name from customers order by name`)).rows),
  );

  app.post("/api/customers", async (req) => {
    const input = parse(CreateCustomerInput, req.body);
    return tenant(req, "sales.create", async (db, actor) => {
      const r = await db.query(`insert into customers (company_id, code, name) values (app_company_id(), $1, $2) returning id, code, name`, [input.code, input.name]);
      await recordEvent(db, actor, { entityType: "customer", entityId: r.rows[0].id, eventType: "created", after: r.rows[0] });
      return r.rows[0];
    });
  });

  app.get("/api/sales-orders", async (req) =>
    tenant(req, "sales.view", async (db) => {
      const r = await db.query(
        `select so.id, so.code, c.name as "customerName", so.status, so.requested_date as "requestedDate", so.created_at as "createdAt",
                (select coalesce(sum(qty),0) from sales_order_lines where order_id = so.id) as "totalQty"
           from sales_orders so join customers c on c.id = so.customer_id order by so.created_at desc limit 200`,
      );
      return r.rows;
    }),
  );

  /** Teklif/sipariş taslağı: devir onaysız ürün için de hazırlanabilir; kesinleştirme ayrıca denetlenir (T01). */
  app.post("/api/sales-orders", async (req) => {
    const input = parse(CreateSalesOrderInput, req.body);
    return tenant(req, "sales.create", async (db, actor) => {
      const code = await nextCode(db, actor.companyId, "sales_order", "SS");
      const o = await db.query(
        `insert into sales_orders (company_id, code, customer_id, requested_date, created_by) values (app_company_id(), $1, $2, $3, $4) returning id`,
        [code, input.customerId, input.requestedDate, actor.userId],
      );
      for (const [i, l] of input.lines.entries()) {
        await db.query(
          `insert into sales_order_lines (company_id, order_id, line_no, product_revision_id, qty, unit_price, currency)
           values (app_company_id(), $1, $2, $3, $4, $5, $6)`,
          [o.rows[0].id, i + 1, l.productRevisionId, l.qty, l.unitPrice ?? null, l.currency],
        );
      }
      await recordEvent(db, actor, { entityType: "sales_order", entityId: o.rows[0].id, eventType: "created", after: { code, lines: input.lines.length } });
      return loadOrder(db, o.rows[0].id, req);
    });
  });

  app.get("/api/sales-orders/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "sales.view", async (db) => {
      const order = await loadOrder(db, id, req);
      const r = await db.query(`select confirm_result from sales_orders where id = $1`, [id]);
      return { ...order, confirmResult: r.rows[0]?.confirm_result ?? null };
    });
  });

  /** Uygunluk önizlemesi: stok, üretim ihtiyacı ve net malzeme; hiçbir kayıt yazmaz. */
  app.get("/api/sales-orders/:id/availability", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "sales.view", async (db, actor) => {
      const o = await db.query(`select id, status, requested_date from sales_orders where id = $1`, [id]);
      if (!o.rows[0]) throw notFound("Satış siparişi");
      const lines = await orderLines(db, id);
      const blocked = lines.filter((l) => l.rev_status !== "released").map((l) => ({ lineId: l.id, product: `${l.product_code} Rev.${l.rev}`, status: l.rev_status }));
      const plans: LinePlan[] = [];
      for (const l of lines) if (l.bom_version_id || l.rev_status === "released") plans.push(await planLine(db, actor, l, o.rows[0].requested_date, false));
      return { orderId: id, canConfirm: blocked.length === 0, blockedLines: blocked, lines: plans };
    });
  });

  /**
   * Kesinleştirme (prompt §4, §12): devir onaysız ürün sunucuda reddedilir. Onayda rezervasyon, üretim ihtiyacı
   * ve net satın alma talepleri tek işlemde oluşur. Tekrar gelen onay aynı sonucu döner, ikinci ihtiyaç oluşmaz.
   * Tedarikçiye sipariş gönderimi bu adımda yapılmaz; satın alma onayına bağlıdır.
   */
  app.post("/api/sales-orders/:id/confirm", async (req): Promise<ConfirmResult> => {
    const { id } = req.params as { id: string };
    return tenant(req, "sales.confirm", (db, actor) =>
      idempotent(db, actor.companyId, "sales_confirm", idempotencyKey(req), async () => {
        const o = await db.query(`select id, status, requested_date, confirm_result from sales_orders where id = $1 for update`, [id]);
        const order = o.rows[0];
        if (!order) throw notFound("Satış siparişi");
        if (order.status === "firm") return { ...(order.confirm_result as ConfirmResult), alreadyConfirmed: true };
        if (order.status === "cancelled") throw conflict("invalid_transition", "İptal edilmiş sipariş kesinleştirilemez");

        const lines = await orderLines(db, id);
        const notReleased = lines.filter((l) => l.rev_status !== "released");
        if (notReleased.length) {
          throw conflict("product_not_released", "Ar-Ge, üretim ve kalite devir onayı tamamlanmamış ürün kesin satışa açılamaz", {
            lines: notReleased.map((l) => ({ lineId: l.id, product: `${l.product_code} Rev.${l.rev}`, status: l.rev_status })),
          });
        }
        await lockItems(db, lines);
        const plans: LinePlan[] = [];
        for (const l of lines) plans.push(await planLine(db, actor, l, order.requested_date, true));

        const result: ConfirmResult = { orderId: id, status: "firm", alreadyConfirmed: false, lines: plans };
        await db.query(`update sales_orders set status = 'firm', confirmed_at = now(), confirm_result = $2 where id = $1`, [id, JSON.stringify(result)]);
        await recordEvent(db, actor, { entityType: "sales_order", entityId: id, eventType: "status.firm", before: { status: order.status }, after: { status: "firm", plan: plans } });
        await enqueue(db, actor.companyId, "sales_order.confirmed", { orderId: id });
        return result;
      }),
    );
  });
}
