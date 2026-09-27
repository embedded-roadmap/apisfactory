import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { enqueue, idempotent, nextCode, recordEvent } from "../lib/records";
import { fromMicro, min, toMicro } from "../lib/decimal";
import { can, idempotencyKey, parse, tenant } from "../http/context";
import { RuleRejection, withRejectionLog } from "../lib/rejection";

const SHIPPED = ["shipped", "delivered", "problem"];
const OPEN = ["preparing", "packed"];
const CHECKLIST = ["box", "accessories", "label", "inspection"] as const;

const AddressInput = z.object({
  label: z.string().min(1).max(80),
  recipient: z.string().min(2).max(160),
  phone: z.string().max(40).optional(),
  line1: z.string().min(3).max(200),
  line2: z.string().max(200).optional(),
  district: z.string().max(80).optional(),
  city: z.string().min(2).max(80),
  postalCode: z.string().max(20).optional(),
  country: z.string().length(2).default("TR"),
  isDefault: z.boolean().default(false),
});

function needAny(req: FastifyRequest, ...perms: Parameters<typeof can>[1][]) {
  if (!perms.some((p) => can(req, p))) throw forbidden(perms.join("|"));
}

const addressCols = `id, label, recipient, phone, line1, line2, district, city, postal_code as "postalCode", country, is_default as "isDefault", active`;

/** Satır bazında: sipariş, sevk edilen, açık sevkiyatta, hazır (satıra ayrılmış serbest stok), şimdi sevk edilebilir. */
export async function shippableLines(db: Db, orderId: string, excludeShipmentId?: string) {
  const r = await db.query(
    `select l.id as "lineId", l.line_no as "lineNo", l.qty as ordered, p.code as "productCode", pr.rev,
            coalesce((select sum(sl.qty) from shipment_lines sl join shipments s on s.id = sl.shipment_id
                       where sl.sales_order_line_id = l.id and s.status = any($2)), 0) as shipped,
            coalesce((select sum(sl.qty) from shipment_lines sl join shipments s on s.id = sl.shipment_id
                       where sl.sales_order_line_id = l.id and s.status = any($3) and s.id is distinct from $4::uuid), 0) as "inOpen",
            coalesce((select sum(r.qty) from reservations r where r.demand_type = 'sales_order_line' and r.demand_id = l.id
                       and r.status = 'active' and r.lot_id is not null), 0) as ready
       from sales_order_lines l join product_revisions pr on pr.id = l.product_revision_id join products p on p.id = pr.product_id
      where l.order_id = $1 order by l.line_no`,
    [orderId, SHIPPED, OPEN, excludeShipmentId ?? null],
  );
  return r.rows.map((x) => {
    const remaining = toMicro(x.ordered) - toMicro(x.shipped) - toMicro(x.inOpen);
    const free = toMicro(x.ready) - toMicro(x.inOpen);
    const now = remaining < free ? remaining : free;
    return {
      ...x,
      ordered: fromMicro(toMicro(x.ordered)),
      shipped: fromMicro(toMicro(x.shipped)),
      inOpen: fromMicro(toMicro(x.inOpen)),
      ready: fromMicro(toMicro(x.ready)),
      remaining: fromMicro(remaining > 0n ? remaining : 0n),
      shippableNow: fromMicro(now > 0n ? now : 0n),
    };
  });
}

