import type { FastifyInstance } from "fastify";
import { USABLE_LOCATION_TYPES } from "@apisfactory/shared";
import { z } from "zod";
import type { Db } from "../db/pool";
import { conflict, notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { fromMicro, max, min, mul, toMicro } from "../lib/decimal";
import { parse, tenant } from "../http/context";
import { DEFAULT_ROUTE } from "./production";

const USABLE = USABLE_LOCATION_TYPES as readonly string[];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Takvim: hafta sonu ve şirket tatilleri çalışma günü sayılmaz.
// ---------------------------------------------------------------------------
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parseDay = (s: string) => new Date(`${s}T00:00:00Z`);
function addCalendarDays(s: string, n: number) {
  const d = parseDay(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
export function isWorkingDay(s: string, holidays: Set<string>) {
  const wd = parseDay(s).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.has(s);
}
/** İlk çalışma gününe ileri al. */
export function nextWorkingDay(s: string, holidays: Set<string>) {
  let d = s;
  while (!isWorkingDay(d, holidays)) d = addCalendarDays(d, 1);
  return d;
}
/** `start` çalışma gününde başlayan `n` çalışma günlük işin bittiği gün (n ≥ 1). */
export function finishAfterWorkingDays(start: string, n: number, holidays: Set<string>) {
  let d = nextWorkingDay(start, holidays);
  for (let i = 1; i < n; i++) d = nextWorkingDay(addCalendarDays(d, 1), holidays);
  return d;
}

type Estimate = {
  computedAt: string;
  status: "ok" | "unknown";
  earliest: string | null;
  latest: string | null;
  materialReadyDate: string | null;
  productionDays: number;
  queueDays: number;
  bottleneck: string | null;
  reasons: string[];
  materials: { itemCode: string; requiredQty: string; source: string; readyDate: string | null }[];
  workCenters: { code: string; ownMinutes: number; queueMinutes: number; dailyMinutes: number }[];
  assumptions: string[];
};

/**
 * Tahmini termin (prompt §12): malzeme hazır olma tarihi + iş merkezi yükü.
 *  - Serbest stok → bugün; teyitli açık alım → teyit tarihi; kalan → bugün + kalem temin süresi.
 *    Temin süresi tanımsızsa termin "hesaplanamadı" döner (tahmin uydurulmaz).
 *  - Her iş merkezi için hazırlık + adet × birim süre, günlük kapasiteye bölünür; operasyonlar sıralıdır.
 *  - Aynı iş merkezlerindeki açık iş emirlerinin kalan yükü kuyruk olarak eklenir; sonuç aralık olarak verilir.
 * Tahmin müşteriye verilen tarihi değiştirmez; taahhüt ayrı kayıttır.
 */
export async function computeEstimate(db: Db, orderId: string, today = iso(new Date())): Promise<Estimate> {
  const o = await db.query(`select status, confirm_result from sales_orders where id = $1`, [orderId]);
  if (!o.rows[0]) throw notFound("Satış siparişi");
  const holidays = new Set<string>((await db.query(`select day::text as day from holidays`)).rows.map((r) => r.day));
  const lines = await db.query(
    `select l.id, l.qty, l.product_revision_id, pr.bom_version_id, p.item_id, p.code
       from sales_order_lines l join product_revisions pr on pr.id = l.product_revision_id join products p on p.id = pr.product_id
      where l.order_id = $1 order by l.line_no`,
    [orderId],
  );
  const reasons: string[] = [];
  const materials: Estimate["materials"] = [];
  let unknown = false;
  let materialReady = today;
  let produceQty = 0n;
  const firm = o.rows[0].status === "firm";
  const takenStock = new Map<string, bigint>();

  for (const l of lines.rows) {
    // Bitmiş ürün: kesin siparişte zaten rezervasyonla ayrılmıştır; taslakta serbest stoktan düşülür.
    let remaining = toMicro(l.qty);
    if (firm) {
      // Kesin siparişte kalan üretim, kapanmamış üretim ihtiyaçlarıdır; hazır/rezerve bitmiş ürün zaten düşülmüştür.
      const pn = await db.query(`select coalesce(sum(qty), 0) as q from production_needs where sales_order_line_id = $1 and status in ('planned', 'released')`, [l.id]);
      remaining = toMicro(pn.rows[0].q);
    } else {
      const fg = await db.query(
        `select coalesce((select sum(b.qty) from stock_balances b join locations loc on loc.id = b.location_id join lots lo on lo.id = b.lot_id
                           where b.item_id = $1 and lo.product_revision_id = $2 and loc.type = any($3)), 0) as usable,
                coalesce((select sum(qty) from reservations where item_id = $1 and status = 'active'), 0) as reserved`,
        [l.item_id, l.product_revision_id, USABLE],
      );
      const free = max(0n, toMicro(fg.rows[0].usable) - toMicro(fg.rows[0].reserved) - (takenStock.get(l.item_id) ?? 0n));
      const take = min(free, remaining);
      takenStock.set(l.item_id, (takenStock.get(l.item_id) ?? 0n) + take);
      remaining -= take;
    }
    if (remaining <= 0n) continue;
    produceQty += remaining;
    if (!l.bom_version_id) {
      unknown = true;
      reasons.push(`${l.code}: BOM sürümü yok`);
      continue;
    }

    const bom = await db.query(
      `select bl.item_id, i.code, i.lead_time_days, sum(bl.qty_per) as qty_per from bom_lines bl join items i on i.id = bl.item_id
        where bl.bom_version_id = $1 and not bl.dnp group by bl.item_id, i.code, i.lead_time_days order by i.code`,
      [l.bom_version_id],
    );
    const crLine = firm ? (o.rows[0].confirm_result?.lines ?? []).find((x: { lineId: string }) => x.lineId === l.id) : null;
    for (const m of bom.rows) {
      const gross = mul(remaining, toMicro(m.qty_per));
      let fromStock: bigint;
      let fromPo: bigint;
      let poDate: string | null = null;
      if (crLine) {
        // Kesin siparişte onayda yapılan ayırma esas alınır.
        const cm = crLine.materials.find((x: { itemId: string }) => x.itemId === m.item_id);
        fromStock = cm ? toMicro(cm.reservedQty) : 0n;
        fromPo = cm ? toMicro(cm.openPurchaseQty) : 0n;
        if (fromPo > 0n) {
          const d = await db.query(
            `select max(po.confirmed_date)::text as d from purchase_allocations a join purchase_order_lines po on po.id = a.po_line_id
               join production_needs pn on pn.id = a.production_need_id where pn.sales_order_line_id = $1 and po.item_id = $2`,
            [l.id, m.item_id],
          );
          poDate = d.rows[0].d;
        }
      } else {
        const fs = await db.query(
          `select coalesce((select sum(b.qty) from stock_balances b join locations loc on loc.id = b.location_id where b.item_id = $1 and loc.type = any($2)), 0) as usable,
                  coalesce((select sum(qty) from reservations where item_id = $1 and status = 'active'), 0) as reserved`,
          [m.item_id, USABLE],
        );
        const free = max(0n, toMicro(fs.rows[0].usable) - toMicro(fs.rows[0].reserved) - (takenStock.get(m.item_id) ?? 0n));
        fromStock = min(free, gross);
        takenStock.set(m.item_id, (takenStock.get(m.item_id) ?? 0n) + fromStock);
        fromPo = 0n;
        const pos = await db.query(
          `select po.confirmed_date::text as d, po.qty_ordered - po.qty_received - coalesce((select sum(a.qty) from purchase_allocations a where a.po_line_id = po.id), 0) as free
             from purchase_order_lines po where po.item_id = $1 and po.status = 'open' and po.confirmed_date is not null order by po.confirmed_date`,
          [m.item_id],
        );
        for (const po of pos.rows) {
          if (gross - fromStock - fromPo <= 0n) break;
          const t = min(toMicro(po.free), gross - fromStock - fromPo);
          if (t <= 0n) continue;
          fromPo += t;
          poDate = po.d;
        }
      }
      const rest = gross - fromStock - fromPo;
      let ready: string | null = today;
      let source = "stok";
      if (fromPo > 0n && poDate) {
        ready = poDate < today ? today : poDate;
        source = `teyitli alım (${poDate})`;
      }
      if (rest > 0n) {
        if (m.lead_time_days === null) {
          unknown = true;
          ready = null;
          source = "temin süresi tanımsız";
          reasons.push(`${m.code}: ${fromMicro(rest)} adet eksik ve temin süresi tanımlı değil`);
        } else {
          const d = addCalendarDays(today, m.lead_time_days);
          ready = ready && ready > d ? ready : d;
          source = `yeni alım (temin ${m.lead_time_days} gün)`;
        }
      }
      if (ready && ready > materialReady) materialReady = ready;
      materials.push({ itemCode: m.code, requiredQty: fromMicro(gross), source, readyDate: ready });
    }
  }

  // Kapasite: kendi işimiz + aynı merkezlerdeki açık işlerin kalan yükü.
  const wcs = await db.query(`select id, code, daily_minutes, setup_minutes, minutes_per_unit from work_centers`);
  const byCode = new Map(wcs.rows.map((w) => [w.code as string, w]));
  const qtyNum = Number(fromMicro(produceQty));
  const queue = await db.query(
    `select wc.code, sum(wc.setup_minutes + w.qty * wc.minutes_per_unit)::float8 as minutes
       from work_order_operations op join work_orders w on w.id = op.work_order_id join work_centers wc on wc.id = op.work_center_id
      where op.status <> 'done' and w.status in ('planned', 'released', 'in_progress', 'on_hold')
      group by wc.code`,
  );
  const queueBy = new Map(queue.rows.map((q) => [q.code as string, Number(q.minutes)]));
  const workCenters: Estimate["workCenters"] = [];
  let productionDays = 0;
  let queueDays = 0;
  let bottleneck: string | null = null;
  if (qtyNum > 0) {
    for (const op of DEFAULT_ROUTE) {
      const wc = byCode.get(op.wc);
      if (!wc) {
        unknown = true;
        reasons.push(`İş merkezi tanımlı değil: ${op.wc}`);
        continue;
      }
      const own = Number(wc.setup_minutes) + qtyNum * Number(wc.minutes_per_unit);
      const q = queueBy.get(op.wc) ?? 0;
      const daily = Number(wc.daily_minutes);
      productionDays += Math.max(1, Math.ceil(own / daily));
      const qd = Math.ceil(q / daily);
      if (qd > queueDays) {
        queueDays = qd;
        bottleneck = op.wc;
      }
      workCenters.push({ code: op.wc, ownMinutes: Math.round(own), queueMinutes: Math.round(q), dailyMinutes: daily });
    }
  }

  let earliest: string | null = null;
  let latest: string | null = null;
  if (!unknown) {
    const start = nextWorkingDay(materialReady, holidays);
    earliest = qtyNum > 0 ? finishAfterWorkingDays(start, productionDays, holidays) : start;
    latest = qtyNum > 0 ? finishAfterWorkingDays(start, productionDays + queueDays, holidays) : start;
  }
  return {
    computedAt: new Date().toISOString(),
    status: unknown ? "unknown" : "ok",
    earliest,
    latest,
    materialReadyDate: unknown ? null : materialReady,
    productionDays,
    queueDays,
    bottleneck,
    reasons,
    materials,
    workCenters,
    assumptions: [
      "Operasyonlar sıralı; bir operasyon en az bir çalışma günü sürer.",
      "Hafta sonu ve tanımlı tatiller çalışılmaz.",
      "Kuyruk: aynı iş merkezlerindeki açık iş emirlerinin kalan yükü; en yoğun merkez üst sınırı belirler.",
      "Yeni alımlarda tedarikçi temin süresi takvim günüdür.",
    ],
  };
}

export async function leadTimeRoutes(app: FastifyInstance) {
  app.post("/api/sales-orders/:id/estimate", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "sales.view", async (db, actor) => {
      const est = await computeEstimate(db, id);
      await db.query(`update sales_orders set estimate = $2 where id = $1`, [id, JSON.stringify(est)]);
      await recordEvent(db, actor, { entityType: "sales_order", entityId: id, eventType: "estimate.computed", after: { status: est.status, earliest: est.earliest, latest: est.latest, reasons: est.reasons } });
      return est;
    });
  });

  app.get("/api/sales-orders/:id/estimate", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "sales.view", async (db) => {
      const r = await db.query(`select estimate, promised_date::text as "promisedDate" from sales_orders where id = $1`, [id]);
      if (!r.rows[0]) throw notFound("Satış siparişi");
      return { estimate: r.rows[0].estimate, promisedDate: r.rows[0].promisedDate };
    });
  });

  /**
   * Müşteriye taahhüt tarihi. Tahminden önceki bir tarih yalnızca risk açıkça kabul edilerek verilir;
   * tahmin hesaplanamadıysa taahhüt de gerekçe ister. Değişiklik olay olarak kalır; müşteriye mesaj gönderilmez.
   */
  app.post("/api/sales-orders/:id/promise", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ date: z.string().regex(DATE), note: z.string().max(1000).optional(), acceptRisk: z.boolean().default(false) }), req.body);
    return tenant(req, "sales.promise", async (db, actor) => {
      const r = await db.query(`select status, estimate, promised_date::text as promised from sales_orders where id = $1 for update`, [id]);
      const so = r.rows[0];
      if (!so) throw notFound("Satış siparişi");
      if (so.status === "cancelled") throw conflict("invalid_transition", "İptal edilmiş siparişe tarih verilemez");
      const est = so.estimate as Estimate | null;
      if (!est) throw conflict("estimate_required", "Önce termin tahmini hesaplanmalı");
      const risky = est.status !== "ok" || (est.latest !== null && input.date < est.latest);
      if (risky && !input.acceptRisk) {
        throw conflict("promise_before_estimate", est.status === "ok" ? `Tahmini termin ${est.earliest} – ${est.latest}; daha erken tarih risk kabulü ister` : "Termin hesaplanamadı; tarih ancak risk kabulüyle verilir", {
          earliest: est.earliest,
          latest: est.latest,
        });
      }
      if (risky && !input.note) throw conflict("reason_required", "Riskli taahhüt için gerekçe zorunlu");
      await db.query(`update sales_orders set promised_date = $2 where id = $1`, [id, input.date]);
      await recordEvent(db, actor, {
        entityType: "sales_order", entityId: id, eventType: "promise.set", before: { promisedDate: so.promised },
        after: { promisedDate: input.date, risky, estimate: { earliest: est.earliest, latest: est.latest } }, reason: input.note,
      });
      return { id, promisedDate: input.date, risky };
    });
  });

  app.get("/api/work-centers", async (req) =>
    tenant(req, "production.view", async (db) => {
      const r = await db.query(
        `select code, name, kind, daily_minutes as "dailyMinutes", setup_minutes as "setupMinutes", minutes_per_unit::float8 as "minutesPerUnit" from work_centers order by code`,
      );
      return r.rows;
    }),
  );

  app.put("/api/work-centers/:code", async (req) => {
    const { code } = req.params as { code: string };
    const input = parse(z.object({ dailyMinutes: z.number().int().min(1).max(1440), setupMinutes: z.number().int().min(0).max(10000), minutesPerUnit: z.number().min(0).max(10000) }), req.body);
    return tenant(req, "capacity.manage", async (db, actor) => {
      const b = await db.query(`select id, daily_minutes, setup_minutes, minutes_per_unit from work_centers where code = $1 for update`, [code]);
      if (!b.rows[0]) throw notFound("İş merkezi");
      await db.query(`update work_centers set daily_minutes = $2, setup_minutes = $3, minutes_per_unit = $4 where id = $1`, [b.rows[0].id, input.dailyMinutes, input.setupMinutes, input.minutesPerUnit]);
      await recordEvent(db, actor, { entityType: "work_center", entityId: b.rows[0].id, eventType: "capacity.updated", before: b.rows[0], after: input });
      return { code, ...input };
    });
  });

  /** Kalem temin süresi (gün). Boş bırakılırsa termin "hesaplanamadı" döner. */
  app.post("/api/items/:id/lead-time", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ days: z.number().int().min(0).max(730).nullable() }), req.body);
    return tenant(req, "purchase.request.approve", async (db, actor) => {
      const b = await db.query(`select lead_time_days from items where id = $1 for update`, [id]);
      if (!b.rows[0]) throw notFound("Kalem");
      await db.query(`update items set lead_time_days = $2 where id = $1`, [id, input.days]);
      await recordEvent(db, actor, { entityType: "item", entityId: id, eventType: "lead_time.set", before: { days: b.rows[0].lead_time_days }, after: input });
      return { id, leadTimeDays: input.days };
    });
  });

  app.get("/api/holidays", async (req) =>
    tenant(req, "production.view", async (db) => (await db.query(`select day::text as day, name from holidays where day >= current_date - 30 order by day`)).rows),
  );

  app.post("/api/holidays", async (req) => {
    const input = parse(z.object({ day: z.string().regex(DATE), name: z.string().min(2).max(120) }), req.body);
    return tenant(req, "capacity.manage", async (db, actor) => {
      await db.query(`insert into holidays (company_id, day, name) values (app_company_id(), $1, $2) on conflict (company_id, day) do update set name = excluded.name`, [input.day, input.name]);
      await recordEvent(db, actor, { entityType: "holiday", entityId: actor.companyId, eventType: "holiday.set", after: input });
      return input;
    });
  });
}
