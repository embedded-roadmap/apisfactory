import { approverFromRequest, evaluateApproval } from "../lib/workflow";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { conflict, notFound } from "../lib/errors";
import { closeTasks, idempotent, nextCode, openTask, recordEvent, type Actor } from "../lib/records";
import { fromMicro, toMicro } from "../lib/decimal";
import { idempotencyKey, parse, tenant } from "../http/context";

const SHIPPED = ["shipped", "delivered", "problem"];
const CAUSES = ["manufacturing", "component", "design", "firmware", "customer_damage", "no_fault_found", "unknown"] as const;
const addressCols = `id, label, recipient, phone, line1, line2, district, city, postal_code as "postalCode", country`;

async function locationOf(db: Db, type: string) {
  const r = await db.query(`select id from locations where type = $1 order by code limit 1`, [type]);
  if (!r.rows[0]) throw conflict("location_missing", `"${type}" tipinde konum tanımlı değil`);
  return r.rows[0].id as string;
}

/**
 * Seri veya lot numarasından iade kaynağı: hangi müşteriye, hangi sevkiyatla, ne zaman gitti, garanti durumu.
 * Serisiz lotta müşteri bilgisi gerekir; iade edilebilir miktar o müşteriye sevk edilen − önceki iadeler.
 */
async function resolveSource(db: Db, code: string, customerId?: string) {
  const dev = (await db.query(
    `select d.id, d.serial, d.status, d.finished_lot_id, lo.item_id, d.product_revision_id, p.warranty_months, p.code as product_code, pr.rev
       from devices d join lots lo on lo.id = d.finished_lot_id join product_revisions pr on pr.id = d.product_revision_id join products p on p.id = pr.product_id
      where d.serial = $1`,
    [code],
  )).rows[0];
  if (dev) {
    const sh = (await db.query(
      `select s.id as shipment_id, s.code as shipment_code, s.shipped_at, so.id as sales_order_id, so.code as sales_order_code, so.customer_id, c.name as customer_name
         from package_items pi join packages pk on pk.id = pi.package_id join shipments s on s.id = pk.shipment_id
         join sales_orders so on so.id = s.sales_order_id join customers c on c.id = so.customer_id
        where pi.device_id = $1 and s.status = any($2) order by s.shipped_at desc limit 1`,
      [dev.id, SHIPPED],
    )).rows[0];
    return {
      kind: "serial" as const, deviceId: dev.id as string, serial: dev.serial as string, deviceStatus: dev.status as string,
      lotId: dev.finished_lot_id as string, itemId: dev.item_id as string, productCode: dev.product_code as string, rev: dev.rev as string,
      warrantyMonths: dev.warranty_months as number, returnableQty: dev.status === "shipped" ? "1" : "0",
      shipmentId: sh?.shipment_id ?? null, shipmentCode: sh?.shipment_code ?? null, shippedAt: sh?.shipped_at ?? null,
      salesOrderId: sh?.sales_order_id ?? null, salesOrderCode: sh?.sales_order_code ?? null,
      customerId: (sh?.customer_id ?? customerId ?? null) as string | null, customerName: sh?.customer_name ?? null,
    };
  }
  const lot = (await db.query(
    `select lo.id, lo.item_id, lo.lot_no, p.warranty_months, p.code as product_code, pr.rev
       from lots lo join product_revisions pr on pr.id = lo.product_revision_id join products p on p.id = pr.product_id where lo.lot_no = $1`,
    [code],
  )).rows[0];
  if (!lot) return null;
  const sh = customerId
    ? (await db.query(
        `select coalesce(sum(pi.qty), 0) as qty, max(s.shipped_at) as shipped_at,
                (array_agg(s.id order by s.shipped_at desc))[1] as shipment_id, (array_agg(s.code order by s.shipped_at desc))[1] as shipment_code,
                (array_agg(so.id order by s.shipped_at desc))[1] as sales_order_id, (array_agg(so.code order by s.shipped_at desc))[1] as sales_order_code
           from package_items pi join packages pk on pk.id = pi.package_id join shipments s on s.id = pk.shipment_id join sales_orders so on so.id = s.sales_order_id
          where pi.lot_id = $1 and pi.device_id is null and s.status = any($2) and so.customer_id = $3`,
        [lot.id, SHIPPED, customerId],
      )).rows[0]
    : null;
  const returned = customerId
    ? toMicro((await db.query(`select coalesce(sum(qty), 0) as q from rmas where lot_id = $1 and customer_id = $2 and device_id is null and status <> 'cancelled'`, [lot.id, customerId])).rows[0].q)
    : 0n;
  const shipped = sh ? toMicro(sh.qty) : 0n;
  return {
    kind: "lot" as const, deviceId: null, serial: null, deviceStatus: null, lotId: lot.id as string, itemId: lot.item_id as string,
    productCode: lot.product_code as string, rev: lot.rev as string, warrantyMonths: lot.warranty_months as number,
    returnableQty: fromMicro(shipped - returned > 0n ? shipped - returned : 0n), shippedQty: fromMicro(shipped),
    shipmentId: sh?.shipment_id ?? null, shipmentCode: sh?.shipment_code ?? null, shippedAt: sh?.shipped_at ?? null,
    salesOrderId: sh?.sales_order_id ?? null, salesOrderCode: sh?.sales_order_code ?? null, customerId: customerId ?? null, customerName: null,
  };
}

