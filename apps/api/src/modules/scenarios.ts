import type { FastifyInstance } from "fastify";
import { loadCapacityCalendar, scheduleOnCalendar } from "../lib/capacity";
import { USABLE_LOCATION_TYPES } from "@apisfactory/shared";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { fromMicro, max, min, mul, toMicro } from "../lib/decimal";
import { parse, tenant } from "../http/context";
import { routeFor } from "../lib/routing";
import { finishAfterWorkingDays, nextWorkingDay } from "./leadtime";

const USABLE = USABLE_LOCATION_TYPES as readonly string[];
const iso = (d: Date) => d.toISOString().slice(0, 10);

const OverridesInput = z.object({
  /** "500 yerine 1.000 adet üretim" — doğrudan senaryo qty alanıyla verilir, burada ayrıca yok. */
  criticalItemId: z.string().uuid().optional(),
  delayDays: z.number().int().min(1).max(365).optional(),
  alternateFor: z.object({ itemId: z.string().uuid(), alternateItemId: z.string().uuid() }).optional(),
  subcontract: z.boolean().optional(),
  extraShiftMinutes: z.number().int().min(0).max(1440).optional(),
});
type Overrides = z.infer<typeof OverridesInput>;

const ScenarioInput = z.object({
  name: z.string().min(2).max(200),
  productRevisionId: z.string().uuid(),
  qty: z.string().regex(/^\d+(\.\d+)?$/),
  overrides: OverridesInput.default({}),
});

type SimResult = {
  qty: string;
  materialReadyDate: string | null;
  earliest: string | null;
  latest: string | null;
  productionDays: number;
  queueDays: number;
  bottleneck: string | null;
  status: "ok" | "unknown";
  reasons: string[];
  materials: { itemCode: string; requiredQty: string; source: string; readyDate: string | null; unitCost: string | null; lineCost: string | null }[];
  totalMaterialCost: string | null;
  costCurrency: string | null;
  assumptions: string[];
};

/**
 * Ne-olurdu hesabı: gerçek stok/rezervasyon/açık iş yükünü OKUR ama hiçbir kayıt YAZMAZ.
 * "500 yerine 1.000 adet", "kritik parça N gün gecikme", "onaylı alternatif", "fason iş",
 * "ek vardiya" senaryo eksenlerini destekler (prompt §22). AI süre/maliyet uydurmaz; bilinmeyen
 * kalemler "hesaplanamadı" olarak işaretlenir.
 */
