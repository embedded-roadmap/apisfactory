import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { closeTasks, enqueue, idempotent, nextCode, openTask, recordEvent, type Actor } from "../lib/records";
import { can, idempotencyKey, parse, tenant } from "../http/context";

/**
 * W18 — Tedarikçi, teklif talebi (RFQ) ve teklif karşılaştırma, satın alma siparişi, tedarikçi teyidi ve gecikme.
 *  - Onaylı satın alma talebinden RFQ açılır; teklifler elle (veya test bağlayıcısıyla) girilir.
 *  - Seçim gerekçelidir: en ucuz/en hızlı olmayan teklif veya son lot maliyetinden %20+ sapma gerekçe ister.
 *  - Sipariş tedarikçiye GÖNDERİLMEZ: "gönder" test modundaki çıkış kutusuna yazar (prompt: gerçek sipariş yok).
 *  - Teyit değişmez kayıttır; tarih kayması bağlı üretim ihtiyacı/siparişe etkisini döner ve görev açar.
 *  - Takip taraması: teyitsiz (gönderimden 3 gün sonra) ve gecikmiş (teyit tarihi geçmiş, eksik teslim) satırlar.
 */

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Money = z.string().regex(/^\d+(\.\d{1,6})?$/);
const Cur = z.string().regex(/^[A-Z]{3}$/);
const PRICE_DEVIATION = 0.2;
const UNCONFIRMED_DAYS = 3;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

async function lastCost(db: Db, itemId: string) {
  const r = await db.query(
    `select lc.unit_cost, lc.currency from lot_costs lc join lots lo on lo.id = lc.lot_id where lo.item_id = $1 order by lc.id desc limit 1`,
    [itemId],
  );
  return r.rows[0] ? { unitCost: Number(r.rows[0].unit_cost), currency: r.rows[0].currency as string } : null;
}

