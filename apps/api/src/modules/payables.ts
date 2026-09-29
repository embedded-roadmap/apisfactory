import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { closeTasks, idempotent, nextCode, openTask, recordEvent, type Actor } from "../lib/records";
import { ctxOf, idempotencyKey, parse, tenant } from "../http/context";

/**
 * W24 — Tedarikçi faturası ve üç yönlü eşleştirme (sipariş – kalite kabulü – fatura).
 *  - Miktar: faturalanan (önceki faturalar dahil) ≤ kalite kabul edilen miktar (+ tolerans). Kabul bekleyen miktar faturalanamaz.
 *  - Fiyat: sipariş birim fiyatından sapma ≤ tolerans % (veya satır tutarı farkı ≤ tutar toleransı). Para birimi aynı olmalı.
 *  - Siparişsiz satır ve fatura toplamı uyuşmazlığı fark sayılır.
 *  - Eşleşen fatura otomatik "ödemeye hazır"; farklı fatura muhasebe onayına düşer — faturayı giren onaylayamaz (görev ayrılığı).
 *  - Onayda fatura fiyatı, o sipariş satırından gelen lotlara maliyet kaydı olarak yazılır (kaynak: fatura).
 *  - Ödeme YAPILMAZ: dışarıda yapılmış ödemenin kaydı tutulur; vade/yaşlandırma ve haftalık ödeme planı gösterilir.
 */

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Amt = z.string().regex(/^\d+(\.\d{1,2})?$/);
const Qty = z.string().regex(/^\d+(\.\d{1,6})?$/);
const Price = z.string().regex(/^\d+(\.\d{1,6})?$/);
const DEFAULT_POLICY = { versionNo: null as number | null, priceTolerancePct: 2, qtyTolerancePct: 0, amountTolerance: 0 };

const round2 = (n: number) => Math.round(n * 100) / 100;

async function apPolicy(db: Db) {
  const r = await db.query(
    `select version_no as "versionNo", price_tolerance_pct::float8 as "priceTolerancePct", qty_tolerance_pct::float8 as "qtyTolerancePct", amount_tolerance::float8 as "amountTolerance"
       from ap_policies order by version_no desc limit 1`,
  );
  return r.rows[0] ?? DEFAULT_POLICY;
}

type LineIn = { lineNo: number; poLineId: string | null; qty: number; unitPrice: number; amount: number };
type Flag = { code: string; message: string };