async function simulate(db: Db, revisionId: string, qty: string, overrides: Overrides, today = iso(new Date())): Promise<SimResult> {
  const rev = (await db.query(`select bom_version_id from product_revisions where id = $1`, [revisionId])).rows[0];
  if (!rev) throw notFound("Ürün revizyonu");
  if (!rev.bom_version_id) return {
    qty, materialReadyDate: null, earliest: null, latest: null, productionDays: 0, queueDays: 0, bottleneck: null,
    status: "unknown", reasons: ["Bu revizyonun BOM sürümü yok"], materials: [], totalMaterialCost: null, costCurrency: null, assumptions: [],
  };

  if (overrides.alternateFor) {
    const ok = await db.query(
      `select 1 from item_alternates where item_id = $1 and alternate_item_id = $2 and status = 'approved'`,
      [overrides.alternateFor.itemId, overrides.alternateFor.alternateItemId],
    );
    if (!ok.rows[0]) throw badRequest("Belirtilen alternatif onaylı değil; yalnız onaylı alternatifler senaryoda kullanılabilir");
  }

  const bom = await db.query(
    `select bl.item_id, i.code, i.lead_time_days, sum(bl.qty_per) as qty_per from bom_lines bl join items i on i.id = bl.item_id
      where bl.bom_version_id = $1 and not bl.dnp group by bl.item_id, i.code, i.lead_time_days order by i.code`,
    [rev.bom_version_id],
  );
  const holidays = new Set<string>((await db.query(`select day::text as day from holidays`)).rows.map((r) => r.day));
  const reasons: string[] = [];
  const materials: SimResult["materials"] = [];
  let unknown = false;
  let materialReady = today;
  let totalCost = 0n;
  let costUnknown = false;
  let currency: string | null = null;

  for (const m of bom.rows) {
    let itemId: string = m.item_id;
    let code: string = m.code;
    let leadTimeDays: number | null = m.lead_time_days;
    if (overrides.alternateFor && overrides.alternateFor.itemId === itemId) {
      const alt = (await db.query(`select code, lead_time_days from items where id = $1`, [overrides.alternateFor.alternateItemId])).rows[0];
      if (alt) { itemId = overrides.alternateFor.alternateItemId; code = `${alt.code} (onaylı alternatif)`; leadTimeDays = alt.lead_time_days; }
    }
    const gross = mul(toMicro(qty), toMicro(m.qty_per));
    const fs = await db.query(
      `select coalesce((select sum(b.qty) from stock_balances b join locations loc on loc.id = b.location_id where b.item_id = $1 and loc.type = any($2)), 0) as usable,
              coalesce((select sum(qty) from reservations where item_id = $1 and status = 'active'), 0) as reserved`,
      [itemId, USABLE],
    );
    const free = max(0n, toMicro(fs.rows[0].usable) - toMicro(fs.rows[0].reserved));
    const fromStock = min(free, gross);
    const rest = gross - fromStock;
    let ready: string | null = today;
    let source = "stok";
    if (rest > 0n) {
      if (leadTimeDays === null) {
        unknown = true; ready = null; source = "temin süresi tanımsız";
        reasons.push(`${code}: ${fromMicro(rest)} adet eksik ve temin süresi tanımlı değil`);
      } else {
        const effectiveDays = leadTimeDays + (overrides.criticalItemId === m.item_id ? (overrides.delayDays ?? 0) : 0);
        ready = addDays(today, effectiveDays);
        source = overrides.criticalItemId === m.item_id && overrides.delayDays
          ? `yeni alım (temin ${leadTimeDays} gün + ${overrides.delayDays} gün senaryo gecikmesi)`
          : `yeni alım (temin ${effectiveDays} gün)`;
      }
    }
    if (ready && ready > materialReady) materialReady = ready;

    // Referans birim maliyet: kalemin lotlarına en son kaydedilen maliyet (gerçek gelecek fiyat garantisi değildir).
    const lc = (await db.query(
      `select lc.unit_cost as "unitCost", lc.currency from lot_costs lc join lots l on l.id = lc.lot_id where l.item_id = $1 order by lc.created_at desc limit 1`,
      [itemId],
    )).rows[0];
    let unitCost: string | null = null;
    let lineCost: string | null = null;
    if (lc) {
      unitCost = fromMicro(toMicro(lc.unitCost));
      lineCost = fromMicro(mul(gross, toMicro(lc.unitCost)));
      totalCost += mul(gross, toMicro(lc.unitCost));
      currency = currency ?? lc.currency;
    } else {
      costUnknown = true;
    }
    materials.push({ itemCode: code, requiredQty: fromMicro(gross), source, readyDate: ready, unitCost, lineCost });
  }

  // Kapasite: fason varsayımında iç kapasite kullanılmaz (dış firmanın kendi termini ayrıca değerlendirilmeli).
  const route = await routeFor(db, revisionId);
  const cal = await loadCapacityCalendar(db);
  const ownByWc = new Map<string, number>();
  const qtyNum = Number(qty);
  if (!overrides.subcontract) {
    for (const op of route.ops) {
      const cur = ownByWc.get(op.workCenter) ?? 0;
      ownByWc.set(op.workCenter, cur + op.setupMinutes + qtyNum * op.minutesPerUnit);
    }
  }
  const queue = await db.query(
    `select wc.code, sum(coalesce(op.planned_setup_minutes, wc.setup_minutes) + w.qty * coalesce(op.planned_minutes_per_unit, wc.minutes_per_unit))::float8 as minutes
       from work_order_operations op join work_orders w on w.id = op.work_order_id join work_centers wc on wc.id = op.work_center_id
      where op.status <> 'done' and w.status in ('planned', 'released', 'in_progress', 'on_hold')
      group by wc.code`,
  );
  const queueBy = new Map(queue.rows.map((q) => [q.code as string, Number(q.minutes)]));
  let productionDays = 0, queueDays = 0, bottleneck: string | null = null;
  const own: { code: string; minutes: number }[] = [];
  for (const [code, minutes] of ownByWc) {
    if (!cal.known(code)) { unknown = true; reasons.push(`İş merkezi tanımlı değil: ${code}`); continue; }
    own.push({ code, minutes });
  }

  let earliest: string | null = null, latest: string | null = null;
  if (!unknown) {
    const start = nextWorkingDay(materialReady, holidays);
    if (qtyNum > 0 && own.length) {
      // Ek vardiya varsayımı: kapasitesi olan her güne iş merkezi başına ek dakika.
      const s = scheduleOnCalendar(cal, start, own, queueBy, overrides.extraShiftMinutes ?? 0);
      if (s.earliest === null) { unknown = true; reasons.push(...s.reasons); }
      else { earliest = s.earliest; latest = s.latest; }
      productionDays = s.productionDays; queueDays = s.queueDays; bottleneck = s.bottleneck;
    } else if (qtyNum > 0) {
      // Fason varsayımı: iç kapasite kullanılmaz; eski davranış gibi en az bir iş günü.
      earliest = finishAfterWorkingDays(start, 1, holidays);
      latest = earliest;
    } else {
      earliest = start;
      latest = start;
    }
  }

  const assumptions = [
    "Ne-olurdu hesabıdır; gerçek rezervasyon, sipariş veya iş emri oluşturmaz.",
    "Referans birim maliyetler kalemin en son kaydedilen lot maliyetidir; gelecek fiyatı garanti etmez.",
    overrides.subcontract ? "Fason varsayımı: iç iş merkezi kapasitesi kullanılmadı; dış firmanın kendi termini/maliyeti bu hesaba dahil değildir." : "İç üretim varsayıldı.",
    overrides.extraShiftMinutes ? `Ek vardiya: günlük kapasiteye iş merkezi başına +${overrides.extraShiftMinutes} dakika eklendi.` : "",
    overrides.delayDays && overrides.criticalItemId ? `Kritik parça senaryo gecikmesi: +${overrides.delayDays} gün.` : "",
    overrides.alternateFor ? "Onaylı alternatif parça kullanıldı." : "",
    costUnknown ? "Bazı kalemlerde referans maliyet kaydı yok; toplam maliyet eksik olabilir (uydurulmadı)." : "",
  ].filter(Boolean);

  return {
    qty, materialReadyDate: unknown ? null : materialReady, earliest, latest, productionDays, queueDays, bottleneck,
    status: unknown ? "unknown" : "ok", reasons, materials,
    totalMaterialCost: costUnknown && materials.every((m) => m.unitCost === null) ? null : fromMicro(totalCost),
    costCurrency: currency, assumptions,
  };
}