async function loadRfq(db: Db, id: string, showPrice: boolean) {
  const r = await db.query(
    `select r.id, r.code, r.status, r.qty, r.need_date::text as "needDate", r.note, r.award_reason as "awardReason", r.awarded_quote_id as "awardedQuoteId",
            r.purchase_request_id as "purchaseRequestId", pr.code as "prCode", i.id as "itemId", i.code as "itemCode", i.name as "itemName", i.mpn,
            r.created_at as "createdAt", u.name as "createdBy"
       from rfqs r join items i on i.id = r.item_id left join purchase_requests pr on pr.id = r.purchase_request_id left join users u on u.id = r.created_by
      where r.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw notFound("Teklif talebi");
  const rfq = r.rows[0];
  const q = await db.query(
    `select q.id, q.supplier_id as "supplierId", s.code as "supplierCode", s.name as "supplierName", s.status as "supplierStatus",
            q.unit_price as "unitPrice", q.currency, q.lead_time_days as "leadTimeDays", q.moq, q.valid_until::text as "validUntil", q.note, q.source,
            q.created_at as "createdAt", u.name as "enteredBy"
       from rfq_quotes q join suppliers s on s.id = q.supplier_id left join users u on u.id = q.entered_by where q.rfq_id = $1 order by q.unit_price, q.lead_time_days`,
    [id],
  );
  const today = iso(new Date());
  const cost = await lastCost(db, rfq.itemId);
  const quotes = q.rows.map((x) => {
    const total = Number(x.unitPrice) * Math.max(Number(rfq.qty), Number(x.moq ?? 0));
    const readyDate = addDays(today, x.leadTimeDays);
    const deviation = cost && cost.currency === x.currency && cost.unitCost > 0 ? (Number(x.unitPrice) - cost.unitCost) / cost.unitCost : null;
    return {
      ...x,
      unitPrice: showPrice ? x.unitPrice : null,
      total: showPrice ? total.toFixed(2) : null,
      readyDate,
      meetsNeedDate: rfq.needDate ? readyDate <= rfq.needDate : null,
      expired: x.validUntil ? x.validUntil < today : false,
      moqAbove: x.moq ? Number(x.moq) > Number(rfq.qty) : false,
      deviationPct: showPrice && deviation !== null ? Math.round(deviation * 1000) / 10 : null,
    };
  });
  const valid = quotes.filter((x) => !x.expired && x.supplierStatus === "active");
  const cheapest = valid.length ? valid.reduce((a, b) => (Number(a.total ?? a.unitPrice) <= Number(b.total ?? b.unitPrice) ? a : b)).id : null;
  const fastest = valid.length ? valid.reduce((a, b) => (a.leadTimeDays <= b.leadTimeDays ? a : b)).id : null;
  return { ...rfq, lastCost: showPrice ? cost : null, quotes: quotes.map((x) => ({ ...x, cheapest: x.id === cheapest, fastest: x.id === fastest })) };
}

async function loadPo(db: Db, id: string, showPrice: boolean) {
  const p = await db.query(
    `select po.id, po.code, po.status, po.currency, po.send_mode as "sendMode", po.sent_at as "sentAt", su.name as "sentBy", po.cancel_reason as "cancelReason",
            po.created_at as "createdAt", cu.name as "createdBy", s.id as "supplierId", s.code as "supplierCode", s.name as "supplierName", s.contact_email as "supplierEmail"
       from purchase_orders po join suppliers s on s.id = po.supplier_id left join users su on su.id = po.sent_by left join users cu on cu.id = po.created_by
      where po.id = $1`,
    [id],
  );
  if (!p.rows[0]) throw notFound("Satın alma siparişi");
  const lines = await db.query(
    `select l.id, i.code as "itemCode", i.name as "itemName", i.mpn, l.qty_ordered as "qtyOrdered", l.qty_received as "qtyReceived", l.unit_price as "unitPrice",
            l.requested_date::text as "requestedDate", l.confirmed_date::text as "confirmedDate", l.status, pr.code as "prCode",
            (l.confirmed_date is not null and l.confirmed_date < current_date and l.qty_received < l.qty_ordered and l.status = 'open') as overdue,
            coalesce((select json_agg(json_build_object('date', c.confirmed_date, 'qty', c.confirmed_qty, 'previousDate', c.previous_date, 'slipDays', c.slip_days,
                      'reference', c.supplier_reference, 'source', c.source, 'note', c.note, 'by', u.name, 'at', c.created_at) order by c.created_at)
                      from po_confirmations c left join users u on u.id = c.entered_by where c.po_line_id = l.id), '[]') as confirmations
       from purchase_order_lines l join items i on i.id = l.item_id left join purchase_requests pr on pr.id = l.purchase_request_id
      where l.po_id = $1 order by i.code`,
    [id],
  );
  const rows = lines.rows.map((l) => ({ ...l, unitPrice: showPrice ? l.unitPrice : null }));
  const total = showPrice ? rows.reduce((a, l) => a + Number(l.unitPrice ?? 0) * Number(l.qtyOrdered), 0).toFixed(2) : null;
  return { ...p.rows[0], lines: rows, total };
}

/** Teyit tarihinin kaymasından etkilenen üretim ihtiyaçları ve satış siparişleri. */
async function lineImpact(db: Db, lineId: string, newDate: string) {
  const r = await db.query(
    `select distinct so.id as "orderId", so.code as "orderCode", so.promised_date::text as "promisedDate", so.requested_date::text as "requestedDate", c.name as customer
       from purchase_order_lines l
       left join purchase_allocations a on a.po_line_id = l.id
       left join purchase_requests pr on pr.id = l.purchase_request_id and pr.source_type = 'production_need'
       join production_needs pn on pn.id = coalesce(a.production_need_id, pr.source_id)
       join sales_order_lines sol on sol.id = pn.sales_order_line_id join sales_orders so on so.id = sol.order_id join customers c on c.id = so.customer_id
      where l.id = $1 and so.status <> 'cancelled'`,
    [lineId],
  );
  return r.rows.map((o) => ({ ...o, atRisk: newDate >= (o.promisedDate ?? o.requestedDate) }));
}

/** PO başlık durumu satırlardan türetilir. */
async function refreshPoStatus(db: Db, poId: string) {
  const s = (await db.query(`select status from purchase_orders where id = $1`, [poId])).rows[0]?.status;
  if (!s || ["draft", "cancelled"].includes(s)) return;
  const l = (await db.query(
    `select count(*)::int as n, count(*) filter (where qty_received >= qty_ordered)::int as full, count(*) filter (where qty_received > 0)::int as some,
            count(*) filter (where confirmed_date is not null)::int as conf
       from purchase_order_lines where po_id = $1 and status <> 'cancelled'`,
    [poId],
  )).rows[0];
  const next = l.full === l.n ? "received" : l.some > 0 ? "partially_received" : l.conf === l.n ? "confirmed" : "sent";
  if (next !== s) await db.query(`update purchase_orders set status = $2 where id = $1`, [poId, next]);
  if (next === "received") await db.query(`update purchase_order_lines set status = 'closed' where po_id = $1 and status = 'open'`, [poId]);
}

/**
 * Takip taraması: gönderilip teyit edilmemiş (3 gün) ve teyit tarihi geçmiş eksik satırlar için satın almaya görev
 * ve (test modunda) tedarikçiye hatırlatma kaydı. Aynı satır için günde en fazla bir hatırlatma.
 */
export async function runPoFollowups(db: Db, actor: Actor) {
  const r = await db.query(
    `select l.id, po.id as po_id, po.code, s.name as supplier, i.code as item, l.confirmed_date::text as confirmed,
            case when l.confirmed_date is null then 'unconfirmed' else 'overdue' end as reason
       from purchase_order_lines l join purchase_orders po on po.id = l.po_id join suppliers s on s.id = po.supplier_id join items i on i.id = l.item_id
      where l.status = 'open' and po.status in ('sent', 'confirmed', 'partially_received') and l.qty_received < l.qty_ordered
        and ((l.confirmed_date is null and po.sent_at < now() - make_interval(days => $1)) or (l.confirmed_date < current_date))
        and (l.last_followup_at is null or l.last_followup_at < now() - interval '1 day')
      for update of l skip locked`,
    [UNCONFIRMED_DAYS],
  );
  for (const x of r.rows) {
    await db.query(`update purchase_order_lines set last_followup_at = now() where id = $1`, [x.id]);
    await openTask(db, actor.companyId, {
      kind: "po_followup",
      title: x.reason === "unconfirmed" ? `Tedarikçi teyidi yok — ${x.code} ${x.item} (${x.supplier})` : `Teslim gecikti — ${x.code} ${x.item} (teyit ${x.confirmed})`,
      entityType: "purchase_order", entityId: x.po_id, assigneeRole: "purchasing",
    });
    await enqueue(db, actor.companyId, "supplier.reminder", { poId: x.po_id, lineId: x.id, reason: x.reason, mode: "test" });
    await recordEvent(db, { ...actor, kind: "automation" }, { entityType: "purchase_order", entityId: x.po_id, eventType: `followup.${x.reason}`, after: { lineId: x.id, item: x.item } });
  }
  return r.rowCount ?? 0;
}

export async function procurementRoutes(app: FastifyInstance) {
  // ---- Tedarikçiler -------------------------------------------------------------------------
  app.get("/api/suppliers", async (req) =>
    tenant(req, "purchase.view", async (db) => {
      const r = await db.query(
        `select s.id, s.code, s.name, s.contact_email as "contactEmail", s.default_lead_time_days as "defaultLeadTimeDays", s.payment_terms_days as "paymentTermsDays", s.status, s.blocked_reason as "blockedReason", s.note,
                (select count(*) from purchase_order_lines l where l.supplier_id = s.id)::int as "lineCount",
                (select count(*) from purchase_order_lines l where l.supplier_id = s.id and l.status <> 'cancelled' and l.qty_received >= l.qty_ordered)::int as "deliveredLines",
                (select count(*) from purchase_order_lines l where l.supplier_id = s.id and l.status = 'open' and l.confirmed_date < current_date and l.qty_received < l.qty_ordered)::int as "overdueLines",
                (select round(avg(c.slip_days)::numeric, 1) from po_confirmations c join purchase_order_lines l on l.id = c.po_line_id where l.supplier_id = s.id and c.slip_days is not null) as "avgSlipDays"
           from suppliers s order by s.code`,
      );
      return r.rows;
    }),
  );

  app.post("/api/suppliers", async (req) => {
    const input = parse(z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{2,30}$/), name: z.string().min(2).max(200), contactEmail: z.string().email().optional(), defaultLeadTimeDays: z.number().int().min(0).max(365).optional(), paymentTermsDays: z.number().int().min(0).max(365).optional(), note: z.string().max(1000).optional() }), req.body);
    return tenant(req, "supplier.manage", async (db, actor) => {
      const r = await db.query(
        `insert into suppliers (company_id, code, name, contact_email, default_lead_time_days, note, payment_terms_days) values (app_company_id(), $1, $2, $3, $4, $5, coalesce($6, 30)) returning id`,
        [input.code.toUpperCase(), input.name, input.contactEmail ?? null, input.defaultLeadTimeDays ?? null, input.note ?? null, input.paymentTermsDays ?? null],
      );
      await recordEvent(db, actor, { entityType: "supplier", entityId: r.rows[0].id, eventType: "created", after: input });
      return { id: r.rows[0].id as string };
    });
  });

  app.post("/api/suppliers/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ status: z.enum(["active", "blocked"]), reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "supplier.manage", async (db, actor) => {
      const r = await db.query(`update suppliers set status = $2, blocked_reason = case when $2 = 'blocked' then $3 else null end where id = $1 returning id`, [id, input.status, input.reason]);
      if (!r.rowCount) throw notFound("Tedarikçi");
      await recordEvent(db, actor, { entityType: "supplier", entityId: id, eventType: `status.${input.status}`, reason: input.reason });
      return { id, status: input.status };
    });
  });

  // ---- Teklif talebi ve teklifler -----------------------------------------------------------
  app.get("/api/rfqs", async (req) =>
    tenant(req, "purchase.view", async (db) => {
      const r = await db.query(
        `select r.id, r.code, r.status, r.qty, r.need_date::text as "needDate", i.code as "itemCode", pr.code as "prCode",
                (select count(*) from rfq_quotes q where q.rfq_id = r.id)::int as quotes, r.created_at as "createdAt"
           from rfqs r join items i on i.id = r.item_id left join purchase_requests pr on pr.id = r.purchase_request_id
          order by (r.status = 'open') desc, r.created_at desc limit 200`,
      );
      return r.rows;
    }),
  );

  /** Onaylı satın alma talebinden (veya doğrudan kalemden) teklif talebi. */
  app.post("/api/rfqs", async (req) => {
    const input = parse(z.object({ purchaseRequestId: z.string().uuid().optional(), itemId: z.string().uuid().optional(), qty: z.string().regex(/^\d+(\.\d+)?$/).optional(), needDate: Day.optional(), note: z.string().max(1000).optional() }), req.body);
    return tenant(req, "purchase.order.manage", (db, actor) =>
      idempotent(db, actor.companyId, "rfq_create", idempotencyKey(req), async () => {
        let itemId = input.itemId, qty = input.qty, needDate = input.needDate ?? null;
        if (input.purchaseRequestId) {
          const pr = (await db.query(`select item_id, qty, need_date::text as need, status from purchase_requests where id = $1 for update`, [input.purchaseRequestId])).rows[0];
          if (!pr) throw notFound("Satın alma talebi");
          if (pr.status !== "approved") throw conflict("pr_not_approved", "Yalnızca onaylı satın alma talebinden teklif talebi açılır");
          itemId = pr.item_id; qty = qty ?? pr.qty; needDate = needDate ?? pr.need;
        }
        if (!itemId || !qty) throw badRequest("Kalem ve miktar gerekli");
        const code = await nextCode(db, actor.companyId, "rfq", "TT");
        const r = await db.query(
          `insert into rfqs (company_id, code, purchase_request_id, item_id, qty, need_date, note, created_by) values (app_company_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
          [code, input.purchaseRequestId ?? null, itemId, qty, needDate, input.note ?? null, actor.userId],
        ).catch((e) => { if (e.code === "23505") throw conflict("rfq_exists", "Bu talep için açık teklif talebi var"); throw e; });
        await recordEvent(db, actor, { entityType: "rfq", entityId: r.rows[0].id, eventType: "created", after: { code, ...input } });
        return loadRfq(db, r.rows[0].id, can(req, "field.cost.view"));
      }),
    );
  });

  app.get("/api/rfqs/:id", async (req) => tenant(req, "purchase.view", (db) => loadRfq(db, (req.params as { id: string }).id, can(req, "field.cost.view"))));

  /** Teklif girişi (tedarikçi başına bir teklif; yenisi eskisinin yerine geçer, olayda önceki değer saklanır). */
  app.post("/api/rfqs/:id/quotes", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({ supplierId: z.string().uuid(), unitPrice: Money, currency: Cur, leadTimeDays: z.number().int().min(0).max(365), moq: z.string().regex(/^\d+(\.\d+)?$/).optional(), validUntil: Day.optional(), note: z.string().max(1000).optional() }),
      req.body,
    );
    return tenant(req, "purchase.order.manage", async (db, actor) => {
      const r = (await db.query(`select status from rfqs where id = $1 for update`, [id])).rows[0];
      if (!r) throw notFound("Teklif talebi");
      if (r.status !== "open") throw conflict("rfq_closed", "Teklif talebi kapalı");
      const s = (await db.query(`select status from suppliers where id = $1`, [input.supplierId])).rows[0];
      if (!s) throw notFound("Tedarikçi");
      if (s.status !== "active") throw conflict("supplier_blocked", "Tedarikçi bloke; teklif alınamaz");
      const prev = (await db.query(`select unit_price, currency, lead_time_days from rfq_quotes where rfq_id = $1 and supplier_id = $2`, [id, input.supplierId])).rows[0];
      await db.query(
        `insert into rfq_quotes (company_id, rfq_id, supplier_id, unit_price, currency, lead_time_days, moq, valid_until, note, entered_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (rfq_id, supplier_id) do update set unit_price = excluded.unit_price, currency = excluded.currency, lead_time_days = excluded.lead_time_days,
           moq = excluded.moq, valid_until = excluded.valid_until, note = excluded.note, entered_by = excluded.entered_by, created_at = now()`,
        [id, input.supplierId, input.unitPrice, input.currency, input.leadTimeDays, input.moq ?? null, input.validUntil ?? null, input.note ?? null, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "rfq", entityId: id, eventType: prev ? "quote.updated" : "quote.added", before: prev ?? undefined, after: input });
      return loadRfq(db, id, can(req, "field.cost.view"));
    });
  });

  /**
   * Teklif seçimi → taslak satın alma siparişi. En ucuz ya da en hızlı olmayan, ihtiyaç tarihini karşılamayan,
   * süresi geçmiş veya son maliyetten %20+ sapan teklif gerekçe ister. Talep "siparişe dönüştü" olur.
   */
  app.post("/api/rfqs/:id/award", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ quoteId: z.string().uuid(), reason: z.string().max(1000).optional() }), req.body);
    return tenant(req, "purchase.order.manage", (db, actor) =>
      idempotent(db, actor.companyId, "rfq_award", idempotencyKey(req), async () => {
        const rfq = await loadRfq(db, id, true);
        if (rfq.status !== "open") throw conflict("rfq_closed", "Teklif talebi kapalı");
        const q = rfq.quotes.find((x: { id: string }) => x.id === input.quoteId) as any;
        if (!q) throw notFound("Teklif");
        if (q.supplierStatus !== "active") throw conflict("supplier_blocked", "Tedarikçi bloke");
        const needs: string[] = [];
        if (!q.cheapest) needs.push("en düşük toplam fiyatlı teklif değil");
        if (q.meetsNeedDate === false) needs.push(`ihtiyaç tarihini karşılamıyor (hazır ${q.readyDate})`);
        if (q.expired) needs.push("teklif geçerlilik süresi dolmuş");
        if (q.deviationPct !== null && Math.abs(q.deviationPct) >= PRICE_DEVIATION * 100) needs.push(`son lot maliyetinden %${q.deviationPct} sapma`);
        if (needs.length && (!input.reason || input.reason.trim().length < 10)) {
          throw conflict("award_reason_required", `Gerekçe gerekli: ${needs.join("; ")}`, { reasons: needs });
        }
        const qty = q.moq && Number(q.moq) > Number(rfq.qty) ? q.moq : rfq.qty;
        const code = await nextCode(db, actor.companyId, "purchase_order", "SAS");
        const po = await db.query(
          `insert into purchase_orders (company_id, code, supplier_id, currency, created_by) values (app_company_id(), $1, $2, $3, $4) returning id`,
          [code, q.supplierId, q.currency, actor.userId],
        );
        await db.query(
          `insert into purchase_order_lines (company_id, po_code, supplier_name, supplier_id, item_id, qty_ordered, po_id, unit_price, currency, requested_date, purchase_request_id, quote_id)
           values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [code, q.supplierName, q.supplierId, rfq.itemId, qty, po.rows[0].id, q.unitPrice, q.currency, rfq.needDate, rfq.purchaseRequestId, q.id],
        );
        await db.query(`update rfqs set status = 'awarded', awarded_quote_id = $2, award_reason = $3 where id = $1`, [id, q.id, input.reason ?? null]);
        if (rfq.purchaseRequestId) {
          await db.query(`update purchase_requests set status = 'converted' where id = $1`, [rfq.purchaseRequestId]);
          await recordEvent(db, actor, { entityType: "purchase_request", entityId: rfq.purchaseRequestId, eventType: "converted", after: { poCode: code } });
        }
        await recordEvent(db, actor, { entityType: "rfq", entityId: id, eventType: "awarded", after: { quoteId: q.id, supplier: q.supplierName, unitPrice: q.unitPrice, poCode: code, flags: needs }, reason: input.reason });
        await recordEvent(db, actor, { entityType: "purchase_order", entityId: po.rows[0].id, eventType: "created", after: { code, rfq: rfq.code, qty } });
        return { poId: po.rows[0].id as string, poCode: code, flags: needs };
      }),
    );
  });

  app.post("/api/rfqs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "purchase.order.manage", async (db, actor) => {
      const r = await db.query(`update rfqs set status = 'cancelled' where id = $1 and status = 'open' returning id`, [id]);
      if (!r.rowCount) throw conflict("invalid_transition", "Yalnızca açık teklif talebi iptal edilir");
      await recordEvent(db, actor, { entityType: "rfq", entityId: id, eventType: "cancelled", reason: input.reason });
      return { id, status: "cancelled" };
    });
  });

  // ---- Satın alma siparişi -------------------------------------------------------------------
  app.get("/api/purchase-orders", async (req) =>
    tenant(req, "purchase.view", async (db) => {
      const r = await db.query(
        `select po.id, po.code, po.status, s.name as "supplierName", po.sent_at as "sentAt", po.created_at as "createdAt",
                (select count(*) from purchase_order_lines l where l.po_id = po.id)::int as lines,
                (select min(l.confirmed_date)::text from purchase_order_lines l where l.po_id = po.id and l.status = 'open') as "nextDate",
                (select count(*) from purchase_order_lines l where l.po_id = po.id and l.status = 'open' and l.confirmed_date < current_date and l.qty_received < l.qty_ordered)::int as overdue,
                (select count(*) from purchase_order_lines l where l.po_id = po.id and l.status = 'open' and l.confirmed_date is null)::int as unconfirmed
           from purchase_orders po join suppliers s on s.id = po.supplier_id order by po.created_at desc limit 200`,
      );
      return r.rows;
    }),
  );

  app.get("/api/purchase-orders/:id", async (req) => tenant(req, "purchase.view", (db) => loadPo(db, (req.params as { id: string }).id, can(req, "field.cost.view"))));

  /** "Gönder": tedarikçiye gerçek gönderim YOK; çıkış kutusuna test modunda yazılır ve sipariş "gönderildi" olur. */
  app.post("/api/purchase-orders/:id/send", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "purchase.order.manage", async (db, actor) => {
      const po = (await db.query(`select status, code, supplier_id from purchase_orders where id = $1 for update`, [id])).rows[0];
      if (!po) throw notFound("Satın alma siparişi");
      if (po.status !== "draft") throw conflict("invalid_transition", "Yalnızca taslak sipariş gönderilir");
      const s = (await db.query(`select status from suppliers where id = $1`, [po.supplier_id])).rows[0];
      if (s.status !== "active") throw conflict("supplier_blocked", "Tedarikçi bloke; sipariş gönderilemez");
      await db.query(`update purchase_orders set status = 'sent', sent_at = now(), sent_by = $2 where id = $1`, [id, actor.userId]);
      await enqueue(db, actor.companyId, "supplier.po_send", { poId: id, code: po.code, mode: "test" });
      await recordEvent(db, actor, { entityType: "purchase_order", entityId: id, eventType: "sent", after: { mode: "test", note: "Tedarikçiye gerçek gönderim yapılmadı (test bağlayıcısı)" } });
      return loadPo(db, id, can(req, "field.cost.view"));
    });
  });

  /**
   * Tedarikçi teyidi (elle veya test bağlayıcısından). Değişmez kayıt; önceki teyide göre kayma günü hesaplanır.
   * Kayma varsa bağlı satış siparişleri etkisi döner, satış ve üretime görev açılır.
   */
  app.post("/api/purchase-orders/:id/lines/:lineId/confirm", async (req) => {
    const { id, lineId } = req.params as { id: string; lineId: string };
    const input = parse(z.object({ confirmedDate: Day, confirmedQty: z.string().regex(/^\d+(\.\d+)?$/).optional(), supplierReference: z.string().max(120).optional(), note: z.string().max(1000).optional(), source: z.enum(["manual", "test_connector"]).default("manual") }), req.body);
    return tenant(req, "purchase.order.manage", async (db, actor) => {
      const po = (await db.query(`select status, code from purchase_orders where id = $1 for update`, [id])).rows[0];
      if (!po) throw notFound("Satın alma siparişi");
      if (!["sent", "confirmed", "partially_received"].includes(po.status)) throw conflict("invalid_transition", "Teyit için sipariş gönderilmiş olmalı");
      const l = (await db.query(`select id, confirmed_date::text as cd, requested_date::text as rd, qty_ordered, status, item_id from purchase_order_lines where id = $1 and po_id = $2 for update`, [lineId, id])).rows[0];
      if (!l) throw notFound("Sipariş satırı");
      if (l.status !== "open") throw conflict("invalid_transition", "Satır kapalı");
      const base = l.cd ?? l.rd;
      const slip = base ? diffDays(input.confirmedDate, base) : null;
      if (l.cd && slip !== null && slip > 0 && (!input.note || input.note.length < 3)) throw conflict("reason_required", "Teyit tarihi ileri kaydı; tedarikçinin açıklaması (not) zorunlu");
      await db.query(
        `insert into po_confirmations (company_id, po_line_id, confirmed_date, confirmed_qty, previous_date, slip_days, supplier_reference, source, note, entered_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [lineId, input.confirmedDate, input.confirmedQty ?? l.qty_ordered, l.cd, slip, input.supplierReference ?? null, input.source, input.note ?? null, actor.userId],
      );
      await db.query(`update purchase_order_lines set confirmed_date = $2 where id = $1`, [lineId, input.confirmedDate]);
      await refreshPoStatus(db, id);
      await closeTasks(db, actor.companyId, "po_followup", id);
      let impact: { orderId: string; orderCode: string; customer: string; atRisk: boolean }[] = [];
      if (slip !== null && slip > 0) {
        impact = await lineImpact(db, lineId, input.confirmedDate);
        for (const o of impact.filter((x) => x.atRisk)) {
          await openTask(db, actor.companyId, { kind: "supplier_delay", title: `Tedarikçi gecikmesi ${po.code}: sipariş ${o.orderCode} (${o.customer}) terminini etkileyebilir`, entityType: "sales_order", entityId: o.orderId, assigneeRole: "sales" });
          await openTask(db, actor.companyId, { kind: "supplier_delay", title: `Tedarikçi gecikmesi ${po.code}: ${o.orderCode} üretim planı`, entityType: "sales_order", entityId: o.orderId, assigneeRole: "production" });
        }
      }
      await recordEvent(db, actor, {
        entityType: "purchase_order", entityId: id, eventType: slip && slip > 0 ? "confirmation.slipped" : "confirmation",
        before: { confirmedDate: l.cd }, after: { lineId, ...input, slipDays: slip, impactedOrders: impact.map((o) => o.orderCode) }, reason: input.note,
      });
      return { ...(await loadPo(db, id, can(req, "field.cost.view"))), slipDays: slip, impact };
    });
  });

  app.post("/api/purchase-orders/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "purchase.order.manage", async (db, actor) => {
      const po = (await db.query(`select status from purchase_orders where id = $1 for update`, [id])).rows[0];
      if (!po) throw notFound("Satın alma siparişi");
      if (!["draft", "sent", "confirmed"].includes(po.status)) throw conflict("invalid_transition", "Teslim alınmaya başlanmış sipariş iptal edilemez");
      const alloc = await db.query(`select count(*)::int as n from purchase_allocations a join purchase_order_lines l on l.id = a.po_line_id where l.po_id = $1`, [id]);
      if (alloc.rows[0].n) throw conflict("allocated", "Sipariş satırı bir üretim ihtiyacına ayrılmış; önce ayırma kaldırılmalı");
      await db.query(`update purchase_orders set status = 'cancelled', cancel_reason = $2 where id = $1`, [id, input.reason]);
      await db.query(`update purchase_order_lines set status = 'cancelled' where po_id = $1`, [id]);
      if (po.status !== "draft") await enqueue(db, actor.companyId, "supplier.po_cancel", { poId: id, mode: "test" });
      await recordEvent(db, actor, { entityType: "purchase_order", entityId: id, eventType: "cancelled", reason: input.reason });
      return loadPo(db, id, can(req, "field.cost.view"));
    });
  });

  /** Mal kabul için açık sipariş satırları (fiyatsız; depo rolü satın alma ekranını görmeden satıra bağlar). */
  app.get("/api/receiving/open-po-lines", async (req) =>
    tenant(req, "inventory.receive", async (db) => {
      const r = await db.query(
        `select l.id, l.po_code as "poCode", coalesce(s.name, l.supplier_name) as "supplierName", l.item_id as "itemId", i.code as "itemCode", i.mpn,
                l.qty_ordered - l.qty_received as "openQty", l.confirmed_date::text as "confirmedDate"
           from purchase_order_lines l join items i on i.id = l.item_id left join suppliers s on s.id = l.supplier_id left join purchase_orders po on po.id = l.po_id
          where l.status = 'open' and l.qty_received < l.qty_ordered and (po.id is null or po.status in ('sent', 'confirmed', 'partially_received'))
          order by l.confirmed_date nulls last, l.po_code`,
      );
      return r.rows;
    }),
  );

  /** Takip panosu: teyitsiz, gecikmiş ve bu hafta beklenen satırlar. */
  app.get("/api/purchasing/followups", async (req) =>
    tenant(req, "purchase.view", async (db) => {
      const r = await db.query(
        `select l.id as "lineId", po.id as "poId", po.code as "poCode", s.name as "supplierName", i.code as "itemCode", l.qty_ordered as "qtyOrdered", l.qty_received as "qtyReceived",
                l.requested_date::text as "requestedDate", l.confirmed_date::text as "confirmedDate", po.sent_at as "sentAt",
                case when l.confirmed_date is null then 'unconfirmed' when l.confirmed_date < current_date then 'overdue' else 'due_soon' end as state,
                case when l.confirmed_date < current_date then current_date - l.confirmed_date end as "daysLate"
           from purchase_order_lines l join purchase_orders po on po.id = l.po_id join suppliers s on s.id = po.supplier_id join items i on i.id = l.item_id
          where l.status = 'open' and po.status in ('sent', 'confirmed', 'partially_received') and l.qty_received < l.qty_ordered
            and (l.confirmed_date is null or l.confirmed_date < current_date + 7)
          order by (l.confirmed_date < current_date) desc nulls first, l.confirmed_date nulls first`,
      );
      return r.rows;
    }),
  );

  app.post("/api/purchasing/followups/run", async (req) =>
    tenant(req, "purchase.order.manage", async (db, actor) => ({ followups: await runPoFollowups(db, actor) })),
  );
}

export { refreshPoStatus };