/** Üç yönlü eşleştirme: satır başına bayraklar ve genel sonuç. Hiçbir şey yazmaz. */
async function match(db: Db, inv: { id: string | null; supplierId: string; currency: string; netAmount: number }, lines: LineIn[]) {
  const pol = await apPolicy(db);
  const out = [];
  let sum = 0;
  for (const l of lines) {
    sum += l.amount;
    const flags: Flag[] = [];
    let ctx: Record<string, unknown> = {};
    if (Math.abs(round2(l.qty * l.unitPrice) - l.amount) > 0.01) flags.push({ code: "line_amount", message: `Satır tutarı miktar × fiyatla uyuşmuyor (${round2(l.qty * l.unitPrice)})` });
    if (!l.poLineId) {
      flags.push({ code: "po_missing", message: "Siparişe bağlı değil" });
    } else {
      const p = (await db.query(
        `select l.id, l.po_code, l.supplier_id, l.unit_price::float8 as price, l.currency, l.qty_ordered::float8 as ordered, l.status, i.code as item,
                coalesce((select sum(x.accepted_qty) from inspections x join goods_receipt_lines grl on grl.id = x.receipt_line_id join goods_receipts gr on gr.id = grl.receipt_id where gr.po_line_id = l.id), 0)::float8 as accepted,
                coalesce((select sum(grl.qty) from goods_receipt_lines grl join goods_receipts gr on gr.id = grl.receipt_id
                           where gr.po_line_id = l.id and not exists (select 1 from inspections x where x.receipt_line_id = grl.id)), 0)::float8 as pending,
                coalesce((select sum(il.qty) from supplier_invoice_lines il join supplier_invoices si on si.id = il.invoice_id
                           where il.po_line_id = l.id and si.status not in ('rejected', 'cancelled') and ($2::uuid is null or si.id <> $2)), 0)::float8 as invoiced
           from purchase_order_lines l join items i on i.id = l.item_id where l.id = $1`,
        [l.poLineId, inv.id],
      )).rows[0];
      if (!p) {
        flags.push({ code: "po_missing", message: "Sipariş satırı bulunamadı" });
      } else {
        ctx = { poCode: p.po_code, item: p.item, poPrice: p.price, ordered: p.ordered, accepted: p.accepted, pendingInspection: p.pending, invoicedBefore: p.invoiced };
        if (p.supplier_id && p.supplier_id !== inv.supplierId) flags.push({ code: "supplier_mismatch", message: "Sipariş başka tedarikçiye ait" });
        if (p.currency && p.currency !== inv.currency) flags.push({ code: "currency_mismatch", message: `Sipariş ${p.currency}, fatura ${inv.currency}` });
        const allowed = p.accepted * (1 + pol.qtyTolerancePct / 100);
        if (p.invoiced + l.qty > allowed + 1e-9) {
          flags.push({
            code: "qty_over_accepted",
            message: `Faturalanan ${p.invoiced + l.qty} > kalite kabul ${p.accepted}${p.pending ? ` (kabul bekleyen ${p.pending})` : ""}`,
          });
        }
        if (p.price === null) flags.push({ code: "po_price_missing", message: "Siparişte birim fiyat yok" });
        else if (p.currency === inv.currency) {
          const dev = p.price > 0 ? ((l.unitPrice - p.price) / p.price) * 100 : l.unitPrice > 0 ? 100 : 0;
          const diffAmount = Math.abs((l.unitPrice - p.price) * l.qty);
          ctx.priceDeviationPct = Math.round(dev * 100) / 100;
          if (Math.abs(dev) > pol.priceTolerancePct + 1e-9 && diffAmount > pol.amountTolerance) {
            flags.push({ code: "price_variance", message: `Birim fiyat ${l.unitPrice}, sipariş ${p.price} (%${Math.round(dev * 100) / 100})` });
          }
        }
      }
    }
    out.push({ lineNo: l.lineNo, poLineId: l.poLineId, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount, ...ctx, flags });
  }
  const headerFlags: Flag[] = [];
  if (Math.abs(round2(sum) - inv.netAmount) > 0.01) headerFlags.push({ code: "total_mismatch", message: `Satır toplamı ${round2(sum)} ≠ fatura net tutarı ${inv.netAmount}` });
  const matched = headerFlags.length === 0 && out.every((l) => l.flags.length === 0);
  return { matched, policyVersion: pol.versionNo, tolerance: { pricePct: pol.priceTolerancePct, qtyPct: pol.qtyTolerancePct, amount: pol.amountTolerance }, headerFlags, lines: out };
}

/** Onaylanan faturanın fiyatı, sipariş satırından gelen lotlara maliyet olarak yazılır (lot başına bir kez). */
async function writeLotCosts(db: Db, actor: Actor, invoiceId: string) {
  const inv = (await db.query(`select code, currency from supplier_invoices where id = $1`, [invoiceId])).rows[0];
  const lots = await db.query(
    `select distinct grl.lot_id, il.unit_price
       from supplier_invoice_lines il join goods_receipts gr on gr.po_line_id = il.po_line_id join goods_receipt_lines grl on grl.receipt_id = gr.id
      where il.invoice_id = $1 and il.po_line_id is not null
        and not exists (select 1 from lot_costs lc where lc.lot_id = grl.lot_id and lc.source = 'invoice' and lc.reference = $2)`,
    [invoiceId, inv.code],
  );
  for (const l of lots.rows) {
    await db.query(
      `insert into lot_costs (company_id, lot_id, unit_cost, currency, source, reference, recorded_by) values (app_company_id(), $1, $2, $3, 'invoice', $4, $5)`,
      [l.lot_id, l.unit_price, inv.currency, inv.code, actor.userId],
    );
  }
  return lots.rowCount ?? 0;
}