function addDays(s: string, n: number) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

export async function scenarioRoutes(app: FastifyInstance) {
  app.post("/api/scenarios", async (req) => {
    const input = parse(ScenarioInput, req.body);
    return tenant(req, "report.view", async (db, actor) => {
      const baseline = await simulate(db, input.productRevisionId, input.qty, {});
      const scenario = await simulate(db, input.productRevisionId, input.qty, input.overrides);
      const delta = {
        latestDays: baseline.latest && scenario.latest ? Math.round((+new Date(scenario.latest) - +new Date(baseline.latest)) / 86_400_000) : null,
        materialCost: baseline.totalMaterialCost && scenario.totalMaterialCost ? fromMicro(toMicro(scenario.totalMaterialCost) - toMicro(baseline.totalMaterialCost)) : null,
      };
      const result = { baseline, scenario, delta };
      const r = await db.query(
        `insert into scenarios (company_id, name, product_revision_id, qty, overrides, result, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6) returning id, created_at, source_asof`,
        [input.name, input.productRevisionId, input.qty, JSON.stringify(input.overrides), JSON.stringify(result), actor.userId],
      );
      await recordEvent(db, actor, { entityType: "scenario", entityId: r.rows[0].id, eventType: "created", after: { name: input.name, overrides: input.overrides, delta } });
      return { id: r.rows[0].id, name: input.name, productRevisionId: input.productRevisionId, qty: input.qty, overrides: input.overrides, result, createdAt: r.rows[0].created_at, sourceAsof: r.rows[0].source_asof };
    });
  });

  app.get("/api/scenarios", async (req) => {
    const q = z.object({ productRevisionId: z.string().uuid().optional() }).parse(req.query);
    return tenant(req, "report.view", async (db) => {
      const r = await db.query(
        `select s.id, s.name, s.qty, s.overrides, s.created_at as "createdAt", s.source_asof as "sourceAsof",
                p.code as "productCode", pr.rev, s.result->'delta' as delta, s.result->'baseline'->>'latest' as "baselineLatest",
                s.result->'scenario'->>'latest' as "scenarioLatest"
           from scenarios s join product_revisions pr on pr.id = s.product_revision_id join products p on p.id = pr.product_id
          where ($1::uuid is null or s.product_revision_id = $1)
          order by s.created_at desc limit 100`,
        [q.productRevisionId ?? null],
      );
      return r.rows;
    });
  });

  app.get("/api/scenarios/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "report.view", async (db) => {
      const r = await db.query(
        `select s.id, s.name, s.qty, s.overrides, s.result, s.created_at as "createdAt", s.source_asof as "sourceAsof",
                p.code as "productCode", p.name as "productName", pr.rev, s.product_revision_id as "productRevisionId"
           from scenarios s join product_revisions pr on pr.id = s.product_revision_id join products p on p.id = pr.product_id
          where s.id = $1`,
        [id],
      );
      if (!r.rows[0]) throw notFound("Senaryo");
      // Senaryodan doğan görevler ve değişiklik talepleri (R42).
      const tasks = (await db.query(
        `select id, title, status, due_date::text as "dueDate", assignee_role as "assigneeRole" from tasks where entity_type = 'scenario' and entity_id = $1 order by created_at`,
        [id],
      )).rows;
      const changeRequests = (await db.query(`select id, code, title, status from change_requests where scenario_id = $1 order by created_at`, [id])).rows;
      return { ...r.rows[0], followUps: { tasks, changeRequests } };
    });
  });
}