function warranty(shippedAt: string | Date | null, months: number) {
  if (!shippedAt) return { warrantyUntil: null, inWarranty: null };
  const d = new Date(shippedAt);
  d.setUTCMonth(d.getUTCMonth() + months);
  const until = d.toISOString().slice(0, 10);
  return { warrantyUntil: until, inWarranty: new Date().toISOString().slice(0, 10) <= until };
}

async function loadRma(db: Db, id: string) {
  const r = await db.query(
    `select r.id, r.code, r.kind, r.status, r.qty, r.complaint, r.shipped_at as "shippedAt", r.warranty_until::text as "warrantyUntil", r.in_warranty as "inWarranty",
            r.received_at as "receivedAt", r.finding, r.cause, r.inspected_at as "inspectedAt", r.disposition, r.disposition_note as "dispositionNote",
            r.credit_note_requested as "creditNoteRequested", r.decided_at as "decidedAt", r.repair_note as "repairNote", r.retest_passed as "retestPassed",
            r.outbound_carrier as "outboundCarrier", r.outbound_tracking as "outboundTracking", r.outbound_address as "outboundAddress",
            r.closed_at as "closedAt", r.cancel_reason as "cancelReason", r.created_at as "createdAt",
            c.id as "customerId", c.name as "customerName", d.serial, d.status as "deviceStatus", lo.lot_no as "lotNo",
            p.code as "productCode", pr.rev, s.code as "shipmentCode", so.code as "salesOrderCode", so.id as "salesOrderId",
            rd.serial as "replacementSerial", rl.lot_no as "replacementLotNo", cr.code as "changeRequestCode", cr.id as "changeRequestId",
            r.escalated_rma_id as "escalatedRmaId", er.code as "escalatedRmaCode",
            ou.name as "openedBy", iu.name as "inspectedBy", du.name as "decidedBy"
       from rmas r join customers c on c.id = r.customer_id join lots lo on lo.id = r.lot_id
       join items i on i.id = r.item_id join products p on p.item_id = i.id
       left join devices d on d.id = r.device_id left join product_revisions pr on pr.id = coalesce(d.product_revision_id, lo.product_revision_id)
       left join shipments s on s.id = r.shipment_id left join sales_orders so on so.id = r.sales_order_id
       left join devices rd on rd.id = r.replacement_device_id left join lots rl on rl.id = r.replacement_lot_id
       left join change_requests cr on cr.id = r.change_request_id
       left join rmas er on er.id = r.escalated_rma_id
       left join users ou on ou.id = r.opened_by left join users iu on iu.id = r.inspected_by left join users du on du.id = r.decided_by
      where r.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw notFound("İade");
  return { ...r.rows[0], qty: fromMicro(toMicro(r.rows[0].qty)) };
}

async function lockRma(db: Db, id: string) {
  const r = await db.query(`select * from rmas where id = $1 for update`, [id]);
  if (!r.rows[0]) throw notFound("İade");
  return r.rows[0];
}

async function setStatus(db: Db, actor: Actor, rma: { id: string; status: string }, to: string, extra: Record<string, unknown> = {}, reason?: string) {
  await db.query(`update rmas set status = $2 where id = $1`, [rma.id, to]);
  await recordEvent(db, actor, { entityType: "rma", entityId: rma.id, eventType: `status.${to}`, before: { status: rma.status }, after: { status: to, ...extra }, reason });
}

/**
 * Müşteri iadesi / garanti / saha arızası (prompt §17, §22). Akış: aç → teslim al (iade kabul alanı, kullanılamaz) →
 * incele (bulgu, kök neden) → karar (olduğu gibi iade, tamir, değişim, hurda, stoğa al) → geri sevk / kapanış.
 * İade malı otomatik sağlam stoğa girmez; "stoğa al" yalnızca arıza bulunamadı + tekrar test geçti ile mümkündür.
 * Alacak belgesi resmî değildir: muhasebeye görev düşer (fatura sistemi bağlı değil).
 */
export async function returnRoutes(app: FastifyInstance) {
  app.get("/api/rma-lookup", async (req) => {
    const q = z.object({ code: z.string().min(1).max(120), customerId: z.string().uuid().optional() }).parse(req.query);
    return tenant(req, "rma.create", async (db) => {
      const src = await resolveSource(db, q.code, q.customerId);
      if (!src) throw notFound("Seri veya bitmiş ürün lotu");
      return { ...src, ...warranty(src.shippedAt, src.warrantyMonths) };
    });
  });

  /** Ürün garanti süresi (ay). Açılmış iadelerin garanti kararı değişmez; açılışta saklanır. */
  app.post("/api/products/:id/warranty", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ months: z.number().int().min(0).max(240) }), req.body);
    return tenant(req, "product.create", async (db, actor) => {
      const p = await db.query(`select warranty_months from products where id = $1 for update`, [id]);
      if (!p.rows[0]) throw notFound("Ürün");
      await db.query(`update products set warranty_months = $2 where id = $1`, [id, input.months]);
      await recordEvent(db, actor, { entityType: "product", entityId: id, eventType: "warranty.set", before: { months: p.rows[0].warranty_months }, after: input });
      return { id, warrantyMonths: input.months };
    });
  });

  app.get("/api/rmas", async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    return tenant(req, "rma.view", async (db) => {
      const r = await db.query(
        `select r.id, r.code, r.kind, r.status, r.qty, r.in_warranty as "inWarranty", r.disposition, r.cause, r.created_at as "createdAt",
                c.name as "customerName", d.serial, lo.lot_no as "lotNo", p.code as "productCode"
           from rmas r join customers c on c.id = r.customer_id join lots lo on lo.id = r.lot_id join products p on p.item_id = r.item_id
           left join devices d on d.id = r.device_id
          where ($1::text is null or r.status = $1)
          order by (r.status in ('closed', 'cancelled')), r.created_at desc limit 200`,
        [q.status ?? null],
      );
      return r.rows.map((x) => ({ ...x, qty: fromMicro(toMicro(x.qty)) }));
    });
  });

  app.get("/api/rmas/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "rma.view", (db) => loadRma(db, id));
  });

  app.post("/api/rmas", async (req) => {
    const input = parse(
      z.object({
        code: z.string().min(1).max(120),
        customerId: z.string().uuid().optional(),
        qty: z.string().regex(/^\d+(\.\d+)?$/).optional(),
        kind: z.enum(["return", "warranty", "field_failure"]),
        complaint: z.string().min(5).max(4000),
      }),
      req.body,
    );
    return tenant(req, "rma.create", (db, actor) =>
      idempotent(db, actor.companyId, "rma_create", idempotencyKey(req), async () => {
        const src = await resolveSource(db, input.code, input.customerId);
        if (!src) throw notFound("Seri veya bitmiş ürün lotu");
        if (src.kind === "serial") {
          if (src.deviceStatus !== "shipped") throw conflict("not_shipped", `${src.serial} müşteride görünmüyor (durum: ${src.deviceStatus}); iade açılamaz`);
          const open = await db.query(`select code from rmas where device_id = $1 and status not in ('closed', 'cancelled')`, [src.deviceId]);
          if (open.rows[0]) throw conflict("rma_open", `${src.serial} için açık iade var: ${open.rows[0].code}`);
          if (input.customerId && src.customerId && input.customerId !== src.customerId) {
            throw conflict("wrong_customer", `${src.serial} başka bir müşteriye (${src.customerName}) sevk edilmiş`);
          }
          if (!src.customerId) throw conflict("customer_required", "Bu serinin sevkiyat kaydı bulunamadı; müşteri seçilmeli");
        } else {
          if (!input.customerId) throw conflict("customer_required", "Serisiz lot iadesinde müşteri seçilmeli");
          if (!input.qty) throw conflict("qty_required", "Lot iadesinde miktar girilmeli");
          if (toMicro(input.qty) > toMicro(src.returnableQty)) {
            throw conflict("over_return", `Bu müşteriye bu lottan sevk edilip iade edilmemiş miktar ${src.returnableQty}; ${input.qty} iade açılamaz`);
          }
        }
        const w = warranty(src.shippedAt, src.warrantyMonths);
        const code = await nextCode(db, actor.companyId, "rma", "IAD");
        const r = await db.query(
          `insert into rmas (company_id, code, customer_id, kind, device_id, lot_id, item_id, qty, shipment_id, sales_order_id, complaint, shipped_at, warranty_until, in_warranty, opened_by)
           values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
          [code, src.customerId, input.kind, src.deviceId, src.lotId, src.itemId, src.kind === "serial" ? "1" : input.qty, src.shipmentId, src.salesOrderId,
            input.complaint, src.shippedAt, w.warrantyUntil, w.inWarranty, actor.userId],
        );
        const id = r.rows[0].id as string;
        await recordEvent(db, actor, { entityType: "rma", entityId: id, eventType: "created", after: { code, source: input.code, kind: input.kind, ...w } });
        if (src.deviceId) await recordEvent(db, actor, { entityType: "device", entityId: src.deviceId, eventType: "rma.opened", after: { rma: code, kind: input.kind } });
        // Saha arızasında (field_failure) cihaz fiziksel olarak geri gelmez — depo teslim alma adımı
        // yok, doğrudan kaliteye inceleme görevi düşer (bkz. inspect/decide'daki kind ayrımı).
        if (input.kind === "field_failure") {
          await openTask(db, actor.companyId, { kind: "rma_inspect", title: `Saha arızası ${code} — ${src.serial ?? src.productCode} incele`, entityType: "rma", entityId: id, assigneeRole: "quality" });
        } else {
          await openTask(db, actor.companyId, { kind: "rma_receive", title: `İade ${code} — ${src.serial ?? src.productCode} teslim al`, entityType: "rma", entityId: id, assigneeRole: "warehouse" });
        }
        return loadRma(db, id);
      }),
    );
  });

  /** Teslim alma: iade kabul alanına (kullanılamaz) giriş. Satılabilir stok değişmez. */
  app.post("/api/rmas/:id/receive", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ note: z.string().max(1000).optional() }), req.body ?? {});
    return tenant(req, "inventory.receive", async (db, actor) => {
      const rma = await lockRma(db, id);
      if (rma.status !== "open") throw conflict("invalid_transition", `İade "${rma.status}" durumunda`);
      if (rma.kind === "field_failure") throw conflict("not_applicable", "Saha arızasında fiziksel teslim alma adımı yok — cihaz müşteride kalır; doğrudan inceleme yapılır");
      const loc = await locationOf(db, "returns");
      await db.query(
        `insert into stock_moves (company_id, item_id, lot_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
         values (app_company_id(), $1, $2, $3, $4, 'return', 'rma', $5, $6)`,
        [rma.item_id, rma.lot_id, loc, rma.qty, id, actor.userId],
      );
      if (rma.device_id) await db.query(`update devices set status = 'returned' where id = $1`, [rma.device_id]);
      await db.query(`update rmas set received_at = now(), received_by = $2 where id = $1`, [id, actor.userId]);
      await setStatus(db, actor, rma, "received", {}, input.note);
      await closeTasks(db, actor.companyId, "rma_receive", id);
      await openTask(db, actor.companyId, { kind: "rma_inspect", title: `İade ${rma.code} — incele ve karar ver`, entityType: "rma", entityId: id, assigneeRole: "quality" });
      return loadRma(db, id);
    });
  });

  /** İnceleme: bulgu ve kök neden. Tasarım/komponent/firmware kaynaklıysa Ar-Ge'ye değişiklik talebi açılabilir. */
  app.post("/api/rmas/:id/inspect", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({ finding: z.string().min(5).max(4000), cause: z.enum(CAUSES), openChangeRequest: z.boolean().default(false) }),
      req.body,
    );
    return tenant(req, "rma.decide", async (db, actor) => {
      const rma = await lockRma(db, id);
      const pol = await evaluateApproval(db, "rma_decision", approverFromRequest(req, "rma.decide"), { requesterId: rma.opened_by, amount: null, currency: null });
      if (!pol.allowed && pol.code === "self_approval") throw conflict("self_approval", "İadeyi açan kişi kararı veremez (onay politikası)");
      const fieldFailureFromOpen = rma.kind === "field_failure" && rma.status === "open";
      if (rma.status !== "received" && !fieldFailureFromOpen) {
        throw conflict("invalid_transition", "İnceleme yalnızca teslim alınmış iade veya (saha arızasında) doğrudan açık kayıt için yapılır");
      }
      let crId: string | null = null;
      if (input.openChangeRequest) {
        if (!["design", "component", "firmware", "manufacturing"].includes(input.cause)) {
          throw conflict("change_request_not_applicable", "Değişiklik talebi yalnızca tasarım, komponent, firmware veya üretim kaynaklı bulguda açılır");
        }
        const rev = (await db.query(`select coalesce(d.product_revision_id, lo.product_revision_id) as rev, d.serial from rmas r left join devices d on d.id = r.device_id join lots lo on lo.id = r.lot_id where r.id = $1`, [id])).rows[0];
        const code = await nextCode(db, actor.companyId, "change_request", "DT");
        const cr = await db.query(
          `insert into change_requests (company_id, code, product_revision_id, device_serial, title, description, urgency, opened_by)
           values (app_company_id(), $1, $2, $3, $4, $5, 'high', $6) returning id`,
          [code, rev.rev, rev.serial, `Saha iadesi ${rma.code}: ${input.cause}`, input.finding, actor.userId],
        );
        crId = cr.rows[0].id;
        await recordEvent(db, actor, { entityType: "change_request", entityId: crId!, eventType: "created", after: { code, source: rma.code } });
        await openTask(db, actor.companyId, { kind: "change_decision", title: `Değişiklik talebi ${code} — saha iadesi ${rma.code}`, entityType: "change_request", entityId: crId!, assigneeRole: "rd" });
      }
      await db.query(`update rmas set finding = $2, cause = $3, inspected_by = $4, inspected_at = now(), change_request_id = $5 where id = $1`, [id, input.finding, input.cause, actor.userId, crId]);
      await setStatus(db, actor, rma, "inspected", { cause: input.cause, changeRequestId: crId });
      if (rma.device_id) await recordEvent(db, actor, { entityType: "device", entityId: rma.device_id, eventType: "rma.inspected", after: { rma: rma.code, cause: input.cause, finding: input.finding } });
      return loadRma(db, id);
    });
  });

  app.post("/api/rmas/:id/decide", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        disposition: z.enum(["return_as_is", "repair", "replace", "scrap", "restock", "logged_no_action", "escalated_to_rma"]),
        note: z.string().min(3).max(2000),
        creditNote: z.boolean().default(false),
        replacementCode: z.string().max(120).optional(),
        retestPassed: z.boolean().optional(),
      }),
      req.body,
    );
    return tenant(req, "rma.decide", async (db, actor) => {
      const rma = await lockRma(db, id);
      const pol = await evaluateApproval(db, "rma_decision", approverFromRequest(req, "rma.decide"), { requesterId: rma.opened_by, amount: null, currency: null });
      if (!pol.allowed && pol.code === "self_approval") throw conflict("self_approval", "İadeyi açan kişi kararı veremez (onay politikası)");
      const redecide = rma.status === "decided" && rma.disposition === "repair" && rma.retest_passed === false;
      if (rma.status !== "inspected" && !redecide) throw conflict("invalid_transition", "Karar yalnızca incelenmiş iade için (veya tamiri başarısız iade için yeniden) verilir");
      // Saha arızasında (field_failure) cihaz müşteride kalır — fiziksel stok/cihaz hareketi üreten
      // 5 klasik sonuç (olduğu gibi iade/tamir/değişim/hurda/stoğa al) burada UYDURMA bir hareket
      // yaratır. Yalnızca "kayda geçti, işlem yok" veya "gerçek iadeye yükselt" seçilebilir; tersine,
      // fiziksel olarak elde bulunan return/warranty kayıtlarında bu iki yeni sonuç anlamsızdır.
      const FIELD_FAILURE_DISPOSITIONS = ["logged_no_action", "escalated_to_rma"];
      if (rma.kind === "field_failure" && !FIELD_FAILURE_DISPOSITIONS.includes(input.disposition)) {
        throw conflict("field_failure_disposition", "Saha arızasında yalnızca \"kayda geçti, işlem yok\" veya \"gerçek iadeye yükselt\" seçilebilir — cihaz fiziksel olarak elde yok");
      }
      if (rma.kind !== "field_failure" && FIELD_FAILURE_DISPOSITIONS.includes(input.disposition)) {
        throw conflict("field_failure_disposition", "Bu sonuç yalnızca saha arızası kayıtları içindir");
      }
      if (input.creditNote && rma.in_warranty === false) throw conflict("out_of_warranty", `Garanti ${rma.warranty_until} tarihinde bitti; alacak belgesi talebi açılamaz`);
      if (input.creditNote && rma.cause === "customer_damage") throw conflict("customer_damage", "Müşteri kaynaklı hasarda alacak belgesi talebi açılamaz");
      if (input.disposition === "restock") {
        if (rma.cause !== "no_fault_found") throw conflict("restock_not_allowed", "Stoğa alma yalnızca \"arıza bulunamadı\" bulgusunda mümkündür");
        if (input.retestPassed !== true) throw conflict("retest_required", "Stoğa almadan önce tekrar testin geçtiği teyit edilmeli");
      }
      if (["repair", "restock"].includes(input.disposition) && !rma.device_id) throw conflict("serial_required", "Tamir ve stoğa alma seri numaralı ürün içindir");

      let replacement: { deviceId: string | null; lotId: string } | null = null;
      if (input.disposition === "replace") {
        if (!input.replacementCode) throw conflict("replacement_required", "Değişim için gönderilecek seri veya lot okutulmalı");
        replacement = await pickReplacement(db, rma, input.replacementCode);
      }
      let escalatedRmaId: string | null = null;
      let escalatedRmaCode: string | null = null;
      let closed = false;
      if (input.disposition === "logged_no_action") {
        // Saha arızası uzaktan/yerinde çözüldü veya belgelendi — cihaz elde olmadığı için stok/cihaz
        // hareketi yok; yalnızca kayıt kapanır.
        closed = true;
      } else if (input.disposition === "escalated_to_rma") {
        // Müşteri cihazı fiziksel olarak göndermeye karar verdi — gerçek bir 'return' kaydı açılır,
        // orijinal saha arızası kaydı buna bağlanıp kapanır. Kayıp veri yok: müşteri/cihaz/lot/miktar/
        // sevkiyat/garanti bilgileri kopyalanır. Orijinali önce kapatılmış işaretlenir, yoksa aynı
        // cihaz için iki "açık" iade birden var olur ve rmas_one_open_per_device kısıtına takılır
        // (genel karar güncellemesi zaten aşağıda status'u tekrar 'closed' yazacak — sorun değil).
        await db.query(`update rmas set status = 'closed' where id = $1`, [id]);
        const newCode = await nextCode(db, actor.companyId, "rma", "IAD");
        const ins = await db.query(
          `insert into rmas (company_id, code, customer_id, kind, device_id, lot_id, item_id, qty, shipment_id, sales_order_id, complaint, shipped_at, warranty_until, in_warranty, opened_by)
           values (app_company_id(), $1, $2, 'return', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
          [newCode, rma.customer_id, rma.device_id, rma.lot_id, rma.item_id, rma.qty, rma.shipment_id, rma.sales_order_id,
            `Saha arızası ${rma.code} yükseltildi: ${input.note}`, rma.shipped_at, rma.warranty_until, rma.in_warranty, actor.userId],
        );
        escalatedRmaId = ins.rows[0].id as string;
        escalatedRmaCode = newCode;
        await recordEvent(db, actor, { entityType: "rma", entityId: escalatedRmaId, eventType: "created", after: { code: newCode, escalatedFrom: rma.code, kind: "return" } });
        await openTask(db, actor.companyId, { kind: "rma_receive", title: `İade ${newCode} — saha arızasından yükseltildi, teslim al`, entityType: "rma", entityId: escalatedRmaId, assigneeRole: "warehouse" });
        closed = true;
      }
      const returnsLoc = await locationOf(db, "returns");
      if (input.disposition === "scrap") {
        await db.query(
          `insert into stock_moves (company_id, item_id, lot_id, from_location_id, qty, move_type, ref_type, ref_id, created_by)
           values (app_company_id(), $1, $2, $3, $4, 'scrap', 'rma', $5, $6)`,
          [rma.item_id, rma.lot_id, returnsLoc, rma.qty, id, actor.userId],
        );
        if (rma.device_id) await db.query(`update devices set status = 'scrapped' where id = $1`, [rma.device_id]);
        closed = true;
      } else if (input.disposition === "restock") {
        const fin = await locationOf(db, "finished");
        await db.query(
          `insert into stock_moves (company_id, item_id, lot_id, from_location_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
           values (app_company_id(), $1, $2, $3, $4, $5, 'transfer', 'rma', $6, $7)`,
          [rma.item_id, rma.lot_id, returnsLoc, fin, rma.qty, id, actor.userId],
        );
        await db.query(`update devices set status = 'released' where id = $1`, [rma.device_id]);
        closed = true;
      } else if (input.disposition === "replace") {
        // İade gelen ürün analiz için karantinaya; müşteriye değişim ürünü gider.
        const q = await locationOf(db, "quarantine");
        await db.query(
          `insert into stock_moves (company_id, item_id, lot_id, from_location_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
           values (app_company_id(), $1, $2, $3, $4, $5, 'transfer', 'rma', $6, $7)`,
          [rma.item_id, rma.lot_id, returnsLoc, q, rma.qty, id, actor.userId],
        );
        if (rma.device_id) await db.query(`update devices set status = 'quarantined' where id = $1`, [rma.device_id]);
      } else if (input.disposition === "repair") {
        await db.query(`update devices set status = 'in_repair' where id = $1`, [rma.device_id]);
      }
      await db.query(
        `update rmas set disposition = $2, disposition_note = $3, credit_note_requested = $4, decided_by = $5, decided_at = now(),
                replacement_device_id = $6, replacement_lot_id = $7, retest_passed = $8, repair_note = null,
                escalated_rma_id = $9, closed_at = case when $10 then now() else null end
          where id = $1`,
        [id, input.disposition, input.note, input.creditNote, actor.userId, replacement?.deviceId ?? null, replacement?.lotId ?? null,
          input.disposition === "restock" ? true : null, escalatedRmaId, closed],
      );
      await setStatus(db, actor, rma, closed ? "closed" : "decided", { disposition: input.disposition, creditNote: input.creditNote, replacement: input.replacementCode, escalatedRmaCode: escalatedRmaCode ?? undefined }, input.note);
      if (rma.device_id) await recordEvent(db, actor, { entityType: "device", entityId: rma.device_id, eventType: `rma.${input.disposition}`, after: { rma: rma.code }, reason: input.note });
      await closeTasks(db, actor.companyId, "rma_inspect", id);
      if (input.creditNote) {
        await openTask(db, actor.companyId, { kind: "credit_note", title: `İade ${rma.code}: alacak belgesi hazırla (fatura sistemi bağlı değil)`, entityType: "rma", entityId: id, assigneeRole: "accounting" });
      }
      if (input.disposition === "repair") {
        await openTask(db, actor.companyId, { kind: "rma_repair", title: `İade ${rma.code}: tamir ve tekrar test`, entityType: "rma", entityId: id, assigneeRole: "technician" });
      } else if (!closed) {
        await openTask(db, actor.companyId, { kind: "rma_ship_back", title: `İade ${rma.code}: müşteriye gönder`, entityType: "rma", entityId: id, assigneeRole: "warehouse" });
      }
      return loadRma(db, id);
    });
  });

  /** Tamir sonucu: tekrar test geçmezse ürün gönderilemez; kalite yeniden karar verir (ör. hurda / değişim). */
  app.post("/api/rmas/:id/repair", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        note: z.string().min(3).max(2000),
        retestPassed: z.boolean(),
        // Tamir maliyeti için (isteğe bağlı): işçilik saati ve kullanılan parçalar (stoktan düşülür).
        laborHours: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
        parts: z.array(z.object({ itemId: z.string().uuid(), lotId: z.string().uuid(), qty: z.string().regex(/^\d+(\.\d{1,6})?$/) })).max(20).default([]),
      }),
      req.body,
    );
    return tenant(req, "production.test.record", async (db, actor) => {
      const rma = await lockRma(db, id);
      if (rma.status !== "decided" || rma.disposition !== "repair" || rma.retest_passed !== null) throw conflict("invalid_transition", "Tamir sonucu yalnızca tamir kararı verilmiş ve sonucu girilmemiş iade için girilir");
      const attemptNo = (await db.query(`select coalesce(max(attempt_no), 0) + 1 as n from rma_repair_attempts where rma_id = $1`, [id])).rows[0].n;
      const attempt = await db.query(
        `insert into rma_repair_attempts (company_id, rma_id, attempt_no, labor_hours, note, retest_passed, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6) returning id`,
        [id, attemptNo, input.laborHours ?? "0", input.note, input.retestPassed, actor.userId],
      );
      if (input.parts.length) {
        const stockLoc = await locationOf(db, "stock");
        for (const p of input.parts) {
          if (toMicro(p.qty) <= 0n) throw conflict("invalid_qty", "Parça miktarı sıfırdan büyük olmalı");
          const lot = await db.query(`select 1 from lots where id = $1 and item_id = $2`, [p.lotId, p.itemId]);
          if (!lot.rowCount) throw notFound("Parça lotu");
          await db.query(
            `insert into stock_moves (company_id, item_id, lot_id, from_location_id, qty, move_type, ref_type, ref_id, created_by)
             values (app_company_id(), $1, $2, $3, $4, 'issue', 'rma_repair', $5, $6)`,
            [p.itemId, p.lotId, stockLoc, p.qty, attempt.rows[0].id, actor.userId],
          );
        }
      }
      await db.query(`update rmas set repair_note = $2, retest_passed = $3 where id = $1`, [id, input.note, input.retestPassed]);
      if (input.retestPassed) await db.query(`update devices set status = 'returned' where id = $1`, [rma.device_id]);
      await recordEvent(db, actor, { entityType: "rma", entityId: id, eventType: input.retestPassed ? "repair.passed" : "repair.failed", after: { retestPassed: input.retestPassed, attemptNo, laborHours: input.laborHours ?? "0", parts: input.parts }, reason: input.note });
      await recordEvent(db, actor, { entityType: "device", entityId: rma.device_id, eventType: input.retestPassed ? "rma.repaired" : "rma.repair_failed", after: { rma: rma.code }, reason: input.note });
      await closeTasks(db, actor.companyId, "rma_repair", id);
      if (input.retestPassed) {
        await openTask(db, actor.companyId, { kind: "rma_ship_back", title: `İade ${rma.code}: tamir edildi, müşteriye gönder`, entityType: "rma", entityId: id, assigneeRole: "warehouse" });
      } else {
        await openTask(db, actor.companyId, { kind: "rma_inspect", title: `İade ${rma.code}: tamir başarısız, yeniden karar ver`, entityType: "rma", entityId: id, assigneeRole: "quality" });
      }
      return loadRma(db, id);
    });
  });

  /** Müşteriye gönderim: olduğu gibi iade, tamir edilen ürün veya değişim ürünü. Adres o anki haliyle saklanır. */
  app.post("/api/rmas/:id/ship-back", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ carrier: z.string().min(2).max(80), trackingNo: z.string().max(80).optional(), addressId: z.string().uuid().optional() }), req.body);
    return tenant(req, "shipment.create", (db, actor) =>
      idempotent(db, actor.companyId, "rma_ship_back", idempotencyKey(req), async () => {
        const rma = await lockRma(db, id);
        if (rma.status === "closed") return loadRma(db, id);
        if (rma.status !== "decided" || !["return_as_is", "repair", "replace"].includes(rma.disposition)) throw conflict("invalid_transition", "Gönderilecek karar yok");
        if (rma.disposition === "repair" && rma.retest_passed !== true) throw conflict("retest_required", "Tamir edilen ürün tekrar testi geçmeden gönderilemez");
        const addr = (await db.query(
          `select ${addressCols} from customer_addresses where customer_id = $1 and active and ($2::uuid is null or id = $2) order by (id = $2) desc nulls last, is_default desc limit 1`,
          [rma.customer_id, input.addressId ?? null],
        )).rows[0];
        if (!addr) throw conflict("address_required", "Müşterinin aktif teslim adresi yok");
        if (rma.disposition === "replace") {
          const lot = (await db.query(`select item_id from lots where id = $1`, [rma.replacement_lot_id])).rows[0];
          const qty = rma.replacement_device_id ? "1" : rma.qty;
          const locs = await db.query(
            `select b.location_id, b.qty from stock_balances b join locations l on l.id = b.location_id
              where b.lot_id = $1 and l.type in ('finished', 'stock') and b.qty > 0 order by (l.type = 'finished') desc, b.qty desc`,
            [rma.replacement_lot_id],
          );
          let need = toMicro(qty);
          for (const l of locs.rows) {
            if (need <= 0n) break;
            const take = need < toMicro(l.qty) ? need : toMicro(l.qty);
            await db.query(
              `insert into stock_moves (company_id, item_id, lot_id, from_location_id, qty, move_type, ref_type, ref_id, created_by)
               values (app_company_id(), $1, $2, $3, $4, 'ship', 'rma', $5, $6)`,
              [lot.item_id, rma.replacement_lot_id, l.location_id, fromMicro(take), id, actor.userId],
            );
            need -= take;
          }
          if (need > 0n) throw conflict("stock_missing", "Değişim ürünü artık stokta değil; yeniden seçin");
          if (rma.replacement_device_id) await db.query(`update devices set status = 'shipped' where id = $1`, [rma.replacement_device_id]);
        } else {
          const returnsLoc = await locationOf(db, "returns");
          await db.query(
            `insert into stock_moves (company_id, item_id, lot_id, from_location_id, qty, move_type, ref_type, ref_id, created_by)
             values (app_company_id(), $1, $2, $3, $4, 'ship', 'rma', $5, $6)`,
            [rma.item_id, rma.lot_id, returnsLoc, rma.qty, id, actor.userId],
          );
          if (rma.device_id) await db.query(`update devices set status = 'shipped' where id = $1`, [rma.device_id]);
        }
        await db.query(`update rmas set outbound_carrier = $2, outbound_tracking = $3, outbound_address = $4, closed_at = now() where id = $1`, [
          id, input.carrier, input.trackingNo ?? null, JSON.stringify(addr),
        ]);
        await setStatus(db, actor, rma, "closed", { carrier: input.carrier, trackingNo: input.trackingNo, document: "draft" });
        await closeTasks(db, actor.companyId, "rma_ship_back", id);
        return loadRma(db, id);
      }),
    );
  });

  app.post("/api/rmas/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body);
    return tenant(req, "rma.create", async (db, actor) => {
      const rma = await lockRma(db, id);
      if (rma.status !== "open") throw conflict("invalid_transition", "Teslim alınmış iade iptal edilemez; karar verilmeli");
      await db.query(`update rmas set cancel_reason = $2 where id = $1`, [id, input.reason]);
      await setStatus(db, actor, rma, "cancelled", {}, input.reason);
      await closeTasks(db, actor.companyId, "rma_receive", id);
      return loadRma(db, id);
    });
  });
}

/** Değişim ürünü: aynı ürün; serbest bırakılmış, pakette olmayan ve başka işe ayrılmamış stoktan. */
async function pickReplacement(db: Db, rma: { item_id: string; qty: string; device_id: string | null }, code: string) {
  const dev = (await db.query(
    `select d.id, d.serial, d.status, d.finished_lot_id, lo.item_id from devices d join lots lo on lo.id = d.finished_lot_id where d.serial = $1 for update of d`,
    [code],
  )).rows[0];
  let lotId: string;
  let deviceId: string | null = null;
  const qty = dev ? toMicro("1") : toMicro(rma.qty);
  if (dev) {
    if (dev.item_id !== rma.item_id) throw conflict("wrong_product", "Değişim ürünü iade edilen ürünle aynı değil");
    if (dev.status !== "released") throw conflict("not_released", `${dev.serial} serbest bırakılmış stokta değil (durum: ${dev.status})`);
    const pk = await db.query(`select 1 from package_items pi join packages pk on pk.id = pi.package_id join shipments s on s.id = pk.shipment_id where pi.device_id = $1 and s.status in ('preparing', 'packed')`, [dev.id]);
    if (pk.rowCount) throw conflict("already_packed", `${dev.serial} açık bir sevkiyatta paketli`);
    const used = await db.query(`select code from rmas where replacement_device_id = $1 and status = 'decided'`, [dev.id]);
    if (used.rowCount) throw conflict("already_allocated", `${dev.serial} başka bir iadeye değişim olarak ayrılmış (${used.rows[0].code})`);
    lotId = dev.finished_lot_id;
    deviceId = dev.id;
  } else {
    if (rma.device_id) throw conflict("serial_required", "Seri numaralı ürünün değişimi de seri numarası okutularak yapılır");
    const lot = (await db.query(`select id, item_id from lots where lot_no = $1`, [code])).rows[0];
    if (!lot) throw notFound("Değişim seri/lotu");
    if (lot.item_id !== rma.item_id) throw conflict("wrong_product", "Değişim ürünü iade edilen ürünle aynı değil");
    lotId = lot.id;
  }
  const free = await db.query(
    `select coalesce((select sum(b.qty) from stock_balances b join locations l on l.id = b.location_id where b.lot_id = $1 and l.type in ('finished', 'stock')), 0) as usable,
            coalesce((select sum(qty) from reservations where lot_id = $1 and status = 'active'), 0) as reserved,
            coalesce((select sum(case when replacement_device_id is not null then 1 else qty end) from rmas where replacement_lot_id = $1 and status = 'decided'), 0) as allocated`,
    [lotId],
  );
  const avail = toMicro(free.rows[0].usable) - toMicro(free.rows[0].reserved) - toMicro(String(free.rows[0].allocated));
  if (avail < qty) throw conflict("reserved_for_other", "Seçilen stok başka siparişlere ayrılmış; serbest miktar yetersiz");
  return { deviceId, lotId };
}