async function loadShipment(db: Db, id: string) {
  const s = await db.query(
    `select s.id, s.code, s.status, s.document_mode as "documentMode", s.carrier, s.tracking_no as "trackingNo", s.label_ref as "labelRef", cc.name as "cargoConnector",
            s.cargo_label_mode as "cargoLabelMode", s.label_object_key is not null as "hasLabelFile", s.label_content_type as "labelContentType", s.cargo_status as "cargoStatus", s.cargo_status_raw as "cargoStatusRaw", s.cargo_status_at as "cargoStatusAt",
            s.address_id as "addressId", s.address_snapshot as "addressSnapshot", s.shipped_at as "shippedAt", s.delivered_at as "deliveredAt",
            s.problem_note as "problemNote", s.cancel_reason as "cancelReason", s.created_at as "createdAt",
            so.id as "salesOrderId", so.code as "salesOrderCode", so.allow_partial as "allowPartial", c.name as "customerName", c.code as "customerCode",
            u.name as "createdBy", su.name as "shippedBy"
       from shipments s join sales_orders so on so.id = s.sales_order_id join customers c on c.id = so.customer_id
       left join users u on u.id = s.created_by left join users su on su.id = s.shipped_by left join cargo_connectors cc on cc.id = s.cargo_connector_id
      where s.id = $1`,
    [id],
  );
  if (!s.rows[0]) throw notFound("Sevkiyat");
  const address = s.rows[0].addressId
    ? (await db.query(`select ${addressCols} from customer_addresses where id = $1`, [s.rows[0].addressId])).rows[0]
    : null;
  const lines = await db.query(
    `select sl.id, sl.sales_order_line_id as "salesOrderLineId", sl.qty, p.code as "productCode", p.name as "productName", pr.rev,
            coalesce((select sum(pi.qty) from package_items pi where pi.shipment_line_id = sl.id), 0) as packed
       from shipment_lines sl join sales_order_lines l on l.id = sl.sales_order_line_id
       join product_revisions pr on pr.id = l.product_revision_id join products p on p.id = pr.product_id
      where sl.shipment_id = $1 order by l.line_no`,
    [id],
  );
  const pk = await db.query(
    `select pk.id, pk.seq, pk.code, pk.checklist, pk.weight_kg as "weightKg", pk.closed_at as "closedAt",
            coalesce(json_agg(json_build_object('id', pi.id, 'lineId', pi.shipment_line_id, 'serial', d.serial, 'lotNo', lo.lot_no, 'qty', pi.qty) order by pi.created_at)
                     filter (where pi.id is not null), '[]') as items
       from packages pk left join package_items pi on pi.package_id = pk.id
       left join devices d on d.id = pi.device_id left join lots lo on lo.id = pi.lot_id
      where pk.shipment_id = $1 group by pk.id order by pk.seq`,
    [id],
  );
  // Toplama listesi: satıra ayrılmış lotlardaki, henüz paketlenmemiş serbest bırakılmış seriler.
  const pick = await db.query(
    `select sl.id as "lineId", lo.lot_no as "lotNo", r.qty as "reservedQty",
            (select coalesce(json_agg(d.serial order by d.serial), '[]') from devices d
              where d.finished_lot_id = lo.id and d.status = 'released'
                and not exists (select 1 from package_items pi where pi.device_id = d.id)) as serials
       from shipment_lines sl join reservations r on r.demand_type = 'sales_order_line' and r.demand_id = sl.sales_order_line_id and r.status = 'active' and r.lot_id is not null
       join lots lo on lo.id = r.lot_id
      where sl.shipment_id = $1 order by lo.created_at`,
    [id],
  );
  return {
    ...s.rows[0],
    address: s.rows[0].addressSnapshot ?? address,
    lines: lines.rows.map((l) => ({ ...l, qty: fromMicro(toMicro(l.qty)), packed: fromMicro(toMicro(l.packed)), complete: toMicro(l.packed) >= toMicro(l.qty) })),
    packages: pk.rows.map((p) => ({ ...p, items: p.items.map((i: { qty: string | number }) => ({ ...i, qty: fromMicro(toMicro(String(i.qty))) })) })),
    pickList: pick.rows,
  };
}

async function lockShipment(db: Db, id: string) {
  const r = await db.query(`select * from shipments where id = $1 for update`, [id]);
  if (!r.rows[0]) throw notFound("Sevkiyat");
  return r.rows[0];
}

/**
 * Paketleme ve sevkiyat (prompt §17). Kalitece serbest bırakılmış ve satıra ayrılmış stok, seri/lot okutularak pakete girer;
 * paket kontrol listesi tamamlanmadan kapanmaz; bütün paketler kapanmadan sevk edilmez. Resmî belge sağlayıcısı bağlı
 * olmadığından irsaliye TASLAK'tır; kargo firmasına istek gönderilmez, takip numarası elle girilir.
 */
