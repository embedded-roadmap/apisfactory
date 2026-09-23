import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { idempotent, nextCode, recordEvent } from "../lib/records";
import { idempotencyKey, parse, tenant } from "../http/context";

/**
 * W24 devamı — Alacaklar.
 *  - Müşteri faturası sevk edilmiş sevkiyattan TASLAK olarak hazırlanır (satır fiyatı siparişten); sevkiyat başına bir fatura.
 *  - "Kes": fatura numarası ve vade (müşteri vadesi) sabitlenir; kesilen fatura değişmez (düzeltme = iptal + yeni).
 *    Resmi e-fatura/e-arşiv gönderimi yok (W36) — belge modu TASLAK.
 *  - Tahsilat YAPILMAZ: dışarıda alınmış ödemenin kaydı; açık bakiyeyi aşamaz.
 *  - Kredi kontrolü: açık alacak + faturalanmamış kesin siparişler + bu sipariş > limit veya vadesi X günden fazla geçmiş
 *    alacak varsa sipariş kesinleştirilemez; yetkili gerekçeyle sipariş bazında serbest bırakabilir.
 */

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Amt = z.string().regex(/^\d+(\.\d{1,2})?$/);
const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** Müşteri kredi durumu. orderId verilirse o siparişin tutarı "bu sipariş" olarak ayrıca eklenir. */
export async function creditStatus(db: Db, customerId: string, orderId?: string) {
  const c = (await db.query(`select name, credit_limit::float8 as lim, credit_currency as cur, overdue_block_days as odb, payment_terms_days as terms from customers where id = $1`, [customerId])).rows[0];
  if (!c) throw notFound("Müşteri");
  const ar = (await db.query(
    `select coalesce(sum(ci.gross_amount - coalesce((select sum(r.amount) from customer_receipts r where r.invoice_id = ci.id), 0)), 0)::float8 as open,
            coalesce(max(case when ci.due_date < current_date then current_date - ci.due_date end), 0) as overdue_days,
            coalesce(sum(case when ci.due_date < current_date then ci.gross_amount - coalesce((select sum(r.amount) from customer_receipts r where r.invoice_id = ci.id), 0) end), 0)::float8 as overdue_amount
       from customer_invoices ci where ci.customer_id = $1 and ci.status = 'issued' and ci.currency = $2`,
    [customerId, c.cur],
  )).rows[0];
  // Faturalanmamış kesin siparişler (KDV hariç sipariş değeri − faturalanan net), bu sipariş hariç
  const uninv = (await db.query(
    `select coalesce(sum(greatest(v.value - v.invoiced, 0)), 0)::float8 as amount, coalesce(sum(v.unpriced), 0)::int as unpriced
       from (select so.id,
                    coalesce(sum(l.qty * l.unit_price) filter (where l.currency = $2), 0) as value,
                    count(*) filter (where l.unit_price is null) as unpriced,
                    coalesce((select sum(ci.net_amount) from customer_invoices ci where ci.sales_order_id = so.id and ci.status in ('issued', 'paid') and ci.currency = $2), 0) as invoiced
               from sales_orders so join sales_order_lines l on l.order_id = so.id
              where so.customer_id = $1 and so.status in ('firm', 'shipped') and ($3::uuid is null or so.id <> $3)
              group by so.id) v`,
    [customerId, c.cur, orderId ?? null],
  )).rows[0];
  let orderValue = 0;
  let orderUnpriced = 0;
  if (orderId) {
    const o = (await db.query(
      `select coalesce(sum(qty * unit_price) filter (where currency = $2), 0)::float8 as v, count(*) filter (where unit_price is null)::int as u from sales_order_lines where order_id = $1`,
      [orderId, c.cur],
    )).rows[0];
    orderValue = o.v;
    orderUnpriced = o.u;
  }
  const exposure = round2(ar.open + uninv.amount + orderValue);
  const reasons: string[] = [];
  if (c.lim !== null && exposure > c.lim + 1e-9) reasons.push(`Kredi limiti aşılıyor: risk ${exposure.toFixed(2)} ${c.cur} > limit ${c.lim.toFixed(2)} ${c.cur}`);
  if (c.odb !== null && ar.overdue_days > c.odb) reasons.push(`Vadesi ${ar.overdue_days} gün geçmiş alacak var (izin verilen ${c.odb} gün)`);
  const warnings: string[] = [];
  if (uninv.unpriced + orderUnpriced > 0) warnings.push("Fiyatı girilmemiş sipariş satırları risk tutarına katılmadı");
  return {
    customer: c.name, currency: c.cur, creditLimit: c.lim, overdueBlockDays: c.odb, paymentTermsDays: c.terms,
    openReceivables: round2(ar.open), overdueAmount: round2(ar.overdue_amount), maxOverdueDays: ar.overdue_days,
    uninvoicedOrders: round2(uninv.amount), orderValue: round2(orderValue), exposure,
    available: c.lim === null ? null : round2(c.lim - exposure), blocked: reasons.length > 0, reasons, warnings,
  };
}