async function loadInvoice(db: Db, id: string) {
  const r = await db.query(
    `select si.id, si.code, si.invoice_no as "invoiceNo", si.invoice_date::text as "invoiceDate", si.due_date::text as "dueDate", si.currency,
            si.net_amount as "netAmount", si.tax_amount as "taxAmount", si.gross_amount as "grossAmount", si.status, si.match_result as "matchResult",
            si.ap_policy_version as "apPolicyVersion", si.entered_by as "enteredById", eu.name as "enteredBy", si.created_at as "createdAt",
            du.name as "decidedBy", si.decided_at as "decidedAt", si.decision_note as "decisionNote",
            s.id as "supplierId", s.code as "supplierCode", s.name as "supplierName",
            coalesce((select sum(p.amount) from supplier_payments p where p.invoice_id = si.id), 0) as paid,
            (si.due_date < current_date and si.status in ('approved', 'variance', 'received')) as overdue
       from supplier_invoices si join suppliers s on s.id = si.supplier_id left join users eu on eu.id = si.entered_by left join users du on du.id = si.decided_by
      where si.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw notFound("Fatura");
  const lines = await db.query(
    `select il.line_no as "lineNo", il.po_line_id as "poLineId", l.po_code as "poCode", i.code as "itemCode", il.description, il.qty, il.unit_price as "unitPrice", il.amount
       from supplier_invoice_lines il left join purchase_order_lines l on l.id = il.po_line_id left join items i on i.id = coalesce(il.item_id, l.item_id)
      where il.invoice_id = $1 order by il.line_no`,
    [id],
  );
  const payments = await db.query(
    `select p.amount, p.paid_on::text as "paidOn", p.reference, u.name as "recordedBy", p.created_at as "createdAt"
       from supplier_payments p left join users u on u.id = p.recorded_by where p.invoice_id = $1 order by p.paid_on, p.created_at`,
    [id],
  );
  const inv = r.rows[0];
  return { ...inv, open: (Number(inv.grossAmount) - Number(inv.paid)).toFixed(2), lines: lines.rows, payments: payments.rows };
}

const InvoiceInput = z.object({
  supplierId: z.string().uuid(),
  invoiceNo: z.string().trim().min(1).max(60),
  invoiceDate: Day,
  dueDate: Day.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  netAmount: Amt,
  taxAmount: Amt.default("0"),
  lines: z.array(z.object({ poLineId: z.string().uuid().optional(), description: z.string().max(300).optional(), qty: Qty, unitPrice: Price, amount: Amt })).min(1).max(200),
});

export async function payablesRoutes(app: FastifyInstance) {
  // ---- Eşleştirme politikası ------------------------------------------------------------------
  app.get("/api/payables/policy", async (req) =>
    tenant(req, "invoice.view", async (db) => {
      const h = await db.query(
        `select p.version_no as "versionNo", p.price_tolerance_pct as "priceTolerancePct", p.qty_tolerance_pct as "qtyTolerancePct", p.amount_tolerance as "amountTolerance",
                p.note, p.created_at as "createdAt", u.name as "createdBy" from ap_policies p left join users u on u.id = p.created_by order by p.version_no desc`,
      );
      return { current: await apPolicy(db), history: h.rows, defaults: "Politika yoksa: fiyat toleransı %2, miktar toleransı %0, tutar toleransı 0." };
    }),
  );

  app.post("/api/payables/policy", async (req) => {
    const input = parse(z.object({ priceTolerancePct: z.number().min(0).max(50), qtyTolerancePct: z.number().min(0).max(50), amountTolerance: z.number().min(0).max(1e9), note: z.string().min(3).max(500) }), req.body);
    return tenant(req, "cost.manage", async (db, actor) => {
      await db.query(`select pg_advisory_xact_lock(hashtext('ap_policy:' || app_company_id()::text))`);
      const n = (await db.query(`select coalesce(max(version_no), 0) + 1 as n from ap_policies`)).rows[0].n;
      const r = await db.query(
        `insert into ap_policies (company_id, version_no, price_tolerance_pct, qty_tolerance_pct, amount_tolerance, note, created_by) values (app_company_id(), $1, $2, $3, $4, $5, $6) returning id`,
        [n, input.priceTolerancePct, input.qtyTolerancePct, input.amountTolerance, input.note, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "ap_policy", entityId: r.rows[0].id, eventType: "published", after: { versionNo: n, ...input }, reason: input.note });
      return { versionNo: n, ...input };
    });
  });

  // ---- Fatura --------------------------------------------------------------------------------
  /** Kaydetmeden eşleştirme önizlemesi. */
  app.post("/api/supplier-invoices/preview", async (req) => {
    const input = parse(InvoiceInput, req.body);
    return tenant(req, "invoice.manage", async (db) => {
      const net = Number(input.netAmount);
      return match(db, { id: null, supplierId: input.supplierId, currency: input.currency, netAmount: net },
        input.lines.map((l, i) => ({ lineNo: i + 1, poLineId: l.poLineId ?? null, qty: Number(l.qty), unitPrice: Number(l.unitPrice), amount: Number(l.amount) })));
    });
  });

  app.post("/api/supplier-invoices", async (req) => {
    const input = parse(InvoiceInput, req.body);
    return tenant(req, "invoice.manage", (db, actor) =>
      idempotent(db, actor.companyId, "supplier_invoice", idempotencyKey(req), async () => {
        const s = (await db.query(`select payment_terms_days from suppliers where id = $1`, [input.supplierId])).rows[0];
        if (!s) throw notFound("Tedarikçi");
        const dup = await db.query(`select code from supplier_invoices where supplier_id = $1 and invoice_no = $2`, [input.supplierId, input.invoiceNo]);
        if (dup.rows[0]) throw conflict("duplicate_invoice", `Bu tedarikçinin ${input.invoiceNo} numaralı faturası zaten kayıtlı (${dup.rows[0].code})`);
        const due = input.dueDate ?? new Date(Date.parse(`${input.invoiceDate}T00:00:00Z`) + s.payment_terms_days * 864e5).toISOString().slice(0, 10);
        if (due < input.invoiceDate) throw badRequest("Vade fatura tarihinden önce olamaz");
        const net = Number(input.netAmount), tax = Number(input.taxAmount);
        const id = randomUUID();
        const lines = input.lines.map((l, i) => ({ lineNo: i + 1, poLineId: l.poLineId ?? null, qty: Number(l.qty), unitPrice: Number(l.unitPrice), amount: Number(l.amount) }));
        const m = await match(db, { id, supplierId: input.supplierId, currency: input.currency, netAmount: net }, lines);
        const code = await nextCode(db, actor.companyId, "supplier_invoice", "TF");
        const status = m.matched ? "approved" : "variance";
        await db.query(
          `insert into supplier_invoices (id, company_id, code, supplier_id, invoice_no, invoice_date, due_date, currency, net_amount, tax_amount, gross_amount, status, match_result, ap_policy_version, entered_by,
                                          decided_at, decision_note)
           values ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [id, code, input.supplierId, input.invoiceNo, input.invoiceDate, due, input.currency, net.toFixed(2), tax.toFixed(2), (net + tax).toFixed(2), status, JSON.stringify(m), m.policyVersion, actor.userId,
            m.matched ? new Date().toISOString() : null, m.matched ? "Otomatik: üç yönlü eşleşme tolerans içinde" : null],
        );
        for (const [i, l] of input.lines.entries()) {
          const item = l.poLineId ? (await db.query(`select item_id from purchase_order_lines where id = $1`, [l.poLineId])).rows[0]?.item_id ?? null : null;
          await db.query(
            `insert into supplier_invoice_lines (company_id, invoice_id, line_no, po_line_id, item_id, description, qty, unit_price, amount) values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
            [id, i + 1, l.poLineId ?? null, item, l.description ?? null, l.qty, l.unitPrice, l.amount],
          );
        }
        let costs = 0;
        if (m.matched) costs = await writeLotCosts(db, actor, id);
        else await openTask(db, actor.companyId, { kind: "invoice_variance", title: `Fatura farkı — ${code} (${input.invoiceNo})`, entityType: "supplier_invoice", entityId: id, assigneeRole: "accounting" });
        await recordEvent(db, actor, { entityType: "supplier_invoice", entityId: id, eventType: m.matched ? "matched" : "variance", after: { code, invoiceNo: input.invoiceNo, gross: (net + tax).toFixed(2), flags: [...m.headerFlags, ...m.lines.flatMap((l) => l.flags)].map((f) => f.code), lotCosts: costs } });
        return { ...(await loadInvoice(db, id)), lotCostsWritten: costs };
      }),
    );
  });

  app.get("/api/supplier-invoices", async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    return tenant(req, "invoice.view", async (db) => {
      const r = await db.query(
        `select si.id, si.code, si.invoice_no as "invoiceNo", s.name as "supplierName", si.invoice_date::text as "invoiceDate", si.due_date::text as "dueDate",
                si.currency, si.gross_amount as "grossAmount", si.status,
                coalesce((select sum(p.amount) from supplier_payments p where p.invoice_id = si.id), 0) as paid,
                (si.due_date < current_date and si.status in ('approved', 'variance', 'received')) as overdue
           from supplier_invoices si join suppliers s on s.id = si.supplier_id
          where ($1::text is null or si.status = $1) order by si.due_date, si.code limit 300`,
        [q.status ?? null],
      );
      return r.rows;
    });
  });

  app.get("/api/supplier-invoices/:id", async (req) => tenant(req, "invoice.view", (db) => loadInvoice(db, (req.params as { id: string }).id)));

  /** Fark kararı: onay veya ret. Faturayı giren kişi onaylayamaz (görev ayrılığı). */
  app.post("/api/supplier-invoices/:id/decision", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ decision: z.enum(["approve", "reject"]), note: z.string().min(10).max(1000) }), req.body);
    const c = ctxOf(req);
    return tenant(req, "invoice.approve", async (db, actor) => {
      const inv = (await db.query(`select status, entered_by, code from supplier_invoices where id = $1 for update`, [id])).rows[0];
      if (!inv) throw notFound("Fatura");
      if (inv.status !== "variance") throw conflict("invalid_transition", "Yalnızca farklı (onay bekleyen) fatura için karar verilir");
      if (inv.entered_by === c.userId) throw conflict("segregation_of_duties", "Faturayı giren kişi fark onayı veremez");
      const to = input.decision === "approve" ? "approved" : "rejected";
      await db.query(`update supplier_invoices set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`, [id, to, actor.userId, input.note]);
      await closeTasks(db, actor.companyId, "invoice_variance", id);
      const costs = to === "approved" ? await writeLotCosts(db, actor, id) : 0;
      await recordEvent(db, actor, { entityType: "supplier_invoice", entityId: id, eventType: `decision.${input.decision}`, after: { lotCosts: costs }, reason: input.note });
      return { ...(await loadInvoice(db, id)), lotCostsWritten: costs };
    });
  });

  /** Dışarıda yapılmış ödemenin kaydı. Sistem ödeme yapmaz; tutar açık bakiyeyi aşamaz. */
  app.post("/api/supplier-invoices/:id/payments", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ amount: Amt, paidOn: Day, reference: z.string().trim().min(3).max(120) }), req.body);
    return tenant(req, "payment.record", (db, actor) =>
      idempotent(db, actor.companyId, "supplier_payment", idempotencyKey(req), async () => {
        const inv = (await db.query(`select status, gross_amount, code from supplier_invoices where id = $1 for update`, [id])).rows[0];
        if (!inv) throw notFound("Fatura");
        if (inv.status !== "approved") throw conflict("not_payable", "Yalnızca onaylı (ödemeye hazır) faturaya ödeme kaydı girilir");
        const paid = Number((await db.query(`select coalesce(sum(amount), 0) as p from supplier_payments where invoice_id = $1`, [id])).rows[0].p);
        const open = round2(Number(inv.gross_amount) - paid);
        if (Number(input.amount) > open + 1e-9) throw conflict("overpayment", `Ödeme açık bakiyeyi (${open.toFixed(2)}) aşıyor`);
        await db.query(`insert into supplier_payments (company_id, invoice_id, amount, paid_on, reference, recorded_by) values (app_company_id(), $1, $2, $3, $4, $5)`, [id, input.amount, input.paidOn, input.reference, actor.userId]);
        if (Math.abs(open - Number(input.amount)) < 0.005) await db.query(`update supplier_invoices set status = 'paid' where id = $1`, [id]);
        await recordEvent(db, actor, { entityType: "supplier_invoice", entityId: id, eventType: "payment.recorded", after: { ...input, note: "Dışarıda yapılmış ödemenin kaydı; sistem ödeme başlatmaz" } });
        return loadInvoice(db, id);
      }),
    );
  });

  app.post("/api/supplier-invoices/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "invoice.manage", async (db, actor) => {
      const inv = (await db.query(`select status from supplier_invoices where id = $1 for update`, [id])).rows[0];
      if (!inv) throw notFound("Fatura");
      const paid = Number((await db.query(`select coalesce(sum(amount), 0) as p from supplier_payments where invoice_id = $1`, [id])).rows[0].p);
      if (paid > 0 || ["paid", "cancelled"].includes(inv.status)) throw conflict("invalid_transition", "Ödeme kaydı olan veya kapanmış fatura iptal edilemez");
      await db.query(`update supplier_invoices set status = 'cancelled', decision_note = coalesce(decision_note || ' / ', '') || $2 where id = $1`, [id, `İptal: ${input.reason}`]);
      await closeTasks(db, actor.companyId, "invoice_variance", id);
      await recordEvent(db, actor, { entityType: "supplier_invoice", entityId: id, eventType: "cancelled", reason: input.reason });
      return loadInvoice(db, id);
    });
  });

  /** Faturalanabilir sipariş satırları (kalite kabul edilmiş, henüz faturalanmamış miktar). */
  app.get("/api/payables/invoiceable", async (req) => {
    const q = z.object({ supplierId: z.string().uuid() }).parse(req.query);
    return tenant(req, "invoice.manage", async (db) => {
      const r = await db.query(
        `select * from (
           select l.id as "poLineId", l.po_code as "poCode", i.code as "itemCode", l.unit_price as "unitPrice", l.currency,
                  coalesce((select sum(x.accepted_qty) from inspections x join goods_receipt_lines grl on grl.id = x.receipt_line_id join goods_receipts gr on gr.id = grl.receipt_id where gr.po_line_id = l.id), 0) as accepted,
                  coalesce((select sum(il.qty) from supplier_invoice_lines il join supplier_invoices si on si.id = il.invoice_id where il.po_line_id = l.id and si.status not in ('rejected', 'cancelled')), 0) as invoiced
             from purchase_order_lines l join items i on i.id = l.item_id where l.supplier_id = $1 and l.status <> 'cancelled') x
          where accepted > invoiced order by "poCode"`,
        [q.supplierId],
      );
      return r.rows.map((x) => ({ ...x, invoiceableQty: (Number(x.accepted) - Number(x.invoiced)).toString() }));
    });
  });

  /** Vade yaşlandırma ve 8 haftalık ödeme planı (para birimi bazında). Ödeme başlatmaz. */
  app.get("/api/payables/aging", async (req) =>
    tenant(req, "invoice.view", async (db) => {
      const r = await db.query(
        `with open as (
           select si.currency, si.due_date, si.status, si.gross_amount - coalesce((select sum(p.amount) from supplier_payments p where p.invoice_id = si.id), 0) as open
             from supplier_invoices si where si.status in ('approved', 'variance', 'received'))
         select currency,
                sum(open) filter (where due_date < current_date - 60) as "over60",
                sum(open) filter (where due_date between current_date - 60 and current_date - 31) as "over31",
                sum(open) filter (where due_date between current_date - 30 and current_date - 1) as "over1",
                sum(open) filter (where due_date between current_date and current_date + 7) as "due7",
                sum(open) filter (where due_date between current_date + 8 and current_date + 30) as "due30",
                sum(open) filter (where due_date > current_date + 30) as later,
                sum(open) filter (where status = 'variance') as "onHold",
                sum(open) as total
           from open group by currency order by currency`,
      );
      const weeks = await db.query(
        `select currency, to_char(date_trunc('week', greatest(due_date, current_date)), 'YYYY-MM-DD') as week, sum(open)::numeric(18,2) as amount
           from (select si.currency, si.due_date, si.gross_amount - coalesce((select sum(p.amount) from supplier_payments p where p.invoice_id = si.id), 0) as open
                   from supplier_invoices si where si.status = 'approved') x
          where due_date < current_date + 56 group by 1, 2 order by 2, 1`,
      );
      return { buckets: r.rows, plan: weeks.rows, note: "Onay bekleyen (farklı) faturalar planda yer almaz; gecikmiş olanlar bu haftaya yazılır." };
    }),
  );
}

export { match };