export async function packagingRoutes(app: FastifyInstance) {
  // ---- Teslim adresleri -----------------------------------------------------------------
  app.get("/api/customers/:id/addresses", async (req) => {
    const { id } = req.params as { id: string };
    needAny(req, "sales.view", "shipment.view");
    return tenant(req, null, async (db) => (await db.query(`select ${addressCols} from customer_addresses where customer_id = $1 order by active desc, is_default desc, label`, [id])).rows);
  });

  app.post("/api/customers/:id/addresses", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(AddressInput, req.body);
    return tenant(req, "customer.address.manage", async (db, actor) => {
      const c = await db.query(`select id from customers where id = $1 for update`, [id]);
      if (!c.rows[0]) throw notFound("Müşteri");
      const first = (await db.query(`select count(*)::int as n from customer_addresses where customer_id = $1 and active`, [id])).rows[0].n === 0;
      if (input.isDefault || first) await db.query(`update customer_addresses set is_default = false where customer_id = $1`, [id]);
      const r = await db.query(
        `insert into customer_addresses (company_id, customer_id, label, recipient, phone, line1, line2, district, city, postal_code, country, is_default)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${addressCols}`,
        [id, input.label, input.recipient, input.phone ?? null, input.line1, input.line2 ?? null, input.district ?? null, input.city, input.postalCode ?? null, input.country, input.isDefault || first],
      );
      await recordEvent(db, actor, { entityType: "customer", entityId: id, eventType: "address.added", after: r.rows[0] });
      return r.rows[0];
    });
  });

  /** Adres düzenlenmez: yanlışsa pasife alınır ve yenisi eklenir. Geçmiş sevkiyat kopyası etkilenmez. */
  app.post("/api/addresses/:id/:action", async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    if (!["deactivate", "make-default"].includes(action)) throw notFound("Eylem");
    return tenant(req, "customer.address.manage", async (db, actor) => {
      const a = await db.query(`select * from customer_addresses where id = $1 for update`, [id]);
      if (!a.rows[0]) throw notFound("Adres");
      if (action === "deactivate") {
        const open = await db.query(`select code from shipments where address_id = $1 and status = any($2)`, [id, OPEN]);
        if (open.rows[0]) throw conflict("address_in_use", `Açık sevkiyat ${open.rows[0].code} bu adresi kullanıyor`);
        await db.query(`update customer_addresses set active = false, is_default = false where id = $1`, [id]);
      } else {
        if (!a.rows[0].active) throw conflict("address_inactive", "Pasif adres varsayılan yapılamaz");
        await db.query(`update customer_addresses set is_default = false where customer_id = $1`, [a.rows[0].customer_id]);
        await db.query(`update customer_addresses set is_default = true where id = $1`, [id]);
      }
      await recordEvent(db, actor, { entityType: "customer", entityId: a.rows[0].customer_id, eventType: `address.${action}`, after: { addressId: id, label: a.rows[0].label } });
      return { id, action };
    });
  });

  /** Siparişin teslim adresi ve kısmi teslim izni. */
  app.post("/api/sales-orders/:id/delivery", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ addressId: z.string().uuid().nullable().optional(), allowPartial: z.boolean().optional() }), req.body);
    return tenant(req, "sales.create", async (db, actor) => {
      const o = await db.query(`select id, customer_id, status, delivery_address_id, allow_partial from sales_orders where id = $1 for update`, [id]);
      const so = o.rows[0];
      if (!so) throw notFound("Satış siparişi");
      if (["shipped", "cancelled"].includes(so.status)) throw conflict("invalid_transition", `Sipariş "${so.status}" durumunda`);
      if (input.addressId) {
        const a = await db.query(`select customer_id, active from customer_addresses where id = $1`, [input.addressId]);
        if (!a.rows[0] || a.rows[0].customer_id !== so.customer_id) throw conflict("wrong_address", "Adres bu müşteriye ait değil");
        if (!a.rows[0].active) throw conflict("address_inactive", "Pasif adres seçilemez");
      }
      await db.query(`update sales_orders set delivery_address_id = coalesce($2, delivery_address_id), allow_partial = coalesce($3, allow_partial) where id = $1`, [
        id, input.addressId ?? null, input.allowPartial ?? null,
      ]);
      await recordEvent(db, actor, { entityType: "sales_order", entityId: id, eventType: "delivery.updated", before: { addressId: so.delivery_address_id, allowPartial: so.allow_partial }, after: input });
      return { id, ...input };
    });
  });

  app.get("/api/sales-orders/:id/shippable", async (req) => {
    const { id } = req.params as { id: string };
    needAny(req, "sales.view", "shipment.view");
    return tenant(req, null, async (db) => {
      const o = await db.query(`select status, allow_partial as "allowPartial", delivery_address_id as "deliveryAddressId", customer_id as "customerId" from sales_orders where id = $1`, [id]);
      if (!o.rows[0]) throw notFound("Satış siparişi");
      return { ...o.rows[0], lines: await shippableLines(db, id) };
    });
  });

  // ---- Sevkiyat -----------------------------------------------------------------------
  app.get("/api/sales-orders/:id/shipments", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "shipment.view", async (db) => {
      const r = await db.query(
        `select s.id, s.code, s.status, s.document_mode as "documentMode", s.tracking_no as "trackingNo", s.carrier, s.shipped_at as "shippedAt",
                s.created_at as "createdAt", u.name as "shippedBy",
                (select coalesce(sum(qty), 0) from shipment_lines where shipment_id = s.id) as qty
           from shipments s left join users u on u.id = s.shipped_by where s.sales_order_id = $1 order by s.created_at`,
        [id],
      );
      return r.rows;
    });
  });

  app.get("/api/shipments", async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    return tenant(req, "shipment.view", async (db) => {
      const r = await db.query(
        `select s.id, s.code, s.status, s.tracking_no as "trackingNo", s.carrier, s.created_at as "createdAt", s.shipped_at as "shippedAt",
                so.code as "salesOrderCode", c.name as "customerName",
                (select coalesce(sum(qty), 0) from shipment_lines where shipment_id = s.id) as qty,
                (select count(*)::int from packages where shipment_id = s.id) as packages
           from shipments s join sales_orders so on so.id = s.sales_order_id join customers c on c.id = so.customer_id
          where ($1::text is null or s.status = $1)
          order by (s.status in ('preparing', 'packed')) desc, s.created_at desc limit 200`,
        [q.status ?? null],
      );
      return r.rows;
    });
  });

  app.get("/api/shipments/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "shipment.view", (db) => loadShipment(db, id));
  });

  /**
   * Sevkiyat hazırlığı: yalnızca satıra ayrılmış, son kaliteden geçmiş stok kadar (T10). Kısmi teslim kapalıysa
   * kalan miktarın tamamı tek sevkiyatta olmalı. Adres müşteriye ait ve aktif olmalı. Tekrar gelen istek aynı sevkiyatı döner.
   */
  app.post("/api/sales-orders/:id/shipments", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({ addressId: z.string().uuid().optional(), lines: z.array(z.object({ lineId: z.string().uuid(), qty: z.string().regex(/^\d+(\.\d+)?$/) })).min(1) }),
      req.body,
    );
    return tenant(req, "shipment.create", (db, actor) =>
      idempotent(db, actor.companyId, "shipment_create", idempotencyKey(req), async () => {
        const o = await db.query(`select * from sales_orders where id = $1 for update`, [id]);
        const so = o.rows[0];
        if (!so) throw notFound("Satış siparişi");
        if (so.status !== "firm") throw conflict("invalid_transition", "Yalnızca kesinleşmiş sipariş sevk edilir");
        const addressId = input.addressId ?? so.delivery_address_id ?? (await db.query(`select id from customer_addresses where customer_id = $1 and is_default and active`, [so.customer_id])).rows[0]?.id;
        if (!addressId) throw conflict("address_required", "Teslim adresi seçilmeli; müşterinin kayıtlı adresi yok");
        const a = await db.query(`select customer_id, active from customer_addresses where id = $1`, [addressId]);
        if (!a.rows[0] || a.rows[0].customer_id !== so.customer_id) throw conflict("wrong_address", "Adres bu müşteriye ait değil");
        if (!a.rows[0].active) throw conflict("address_inactive", "Pasif adrese sevkiyat hazırlanamaz");

        const state = await shippableLines(db, id);
        const byId = new Map(state.map((l) => [l.lineId as string, l]));
        const seen = new Set<string>();
        for (const l of input.lines) {
          const s = byId.get(l.lineId);
          if (!s) throw notFound("Sipariş satırı");
          if (seen.has(l.lineId)) throw conflict("duplicate", "Aynı satır iki kez yazılamaz");
          seen.add(l.lineId);
          if (toMicro(l.qty) <= 0n) throw conflict("invalid_qty", "Miktar sıfırdan büyük olmalı");
          if (toMicro(l.qty) > toMicro(s.shippableNow)) {
            throw conflict("not_releasable", `${s.productCode} Rev.${s.rev}: satıra ayrılmış, son kaliteden geçmiş ve başka sevkiyatta olmayan miktar ${s.shippableNow}; ${l.qty} sevk edilemez`, { line: s });
          }
        }
        if (!so.allow_partial) {
          const partial = state.filter((s) => toMicro(s.remaining) > 0n && (!seen.has(s.lineId) || toMicro(input.lines.find((x) => x.lineId === s.lineId)!.qty) !== toMicro(s.remaining)));
          if (partial.length) throw conflict("partial_not_allowed", "Bu siparişte kısmi teslim kapalı; kalan miktarın tamamı birlikte sevk edilmeli", { lines: partial.map((p) => ({ product: `${p.productCode} Rev.${p.rev}`, remaining: p.remaining, ready: p.ready })) });
        }
        const code = await nextCode(db, actor.companyId, "shipment", "SVK");
        const sh = await db.query(
          `insert into shipments (company_id, code, sales_order_id, status, address_id, created_by, document_mode) values (app_company_id(), $1, $2, 'preparing', $3, $4, 'draft') returning id`,
          [code, id, addressId, actor.userId],
        );
        for (const l of input.lines) {
          await db.query(`insert into shipment_lines (company_id, shipment_id, sales_order_line_id, qty) values (app_company_id(), $1, $2, $3)`, [sh.rows[0].id, l.lineId, l.qty]);
        }
        await db.query(`insert into packages (company_id, shipment_id, seq, code) values (app_company_id(), $1, 1, $2)`, [sh.rows[0].id, `${code}-P01`]);
        await recordEvent(db, actor, { entityType: "shipment", entityId: sh.rows[0].id, eventType: "created", after: { code, salesOrder: so.code, addressId, lines: input.lines } });
        await recordEvent(db, actor, { entityType: "sales_order", entityId: id, eventType: "shipment.created", after: { shipment: code } });
        return loadShipment(db, sh.rows[0].id);
      }),
    );
  });

  app.post("/api/shipments/:id/packages", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "shipment.create", async (db, actor) => {
      const s = await lockShipment(db, id);
      if (s.status !== "preparing") throw conflict("invalid_transition", "Paket yalnızca hazırlanan sevkiyata eklenir");
      const n = (await db.query(`select coalesce(max(seq), 0) + 1 as n from packages where shipment_id = $1`, [id])).rows[0].n;
      await db.query(`insert into packages (company_id, shipment_id, seq, code) values (app_company_id(), $1, $2, $3)`, [id, n, `${s.code}-P${String(n).padStart(2, "0")}`]);
      await recordEvent(db, actor, { entityType: "shipment", entityId: id, eventType: "package.added", after: { seq: n } });
      return loadShipment(db, id);
    });
  });

  /**
   * Okutma: önce seri, bulunamazsa lot numarası aranır. Serili üründe lot okutulamaz (her cihaz tek tek okutulur).
   * Yanlış ürün, serbest bırakılmamış cihaz, başka siparişe ayrılmış lot ve fazla paketleme reddedilir ve olay kaydı kalır.
   */
  app.post("/api/packages/:id/items", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ code: z.string().min(1).max(120), qty: z.string().regex(/^\d+(\.\d+)?$/).optional() }), req.body);
    return withRejectionLog(req, () =>
      tenant(req, "shipment.create", async (db, actor) => {
        const pk = await db.query(`select pk.*, s.status as shipment_status, s.code as shipment_code from packages pk join shipments s on s.id = pk.shipment_id where pk.id = $1 for update of pk`, [id]);
        const p = pk.rows[0];
        if (!p) throw notFound("Paket");
        await lockShipment(db, p.shipment_id);
        if (p.shipment_status !== "preparing") throw conflict("invalid_transition", "Sevkiyat paketleme aşamasında değil");
        if (p.closed_at) throw conflict("package_closed", "Paket kapatıldı; yeni paket açın");
        const reject = (code: string, message: string, details?: Record<string, unknown>) =>
          new RuleRejection(new AppError(409, code, message, details), { entityType: "shipment", entityId: p.shipment_id, eventType: `pack.rejected.${code}`, after: { scanned: input.code, package: p.code, ...details } });

        const lines = await db.query(
          `select sl.id, sl.qty, sl.sales_order_line_id, l.product_revision_id,
                  coalesce((select sum(pi.qty) from package_items pi where pi.shipment_line_id = sl.id), 0) as packed
             from shipment_lines sl join sales_order_lines l on l.id = sl.sales_order_line_id where sl.shipment_id = $1`,
          [p.shipment_id],
        );

        const dev = (await db.query(`select id, serial, status, product_revision_id, finished_lot_id from devices where serial = $1 for update`, [input.code])).rows[0];
        let lotId: string;
        let deviceId: string | null = null;
        let qty: bigint;
        let revisionId: string;
        if (dev) {
          const pi = await db.query(`select 1 from package_items where device_id = $1`, [dev.id]);
          if (pi.rowCount) throw reject("already_packed", `${dev.serial} zaten bir pakette`);
          if (dev.status !== "released") {
            throw reject("not_released", `${dev.serial} son kaliteden serbest bırakılmamış (durum: ${dev.status}); sevk edilemez`, { serial: dev.serial, status: dev.status });
          }
          lotId = dev.finished_lot_id;
          deviceId = dev.id;
          qty = toMicro("1");
          revisionId = dev.product_revision_id;
        } else {
          const lot = (await db.query(`select id, product_revision_id from lots where lot_no = $1 and product_revision_id is not null`, [input.code])).rows[0];
          if (!lot) throw reject("unknown_code", `"${input.code}" seri veya bitmiş ürün lotu olarak bulunamadı`);
          const serialized = await db.query(`select 1 from devices where finished_lot_id = $1 limit 1`, [lot.id]);
          if (serialized.rowCount) throw reject("serial_required", "Bu lot seri numaralı; cihazları tek tek okutun");
          if (!input.qty) throw conflict("qty_required", "Lot okutmada miktar girilmeli");
          lotId = lot.id;
          qty = toMicro(input.qty);
          revisionId = lot.product_revision_id;
        }

        const sameProduct = lines.rows.filter((l) => l.product_revision_id === revisionId);
        if (!sameProduct.length) throw reject("wrong_product", "Okutulan ürün veya revizyon bu sevkiyatta yok");
        // Lotun bu sipariş satırına ayrılmış olması şart; başka müşterinin malı pakete giremez.
        let target: (typeof lines.rows)[number] | undefined;
        let reservedFree = 0n;
        for (const l of sameProduct) {
          const r = await db.query(
            `select coalesce(sum(qty), 0) as q from reservations where demand_type = 'sales_order_line' and demand_id = $1 and lot_id = $2 and status = 'active'`,
            [l.sales_order_line_id, lotId],
          );
          const used = await db.query(
            `select coalesce(sum(pi.qty), 0) as q from package_items pi join shipment_lines sl on sl.id = pi.shipment_line_id join shipments s on s.id = sl.shipment_id
              where sl.sales_order_line_id = $1 and pi.lot_id = $2 and s.status = any($3)`,
            [l.sales_order_line_id, lotId, OPEN],
          );
          const free = toMicro(r.rows[0].q) - toMicro(used.rows[0].q);
          if (free > 0n && toMicro(l.packed) < toMicro(l.qty)) {
            target = l;
            reservedFree = free;
            break;
          }
        }
        if (!target) {
          const anyRes = sameProduct.length
            ? await db.query(`select 1 from reservations where lot_id = $1 and status = 'active' and demand_type = 'sales_order_line' and demand_id = any($2)`, [lotId, sameProduct.map((l) => l.sales_order_line_id)])
            : { rowCount: 0 };
          if (!anyRes.rowCount) throw reject("not_reserved_for_order", "Bu ürün/lot bu siparişe ayrılmamış; başka siparişin malı olabilir");
          throw reject("line_full", "Bu ürün için sevkiyat miktarı doldu");
        }
        const left = toMicro(target.qty) - toMicro(target.packed);
        if (qty > left) throw reject("over_pack", `Bu satırda paketlenecek kalan miktar ${fromMicro(left)}`);
        if (qty > reservedFree) throw reject("over_pack", `Lottan bu satıra ayrılmış kalan miktar ${fromMicro(reservedFree)}`);
        await db.query(
          `insert into package_items (company_id, package_id, shipment_line_id, lot_id, device_id, qty) values (app_company_id(), $1, $2, $3, $4, $5)`,
          [id, target.id, lotId, deviceId, fromMicro(qty)],
        );
        await recordEvent(db, actor, { entityType: "shipment", entityId: p.shipment_id, eventType: "packed.item", after: { package: p.code, code: input.code, qty: fromMicro(qty) } });
        return loadShipment(db, p.shipment_id);
      }),
    );
  });

  app.post("/api/package-items/:id/remove", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "shipment.create", async (db, actor) => {
      const r = await db.query(
        `select pi.id, pk.id as package_id, pk.closed_at, s.id as shipment_id, s.status, d.serial, lo.lot_no
           from package_items pi join packages pk on pk.id = pi.package_id join shipments s on s.id = pk.shipment_id
           left join devices d on d.id = pi.device_id join lots lo on lo.id = pi.lot_id where pi.id = $1 for update of pk`,
        [id],
      );
      const it = r.rows[0];
      if (!it) throw notFound("Paket kalemi");
      if (it.status !== "preparing" || it.closed_at) throw conflict("package_closed", "Kapanmış paketten veya hazırlık dışındaki sevkiyattan kalem çıkarılamaz");
      await db.query(`delete from package_items where id = $1`, [id]);
      await recordEvent(db, actor, { entityType: "shipment", entityId: it.shipment_id, eventType: "unpacked.item", after: { serial: it.serial, lotNo: it.lot_no } });
      return loadShipment(db, it.shipment_id);
    });
  });

  /** Paket kontrolü: kutu, aksesuar, etiket ve son kontrol işaretlenmeden paket kapanmaz. */
  app.post("/api/packages/:id/close", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({ checklist: z.object({ box: z.boolean(), accessories: z.boolean(), label: z.boolean(), inspection: z.boolean() }), weightKg: z.number().positive().max(10000).optional() }),
      req.body,
    );
    return tenant(req, "shipment.create", async (db, actor) => {
      const pk = await db.query(`select pk.*, s.status from packages pk join shipments s on s.id = pk.shipment_id where pk.id = $1 for update of pk`, [id]);
      const p = pk.rows[0];
      if (!p) throw notFound("Paket");
      if (p.status !== "preparing" || p.closed_at) throw conflict("invalid_transition", "Paket zaten kapalı veya sevkiyat hazırlıkta değil");
      const items = (await db.query(`select count(*)::int as n from package_items where package_id = $1`, [id])).rows[0].n;
      if (!items) throw conflict("package_empty", "Boş paket kapatılamaz");
      const missing = CHECKLIST.filter((k) => !input.checklist[k]);
      if (missing.length) throw conflict("checklist_incomplete", "Paket kontrol listesi tamamlanmadı", { missing });
      await db.query(`update packages set checklist = $2, weight_kg = $3, closed_at = now(), closed_by = $4 where id = $1`, [id, JSON.stringify(input.checklist), input.weightKg ?? null, actor.userId]);
      await recordEvent(db, actor, { entityType: "shipment", entityId: p.shipment_id, eventType: "package.closed", after: { package: p.code, items, weightKg: input.weightKg } });
      return loadShipment(db, p.shipment_id);
    });
  });

  app.post("/api/shipments/:id/pack-complete", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "shipment.create", async (db, actor) => {
      const s = await lockShipment(db, id);
      if (s.status !== "preparing") throw conflict("invalid_transition", "Sevkiyat hazırlıkta değil");
      const sh = await loadShipment(db, id);
      const open = sh.packages.filter((p: { closedAt: string | null; items: unknown[] }) => !p.closedAt && p.items.length);
      if (open.length) throw conflict("packages_open", `${open.length} paket kapatılmadı`);
      const short = sh.lines.filter((l: { complete: boolean }) => !l.complete);
      if (short.length) throw conflict("not_fully_packed", "Sevkiyattaki bütün miktar paketlenmedi", { lines: short.map((l: { productCode: string; qty: string; packed: string }) => ({ product: l.productCode, qty: l.qty, packed: l.packed })) });
      await db.query(`delete from packages where shipment_id = $1 and closed_at is null and not exists (select 1 from package_items where package_id = packages.id)`, [id]);
      await db.query(`update shipments set status = 'packed' where id = $1`, [id]);
      await recordEvent(db, actor, { entityType: "shipment", entityId: id, eventType: "status.packed", before: { status: "preparing" }, after: { status: "packed" } });
      return loadShipment(db, id);
    });
  });

  /**
   * Sevk: paketlenen seri/lotlar bitmiş ürün deposundan düşülür, satır rezervasyonu tüketilir, seriler "sevk edildi" olur.
   * Adres o anki haliyle belgeye kopyalanır. Aynı istek tekrar gelirse ikinci hareket/belge oluşmaz.
   */
  app.post("/api/shipments/:id/ship", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ carrier: z.string().min(2).max(80).optional(), trackingNo: z.string().max(80).optional() }), req.body);
    return tenant(req, "shipment.create", (db, actor) =>
      idempotent(db, actor.companyId, "shipment_ship", idempotencyKey(req), async () => {
        const s = await lockShipment(db, id);
        if (SHIPPED.includes(s.status)) return loadShipment(db, id); // tekrar gelen sevk isteği
        if (s.status !== "packed") throw conflict("invalid_transition", "Paketleme tamamlanmadan sevk edilemez");
        // Kargo etiketi (W36 test bağlayıcısı) önceden üretildiyse taşıyıcı/takip no oradan gelir; yoksa elle girilir.
        const carrier = input.carrier ?? s.carrier;
        if (!carrier) throw badRequest("Taşıyıcı gerekli (elle girin veya önce kargo etiketi üretin)");
        const trackingNo = input.trackingNo ?? s.tracking_no ?? undefined;
        const a = await db.query(`select ${addressCols} from customer_addresses where id = $1`, [s.address_id]);
        if (!a.rows[0]?.active) throw conflict("address_inactive", "Teslim adresi pasife alınmış; sevkiyat adresini güncelleyin");
        const items = await db.query(
          `select pi.id, pi.lot_id, pi.device_id, pi.qty, sl.sales_order_line_id, lo.item_id
             from package_items pi join packages pk on pk.id = pi.package_id join shipment_lines sl on sl.id = pi.shipment_line_id join lots lo on lo.id = pi.lot_id
            where pk.shipment_id = $1 order by pi.created_at`,
          [id],
        );
        // Lot × satır bazında topla; aynı lot birden fazla konumdaysa bitmiş ürün deposundan başlanır.
        const groups = new Map<string, { lotId: string; itemId: string; lineId: string; qty: bigint }>();
        for (const it of items.rows) {
          const k = `${it.lot_id}|${it.sales_order_line_id}`;
          const g = groups.get(k) ?? { lotId: it.lot_id, itemId: it.item_id, lineId: it.sales_order_line_id, qty: 0n };
          g.qty += toMicro(it.qty);
          groups.set(k, g);
        }
        for (const g of groups.values()) {
          const res = await db.query(
            `select id, qty from reservations where demand_type = 'sales_order_line' and demand_id = $1 and lot_id = $2 and status = 'active' order by created_at for update`,
            [g.lineId, g.lotId],
          );
          let rest = g.qty;
          for (const r of res.rows) {
            if (rest <= 0n) break;
            const take = min(rest, toMicro(r.qty));
            const left = toMicro(r.qty) - take;
            if (left === 0n) await db.query(`update reservations set status = 'consumed' where id = $1`, [r.id]);
            else await db.query(`update reservations set qty = $2 where id = $1`, [r.id, fromMicro(left)]);
            rest -= take;
          }
          if (rest > 0n) throw conflict("reservation_changed", "Paketlenen mal için satır rezervasyonu artık yeterli değil; sevkiyatı kontrol edin");
          const locs = await db.query(
            `select b.location_id, b.qty from stock_balances b join locations loc on loc.id = b.location_id
              where b.lot_id = $1 and loc.type in ('finished', 'stock') and b.qty > 0 order by (loc.type = 'finished') desc, b.qty desc`,
            [g.lotId],
          );
          let need = g.qty;
          for (const l of locs.rows) {
            if (need <= 0n) break;
            const take = min(need, toMicro(l.qty));
            await db.query(
              `insert into stock_moves (company_id, item_id, lot_id, from_location_id, qty, move_type, ref_type, ref_id, created_by)
               values (app_company_id(), $1, $2, $3, $4, 'ship', 'shipment', $5, $6)`,
              [g.itemId, g.lotId, l.location_id, fromMicro(take), id, actor.userId],
            );
            need -= take;
          }
          if (need > 0n) throw conflict("stock_missing", "Paketlenen lot depoda yeterli değil; sayım farkı olabilir");
        }
        await db.query(`update devices set status = 'shipped' where id in (select pi.device_id from package_items pi join packages pk on pk.id = pi.package_id where pk.shipment_id = $1 and pi.device_id is not null)`, [id]);
        await db.query(
          `update shipments set status = 'shipped', carrier = $2, tracking_no = $3, address_snapshot = $4, shipped_by = $5, shipped_at = now(),
                  qty = (select sum(qty) from shipment_lines where shipment_id = $1) where id = $1`,
          [id, carrier, trackingNo ?? null, JSON.stringify(a.rows[0]), actor.userId],
        );
        // Bütün satırlar tamamen sevk edildiyse sipariş "sevk edildi" olur.
        const state = await shippableLines(db, s.sales_order_id);
        const done = state.every((l) => toMicro(l.shipped) >= toMicro(l.ordered));
        if (done) {
          await db.query(`update sales_orders set status = 'shipped' where id = $1`, [s.sales_order_id]);
          await recordEvent(db, actor, { entityType: "sales_order", entityId: s.sales_order_id, eventType: "status.shipped", before: { status: "firm" }, after: { status: "shipped" } });
        }
        await recordEvent(db, actor, { entityType: "shipment", entityId: id, eventType: "status.shipped", before: { status: "packed" }, after: { status: "shipped", carrier, trackingNo, document: s.document_mode } });
        await recordEvent(db, actor, { entityType: "sales_order", entityId: s.sales_order_id, eventType: "shipped", after: { shipment: s.code, partial: !done } });
        await enqueue(db, actor.companyId, "shipment.shipped", { shipmentId: id });
        return loadShipment(db, id);
      }),
    );
  });

  app.post("/api/shipments/:id/tracking", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ trackingNo: z.string().min(3).max(80), carrier: z.string().min(2).max(80).optional() }), req.body);
    return tenant(req, "shipment.create", async (db, actor) => {
      const s = await lockShipment(db, id);
      if (!SHIPPED.includes(s.status)) throw conflict("invalid_transition", "Takip numarası sevk edilen sevkiyata girilir");
      await db.query(`update shipments set tracking_no = $2, carrier = coalesce($3, carrier) where id = $1`, [id, input.trackingNo, input.carrier ?? null]);
      await recordEvent(db, actor, { entityType: "shipment", entityId: id, eventType: "tracking.set", before: { trackingNo: s.tracking_no }, after: input });
      return loadShipment(db, id);
    });
  });

  /** Teslim teyidi veya teslim sorunu (hasar, teslim edilemedi, yanlış adres). Sorunlu sevkiyat sonradan teslim edildi yapılabilir. */
  app.post("/api/shipments/:id/delivery", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.discriminatedUnion("outcome", [
        z.object({ outcome: z.literal("delivered"), note: z.string().max(500).optional() }),
        z.object({ outcome: z.literal("problem"), kind: z.enum(["damage", "not_delivered", "wrong_address", "other"]), note: z.string().min(3).max(1000) }),
      ]),
      req.body,
    );
    return tenant(req, "shipment.deliver", async (db, actor) => {
      const s = await lockShipment(db, id);
      if (!["shipped", "problem"].includes(s.status)) throw conflict("invalid_transition", `Sevkiyat "${s.status}" durumunda`);
      if (input.outcome === "delivered") {
        await db.query(`update shipments set status = 'delivered', delivered_at = now() where id = $1`, [id]);
      } else {
        await db.query(`update shipments set status = 'problem', problem_note = $2 where id = $1`, [id, `${input.kind}: ${input.note}`]);
      }
      await recordEvent(db, actor, {
        entityType: "shipment", entityId: id, eventType: `status.${input.outcome}`, before: { status: s.status }, after: { status: input.outcome, ...(input.outcome === "problem" ? { kind: input.kind } : {}) }, reason: input.note,
      });
      return loadShipment(db, id);
    });
  });

  /** Hazırlık/paketli sevkiyat iptali: stok hareketi yoktur; paket kayıtları bırakılır, seriler yeniden paketlenebilir. */
  app.post("/api/shipments/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "shipment.create", async (db, actor) => {
      const s = await lockShipment(db, id);
      if (!OPEN.includes(s.status)) throw conflict("invalid_transition", "Sevk edilmiş sevkiyat iptal edilemez; iade süreci ayrıdır");
      const released = await db.query(
        `delete from package_items pi using packages pk, devices d where pk.id = pi.package_id and pk.shipment_id = $1 and d.id = pi.device_id returning d.serial`,
        [id],
      );
      await db.query(`delete from package_items pi using packages pk where pk.id = pi.package_id and pk.shipment_id = $1`, [id]);
      await db.query(`update shipments set status = 'cancelled', cancel_reason = $2 where id = $1`, [id, input.reason]);
      await recordEvent(db, actor, { entityType: "shipment", entityId: id, eventType: "status.cancelled", before: { status: s.status }, after: { status: "cancelled", releasedSerials: released.rows.map((r) => r.serial) }, reason: input.reason });
      return loadShipment(db, id);
    });
  });
}