async function loadInvoice(db: Db, id: string) {
  const r = await db.query(
    `select ci.id, ci.code, ci.status, ci.document_mode as "documentMode", ci.invoice_date::text as "invoiceDate", ci.due_date::text as "dueDate", ci.currency,
            ci.tax_rate as "taxRate", ci.net_amount as "netAmount", ci.tax_amount as "taxAmount", ci.gross_amount as "grossAmount", ci.note, ci.cancel_reason as "cancelReason",
            ci.created_at as "createdAt", cu.name as "createdBy", ci.issued_at as "issuedAt", iu.name as "issuedBy",
            c.id as "customerId", c.code as "customerCode", c.name as "customerName", so.id as "salesOrderId", so.code as "salesOrderCode", sh.id as "shipmentId", sh.code as "shipmentCode",
            coalesce((select sum(r.amount) from customer_receipts r where r.invoice_id = ci.id), 0) as received,
            (ci.status = 'issued' and ci.due_date < current_date) as overdue
       from customer_invoices ci join customers c on c.id = ci.customer_id join sales_orders so on so.id = ci.sales_order_id
       left join shipments sh on sh.id = ci.shipment_id left join users cu on cu.id = ci.created_by left join users iu on iu.id = ci.issued_by
      where ci.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw notFound("Müşteri faturası");
  const lines = await db.query(`select line_no as "lineNo", description, qty, unit_price as "unitPrice", amount from customer_invoice_lines where invoice_id = $1 order by line_no`, [id]);
  const receipts = await db.query(
    `select r.amount, r.received_on::text as "receivedOn", r.reference, u.name as "recordedBy", r.created_at as "createdAt" from customer_receipts r left join users u on u.id = r.recorded_by where r.invoice_id = $1 order by r.received_on, r.created_at`,
    [id],
  );
  const inv = r.rows[0];
  return { ...inv, open: (Number(inv.grossAmount) - Number(inv.received)).toFixed(2), lines: lines.rows, receipts: receipts.rows };
}

async function recompute(db: Db, id: string) {
  const s = (await db.query(`select coalesce(sum(amount), 0)::float8 as net from customer_invoice_lines where invoice_id = $1`, [id])).rows[0].net;
  const t = (await db.query(`select tax_rate::float8 as r from customer_invoices where id = $1`, [id])).rows[0].r;
  const net = round2(s), tax = round2((net * t) / 100);
  await db.query(`update customer_invoices set net_amount = $2, tax_amount = $3, gross_amount = $4 where id = $1`, [id, net.toFixed(2), tax.toFixed(2), (net + tax).toFixed(2)]);
}

export async function receivablesRoutes(app: FastifyInstance) {
  // ---- Müşteri kredi ayarları ---------------------------------------------------------------
  app.get("/api/customers/:id/credit", async (req) => tenant(req, "receivable.view", (db) => creditStatus(db, (req.params as { id: string }).id)));

  app.post("/api/customers/:id/credit", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({ creditLimit: Amt.nullable(), creditCurrency: z.string().regex(/^[A-Z]{3}$/).default("TRY"), paymentTermsDays: z.number().int().min(0).max(365), overdueBlockDays: z.number().int().min(0).max(365).nullable(), reason: z.string().min(3).max(500) }),
      req.body,
    );
    return tenant(req, "receivable.manage", async (db, actor) => {
      const before = (await db.query(`select credit_limit, credit_currency, payment_terms_days, overdue_block_days from customers where id = $1 for update`, [id])).rows[0];
      if (!before) throw notFound("Müşteri");
      await db.query(`update customers set credit_limit = $2, credit_currency = $3, payment_terms_days = $4, overdue_block_days = $5 where id = $1`, [id, input.creditLimit, input.creditCurrency, input.paymentTermsDays, input.overdueBlockDays]);
      await recordEvent(db, actor, { entityType: "customer", entityId: id, eventType: "credit.updated", before, after: input, reason: input.reason });
      return creditStatus(db, id);
    });
  });

  /** Kredi engelinin sipariş bazında gerekçeli kaldırılması (tek sipariş için). */
  app.post("/api/sales-orders/:id/credit-release", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(10).max(500) }), req.body);
    return tenant(req, "credit.override", async (db, actor) => {
      const o = (await db.query(`select status, customer_id from sales_orders where id = $1 for update`, [id])).rows[0];
      if (!o) throw notFound("Satış siparişi");
      if (!["draft", "availability_review"].includes(o.status)) throw conflict("invalid_transition", "Yalnızca kesinleşmemiş sipariş için kredi engeli kaldırılır");
      const cs = await creditStatus(db, o.customer_id, id);
      await db.query(`update sales_orders set credit_release_reason = $2, credit_released_by = $3, credit_released_at = now() where id = $1`, [id, input.reason, actor.userId]);
      await recordEvent(db, actor, { entityType: "sales_order", entityId: id, eventType: "credit.released", after: { exposure: cs.exposure, limit: cs.creditLimit, reasons: cs.reasons }, reason: input.reason });
      return { id, released: true, credit: cs };
    });
  });

  // ---- Müşteri faturası -----------------------------------------------------------------------
  /** Faturası kesilmemiş sevk edilmiş sevkiyatlar. */
  app.get("/api/receivables/uninvoiced-shipments", async (req) =>
    tenant(req, "receivable.manage", async (db) => {
      const r = await db.query(
        `select sh.id, sh.code, sh.status, sh.shipped_at as "shippedAt", so.code as "orderCode", c.name as "customerName",
                (select count(*) from shipment_lines sl join sales_order_lines l on l.id = sl.sales_order_line_id where sl.shipment_id = sh.id and l.unit_price is null)::int as unpriced
           from shipments sh join sales_orders so on so.id = sh.sales_order_id join customers c on c.id = so.customer_id
          where sh.status in ('shipped', 'delivered')
            and not exists (select 1 from customer_invoices ci where ci.shipment_id = sh.id and ci.status <> 'cancelled')
          order by sh.shipped_at`,
      );
      return r.rows;
    }),
  );

  app.post("/api/customer-invoices/from-shipment", async (req) => {
    const input = parse(z.object({ shipmentId: z.string().uuid(), taxRate: z.number().min(0).max(100).default(20) }), req.body);
    return tenant(req, "receivable.manage", (db, actor) =>
      idempotent(db, actor.companyId, "customer_invoice", idempotencyKey(req), async () => {
        const sh = (await db.query(`select sh.id, sh.code, sh.status, sh.sales_order_id, so.customer_id from shipments sh join sales_orders so on so.id = sh.sales_order_id where sh.id = $1 for update of sh`, [input.shipmentId])).rows[0];
        if (!sh) throw notFound("Sevkiyat");
        if (!["shipped", "delivered"].includes(sh.status)) throw conflict("not_shipped", "Yalnızca sevk edilmiş sevkiyat faturalanır");
        const ex = await db.query(`select code from customer_invoices where shipment_id = $1 and status <> 'cancelled'`, [sh.id]);
        if (ex.rows[0]) throw conflict("already_invoiced", `Bu sevkiyatın faturası var (${ex.rows[0].code})`);
        const lines = (await db.query(
          `select sl.sales_order_line_id as id, sl.qty, l.unit_price, l.currency, p.code || ' Rev.' || pr.rev as descr
             from shipment_lines sl join sales_order_lines l on l.id = sl.sales_order_line_id join product_revisions pr on pr.id = l.product_revision_id join products p on p.id = pr.product_id
            where sl.shipment_id = $1 order by l.line_no`,
          [sh.id],
        )).rows;
        if (!lines.length) throw badRequest("Sevkiyatta satır yok");
        const unpriced = lines.filter((l) => l.unit_price === null).map((l) => l.descr);
        if (unpriced.length) throw conflict("price_missing", `Sipariş satırında fiyat yok: ${unpriced.join(", ")}`, { lines: unpriced });
        const currencies = [...new Set(lines.map((l) => l.currency))];
        if (currencies.length > 1) throw conflict("currency_mixed", "Sevkiyatta farklı para birimli satırlar var");
        const id = randomUUID();
        const code = await nextCode(db, actor.companyId, "customer_invoice", "MF-TASLAK");
        await db.query(
          `insert into customer_invoices (id, company_id, code, customer_id, sales_order_id, shipment_id, currency, tax_rate, net_amount, tax_amount, gross_amount, created_by)
           values ($1, app_company_id(), $2, $3, $4, $5, $6, $7, 0, 0, 0, $8)`,
          [id, code, sh.customer_id, sh.sales_order_id, sh.id, currencies[0], input.taxRate, actor.userId],
        );
        for (const [i, l] of lines.entries()) {
          await db.query(
            `insert into customer_invoice_lines (company_id, invoice_id, line_no, sales_order_line_id, description, qty, unit_price, amount) values (app_company_id(), $1, $2, $3, $4, $5, $6, $7)`,
            [id, i + 1, l.id, l.descr, l.qty, l.unit_price, round2(Number(l.qty) * Number(l.unit_price)).toFixed(2)],
          );
        }
        await recompute(db, id);
        await recordEvent(db, actor, { entityType: "customer_invoice", entityId: id, eventType: "draft_created", after: { code, shipment: sh.code } });
        return loadInvoice(db, id);
      }),
    );
  });

  /** Taslakta KDV oranı ve not değiştirilebilir. */
  app.post("/api/customer-invoices/:id/update", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ taxRate: z.number().min(0).max(100).optional(), note: z.string().max(1000).nullable().optional() }), req.body);
    return tenant(req, "receivable.manage", async (db) => {
      const s = (await db.query(`select status from customer_invoices where id = $1 for update`, [id])).rows[0];
      if (!s) throw notFound("Müşteri faturası");
      if (s.status !== "draft") throw conflict("invoice_issued", "Kesilmiş fatura değiştirilemez");
      if (input.taxRate !== undefined) await db.query(`update customer_invoices set tax_rate = $2 where id = $1`, [id, input.taxRate]);
      if (input.note !== undefined) await db.query(`update customer_invoices set note = $2 where id = $1`, [id, input.note]);
      await recompute(db, id);
      return loadInvoice(db, id);
    });
  });

  /** Faturayı kes: kalıcı numara, fatura tarihi ve vade sabitlenir. Resmi e-belge gönderilmez. */
  app.post("/api/customer-invoices/:id/issue", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ invoiceDate: Day.optional() }), req.body ?? {});
    return tenant(req, "receivable.manage", async (db, actor) => {
      const inv = (await db.query(`select ci.status, ci.code, c.payment_terms_days as terms from customer_invoices ci join customers c on c.id = ci.customer_id where ci.id = $1 for update of ci`, [id])).rows[0];
      if (!inv) throw notFound("Müşteri faturası");
      if (inv.status !== "draft") throw conflict("invalid_transition", "Yalnızca taslak fatura kesilir");
      const date = input.invoiceDate ?? new Date().toISOString().slice(0, 10);
      const code = await nextCode(db, actor.companyId, "customer_invoice_issued", "MF");
      await db.query(
        `update customer_invoices set status = 'issued', code = $2, invoice_date = $3, due_date = $4, issued_by = $5, issued_at = now() where id = $1`,
        [id, code, date, addDays(date, inv.terms), actor.userId],
      );
      await recordEvent(db, actor, { entityType: "customer_invoice", entityId: id, eventType: "issued", before: { code: inv.code }, after: { code, invoiceDate: date, documentMode: "draft", note: "Resmi e-fatura/e-arşiv gönderilmedi (W36)" } });
      return loadInvoice(db, id);
    });
  });

  app.post("/api/customer-invoices/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const inv = (await db.query(`select status from customer_invoices where id = $1 for update`, [id])).rows[0];
      if (!inv) throw notFound("Müşteri faturası");
      const rec = Number((await db.query(`select coalesce(sum(amount), 0) as a from customer_receipts where invoice_id = $1`, [id])).rows[0].a);
      if (rec > 0 || ["paid", "cancelled"].includes(inv.status)) throw conflict("invalid_transition", "Tahsilat kaydı olan veya kapanmış fatura iptal edilemez");
      await db.query(`update customer_invoices set status = 'cancelled', cancel_reason = $2 where id = $1`, [id, input.reason]);
      await recordEvent(db, actor, { entityType: "customer_invoice", entityId: id, eventType: "cancelled", reason: input.reason });
      return loadInvoice(db, id);
    });
  });

  /** Tahsilat kaydı: sistem tahsilat yapmaz; alınmış ödemenin kaydı. */
  app.post("/api/customer-invoices/:id/receipts", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ amount: Amt, receivedOn: Day, reference: z.string().trim().min(3).max(120) }), req.body);
    return tenant(req, "payment.record", (db, actor) =>
      idempotent(db, actor.companyId, "customer_receipt", idempotencyKey(req), async () => {
        const inv = (await db.query(`select status, gross_amount from customer_invoices where id = $1 for update`, [id])).rows[0];
        if (!inv) throw notFound("Müşteri faturası");
        if (inv.status !== "issued") throw conflict("not_receivable", "Yalnızca kesilmiş ve kapanmamış faturaya tahsilat kaydı girilir");
        const got = Number((await db.query(`select coalesce(sum(amount), 0) as a from customer_receipts where invoice_id = $1`, [id])).rows[0].a);
        const open = round2(Number(inv.gross_amount) - got);
        if (Number(input.amount) > open + 1e-9) throw conflict("overpayment", `Tahsilat açık bakiyeyi (${open.toFixed(2)}) aşıyor`);
        await db.query(`insert into customer_receipts (company_id, invoice_id, amount, received_on, reference, recorded_by) values (app_company_id(), $1, $2, $3, $4, $5)`, [id, input.amount, input.receivedOn, input.reference, actor.userId]);
        if (Math.abs(open - Number(input.amount)) < 0.005) await db.query(`update customer_invoices set status = 'paid' where id = $1`, [id]);
        await recordEvent(db, actor, { entityType: "customer_invoice", entityId: id, eventType: "receipt.recorded", after: { ...input, note: "Dışarıda alınmış ödemenin kaydı" } });
        return loadInvoice(db, id);
      }),
    );
  });

  app.get("/api/customer-invoices", async (req) => {
    const q = z.object({ status: z.string().optional(), customerId: z.string().uuid().optional() }).parse(req.query);
    return tenant(req, "receivable.view", async (db) => {
      const r = await db.query(
        `select ci.id, ci.code, ci.status, c.name as "customerName", so.code as "orderCode", ci.invoice_date::text as "invoiceDate", ci.due_date::text as "dueDate",
                ci.currency, ci.gross_amount as "grossAmount", coalesce((select sum(r.amount) from customer_receipts r where r.invoice_id = ci.id), 0) as received,
                (ci.status = 'issued' and ci.due_date < current_date) as overdue
           from customer_invoices ci join customers c on c.id = ci.customer_id join sales_orders so on so.id = ci.sales_order_id
          where ($1::text is null or ci.status = $1) and ($2::uuid is null or ci.customer_id = $2)
          order by (ci.status = 'draft') desc, ci.due_date nulls first, ci.created_at desc limit 300`,
        [q.status ?? null, q.customerId ?? null],
      );
      return r.rows;
    });
  });

  app.get("/api/customer-invoices/:id", async (req) => tenant(req, "receivable.view", (db) => loadInvoice(db, (req.params as { id: string }).id)));

  /** Alacak yaşlandırma ve müşteri bazında risk (kredi limitiyle). */
  app.get("/api/receivables/aging", async (req) =>
    tenant(req, "receivable.view", async (db) => {
      const buckets = await db.query(
        `with open as (select ci.customer_id, ci.currency, ci.due_date, ci.gross_amount - coalesce((select sum(r.amount) from customer_receipts r where r.invoice_id = ci.id), 0) as open
                         from customer_invoices ci where ci.status = 'issued')
         select c.id as "customerId", c.name as "customerName", o.currency,
                sum(open) filter (where due_date >= current_date) as current,
                sum(open) filter (where due_date between current_date - 30 and current_date - 1) as "over1",
                sum(open) filter (where due_date between current_date - 60 and current_date - 31) as "over31",
                sum(open) filter (where due_date < current_date - 60) as "over60",
                sum(open) as total
           from open o join customers c on c.id = o.customer_id group by c.id, c.name, o.currency order by total desc`,
      );
      const customers = await db.query(`select id from customers where credit_limit is not null or id in (select customer_id from customer_invoices where status = 'issued') order by name`);
      const credit = [];
      for (const c of customers.rows) credit.push({ customerId: c.id, ...(await creditStatus(db, c.id)) });
      return { buckets: buckets.rows, credit };
    }),
  );
}
