import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { notFound } from "../lib/errors";
import { closeTasks, openTask, recordEvent, type Actor } from "../lib/records";
import { parse, tenant } from "../http/context";
import { priceFor } from "./distributors";

/**
 * R37 — Tedarik riskinin sipariş ve termine etkisi (prompt §10).
 *  - `part_offers` (W17) zaten her yenilemede yeni bir satır ekliyor: bu, kendiliğinden bir tarihsel
 *    anlık görüntü. Ayrı bir "snapshot" mekanizması kurulmadı.
 *  - TEST bağlayıcısı MPN'den DETERMİNİSTİK türer (aynı MPN + bağlayıcı = hep aynı değer) — bu yüzden
 *    iki anlık görüntü karşılaştırması gerektiren riskler (stok düşüşü, fiyat artışı, temin uzaması)
 *    TEST modunda yapısal olarak asla tetiklenmez (gerçekten hiçbir şey değişmediği için — uydurulmaz).
 *    Bu riskler gerçek veriyle (FİYAT DOSYASI'nın zaman içinde yeniden yüklenmesi ya da ileride gerçek
 *    distribütör API'si) etkinleşir. Tek anlık görüntüden çıkarılabilen riskler (kaynakta stok yok,
 *    yaşam döngüsü NRND/EOL/OBSOLETE) TEST modunda da gerçek sinyal verir.
 *  - Risk kartı: ne değişti, hangi kaynaktan, ne kadar taze, hangi açık talep/sipariş etkileniyor,
 *    ihtiyaç tarihine kadar kaç adet açık var, onaylı alternatif var mı, önerilen aksiyon/sorumlu/son tarih.
 *  - Eşik ve tarama sıklığı şirket bazında ayarlanabilir (`supply_risk_settings`).
 *  - Uyarılar tekilleştirilir (kalem+risk türü başına tek açık kayıt); çözülen risk otomatik kapanır;
 *    kritik risk ilgili role görev olarak yükseltilir.
 */

type Offer = {
  connector_id: string; connector_key: string; connector_name: string;
  stock: string | null; lead_time_days: number | null; lifecycle: string | null; currency: string;
  price_breaks: { qty: number; price: number }[]; fetched_at: Date;
};

const RECOMMENDATION: Record<string, (hasAlt: boolean) => string> = {
  lifecycle_risk: (hasAlt) => hasAlt
    ? "Üreticinin yaşam döngüsü değişti; onaylı alternatif kalem mevcut — ilgili iş emri/tedarikte değerlendirin."
    : "Üreticinin yaşam döngüsü değişti (NRND/EOL/OBSOLETE) — Ar-Ge'den alternatif komponent araştırması isteyin.",
  no_source_stock: (hasAlt) => hasAlt
    ? "Kaynakta stok yok; onaylı alternatif kalem mevcut — tedarik için değerlendirin."
    : "Kaynakta stok yok — tedarikçiyle temin teyidi alın, ek kaynak arayın.",
  stock_drop: () => "Kaynak stoğu belirgin şekilde düştü — tedarikçiyle stok teyidi alın, gerekirse erken sipariş verin.",
  price_increase: () => "Fiyat belirgin şekilde arttı — satın alma ile teyit edip gerekirse teklif/sözleşmeyi güncelleyin.",
  lead_time_increase: () => "Temin süresi belirgin şekilde uzadı — açık siparişlerin ihtiyaç tarihleriyle karşılaştırıp gerekirse erken sipariş verin.",
};

const RESPONSIBLE: Record<string, string> = {
  lifecycle_risk: "rd", no_source_stock: "purchasing", stock_drop: "purchasing", price_increase: "purchasing", lead_time_increase: "purchasing",
};

/** Bir kalem için, bağlayıcı başına en yeni (ve varsa bir önceki) `part_offers` satırını döner. */
/** Yeni şirketler migration'dan sonra oluşturulduğu için ayar satırı ilk erişimde tembel olarak açılır. */
async function ensureSettings(db: Db) {
  await db.query(`insert into supply_risk_settings (company_id) values (app_company_id()) on conflict do nothing`);
}

async function latestByConnector(db: Db, itemId: string): Promise<Map<string, Offer[]>> {
  const r = await db.query(
    `select po.connector_id, dc.key as connector_key, dc.name as connector_name,
            po.stock, po.lead_time_days, po.lifecycle, po.currency, po.price_breaks, po.fetched_at
       from part_offers po join distributor_connectors dc on dc.id = po.connector_id
      where po.item_id = $1 order by po.connector_id, po.fetched_at desc`,
    [itemId],
  );
  const byConn = new Map<string, Offer[]>();
  for (const row of r.rows as Offer[]) {
    const list = byConn.get(row.connector_id) ?? [];
    if (list.length < 2) list.push(row);
    byConn.set(row.connector_id, list);
  }
  return byConn;
}

async function openExposure(db: Db, itemId: string) {
  const req = (await db.query(
    `select coalesce(sum(qty), 0)::float8 as qty, min(need_date)::text as "earliestNeedDate"
       from purchase_requests where item_id = $1 and status in ('open', 'approved')`,
    [itemId],
  )).rows[0];
  const po = (await db.query(
    `select coalesce(sum(pol.qty_ordered - pol.qty_received), 0)::float8 as qty, min(pr.need_date)::text as "earliestNeedDate"
       from purchase_order_lines pol left join purchase_requests pr on pr.id = pol.purchase_request_id
      where pol.item_id = $1 and pol.status = 'open'`,
    [itemId],
  )).rows[0];
  const dates = [req.earliestNeedDate, po.earliestNeedDate].filter((d): d is string => !!d).sort();
  return { requestQty: Number(req.qty), poQty: Number(po.qty), earliestNeedDate: dates[0] ?? null };
}

async function hasApprovedAlternate(db: Db, itemId: string) {
  const r = await db.query(`select 1 from item_alternates where item_id = $1 and status = 'approved' limit 1`, [itemId]);
  return r.rowCount! > 0;
}

function snapshotOf(o: Offer) {
  return {
    connector: o.connector_name, stock: o.stock === null ? null : Number(o.stock), leadTimeDays: o.lead_time_days,
    lifecycle: o.lifecycle, currency: o.currency, unitPrice: priceFor(o.price_breaks, 1), fetchedAt: o.fetched_at,
  };
}

type Candidate = {
  itemId: string; connectorId: string; riskType: string; previous: ReturnType<typeof snapshotOf> | null;
  current: ReturnType<typeof snapshotOf>; changeSummary: string; sourceFetchedAt: Date;
};

/** Bir kalemin bağlayıcı bazlı en güncel/önceki tekliflerinden tetiklenen aday riskleri çıkarır. */
function detectCandidates(itemId: string, byConn: Map<string, Offer[]>, cfg: { stockDropPct: number; priceIncreasePct: number; leadTimeIncreaseDays: number }): Candidate[] {
  const out: Candidate[] = [];
  const allLatest: Offer[] = [];
  for (const list of byConn.values()) allLatest.push(list[0]!);

  // Tek anlık görüntüden çıkan riskler: kaynakta hiç stok yok / yaşam döngüsü riskli.
  // "Kaynakta stok yok": takip edilen tüm bağlayıcılarda en güncel teklif stok=0 (en az bir bağlayıcı var).
  if (allLatest.length > 0 && allLatest.every((o) => Number(o.stock ?? 0) === 0)) {
    const worst = allLatest[0]!;
    out.push({
      itemId, connectorId: worst.connector_id, riskType: "no_source_stock", previous: null, current: snapshotOf(worst),
      changeSummary: `Takip edilen ${allLatest.length} kaynakta da stok 0 (son bakılan: ${worst.connector_name}).`,
      sourceFetchedAt: worst.fetched_at,
    });
  }
  for (const o of allLatest) {
    if (o.lifecycle && ["nrnd", "eol", "obsolete"].includes(o.lifecycle)) {
      out.push({
        itemId, connectorId: o.connector_id, riskType: "lifecycle_risk", previous: null, current: snapshotOf(o),
        changeSummary: `${o.connector_name}: yaşam döngüsü "${o.lifecycle}" olarak işaretli.`,
        sourceFetchedAt: o.fetched_at,
      });
      break; // kalem başına tek yaşam döngüsü riski yeterli
    }
  }

  // İki anlık görüntü karşılaştırması gerektiren riskler.
  for (const [, list] of byConn) {
    if (list.length < 2) continue;
    const [cur, prev] = list;
    const curStock = Number(cur!.stock ?? 0), prevStock = Number(prev!.stock ?? 0);
    if (prevStock > 0 && curStock < prevStock) {
      const dropPct = ((prevStock - curStock) / prevStock) * 100;
      if (dropPct >= cfg.stockDropPct) {
        out.push({
          itemId, connectorId: cur!.connector_id, riskType: "stock_drop", previous: snapshotOf(prev!), current: snapshotOf(cur!),
          changeSummary: `${cur!.connector_name}: stok ${prevStock} → ${curStock} (%${dropPct.toFixed(0)} azalma).`,
          sourceFetchedAt: cur!.fetched_at,
        });
      }
    }
    const curPrice = priceFor(cur!.price_breaks, 1), prevPrice = priceFor(prev!.price_breaks, 1);
    if (prevPrice !== null && curPrice !== null && curPrice > prevPrice) {
      const upPct = ((curPrice - prevPrice) / prevPrice) * 100;
      if (upPct >= cfg.priceIncreasePct) {
        out.push({
          itemId, connectorId: cur!.connector_id, riskType: "price_increase", previous: snapshotOf(prev!), current: snapshotOf(cur!),
          changeSummary: `${cur!.connector_name}: fiyat ${prevPrice.toFixed(4)} → ${curPrice.toFixed(4)} ${cur!.currency} (%${upPct.toFixed(0)} artış).`,
          sourceFetchedAt: cur!.fetched_at,
        });
      }
    }
    const curLead = cur!.lead_time_days, prevLead = prev!.lead_time_days;
    if (curLead !== null && prevLead !== null && curLead - prevLead >= cfg.leadTimeIncreaseDays) {
      out.push({
        itemId, connectorId: cur!.connector_id, riskType: "lead_time_increase", previous: snapshotOf(prev!), current: snapshotOf(cur!),
        changeSummary: `${cur!.connector_name}: temin süresi ${prevLead} → ${curLead} gün (+${curLead - prevLead} gün).`,
        sourceFetchedAt: cur!.fetched_at,
      });
    }
  }
  return out;
}

export async function runSupplyRiskScan(db: Db, actor: Actor, opts: { force?: boolean } = {}) {
  await ensureSettings(db);
  const cfg = (await db.query(
    `select enabled, stock_drop_pct as "stockDropPct", price_increase_pct as "priceIncreasePct",
            lead_time_increase_days as "leadTimeIncreaseDays", scan_frequency_hours as "scanFrequencyHours", last_scanned_at as "lastScannedAt"
       from supply_risk_settings where company_id = $1`,
    [actor.companyId],
  )).rows[0];
  if (!cfg || !cfg.enabled) return { scanned: 0, detected: 0, resolved: 0, escalated: 0 };
  if (!opts.force && cfg.lastScannedAt && new Date(cfg.lastScannedAt).getTime() + cfg.scanFrequencyHours * 3_600_000 > Date.now()) {
    return { scanned: 0, detected: 0, resolved: 0, escalated: 0 };
  }

  const items = (await db.query(`select distinct item_id from part_offers`)).rows as { item_id: string }[];
  let detected = 0, resolved = 0, escalated = 0;
  const touchedIds: string[] = [];
  const scannedItemIds: string[] = [];

  for (const { item_id: itemId } of items) {
    scannedItemIds.push(itemId);
    const byConn = await latestByConnector(db, itemId);
    const candidates = detectCandidates(itemId, byConn, {
      stockDropPct: Number(cfg.stockDropPct), priceIncreasePct: Number(cfg.priceIncreasePct), leadTimeIncreaseDays: Number(cfg.leadTimeIncreaseDays),
    });
    if (candidates.length === 0) continue;

    const exposure = await openExposure(db, itemId);
    const hasAlt = await hasApprovedAlternate(db, itemId);

    for (const c of candidates) {
      const totalOpen = exposure.requestQty + exposure.poQty;
      const leadDays = c.current.leadTimeDays ?? 0;
      const cannotMakeIt = exposure.earliestNeedDate
        ? new Date(exposure.earliestNeedDate).getTime() <= Date.now() + leadDays * 86_400_000
        : false;
      const severity: "warning" | "critical" =
        (c.riskType === "lifecycle_risk" && c.current.lifecycle && ["eol", "obsolete"].includes(c.current.lifecycle))
        || (totalOpen > 0 && cannotMakeIt)
          ? "critical" : "warning";
      const responsibleRole = RESPONSIBLE[c.riskType]!;
      const recommendedAction = RECOMMENDATION[c.riskType]!(hasAlt);

      const r = await db.query(
        `insert into supply_risks (company_id, item_id, connector_id, risk_type, severity, previous_snapshot, current_snapshot,
                change_summary, source_fetched_at, open_request_qty, open_po_qty, earliest_need_date, has_approved_alternate,
                recommended_action, responsible_role)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         on conflict (company_id, item_id, risk_type) where status = 'open'
         do update set connector_id = excluded.connector_id, severity = excluded.severity, previous_snapshot = excluded.previous_snapshot,
                current_snapshot = excluded.current_snapshot, change_summary = excluded.change_summary, source_fetched_at = excluded.source_fetched_at,
                open_request_qty = excluded.open_request_qty, open_po_qty = excluded.open_po_qty, earliest_need_date = excluded.earliest_need_date,
                has_approved_alternate = excluded.has_approved_alternate, recommended_action = excluded.recommended_action,
                responsible_role = excluded.responsible_role
         returning id, (xmax = 0) as inserted`,
        [itemId, c.connectorId, c.riskType, severity, c.previous ? JSON.stringify(c.previous) : null, JSON.stringify(c.current),
         c.changeSummary, c.sourceFetchedAt, exposure.requestQty, exposure.poQty, exposure.earliestNeedDate, hasAlt, recommendedAction, responsibleRole],
      );
      const risk = r.rows[0];
      touchedIds.push(risk.id);
      if (risk.inserted) {
        detected++;
        await recordEvent(db, actor, { entityType: "supply_risk", entityId: risk.id, eventType: "supply_risk.detected", after: { itemId, riskType: c.riskType, severity, summary: c.changeSummary } });
      }
      if (severity === "critical") {
        await openTask(db, actor.companyId, {
          kind: "supply_risk", title: `Tedarik riski: ${c.changeSummary}`, entityType: "supply_risk", entityId: risk.id, assigneeRole: responsibleRole,
        });
        await db.query(`update supply_risks set escalated_task_opened = true where id = $1`, [risk.id]);
        escalated++;
      }
    }
  }

  if (touchedIds.length > 0 || scannedItemIds.length > 0) {
    const r = await db.query(
      `update supply_risks set status = 'resolved', resolved_at = now(), resolved_reason = 'otomatik: yeniden taramada eşik altında kaldı'
        where company_id = app_company_id() and status = 'open' and item_id = any($1::uuid[]) and not (id = any($2::uuid[]))
        returning id`,
      [scannedItemIds, touchedIds],
    );
    for (const row of r.rows) {
      resolved++;
      await closeTasks(db, actor.companyId, "supply_risk", row.id);
      await recordEvent(db, actor, { entityType: "supply_risk", entityId: row.id, eventType: "supply_risk.resolved", after: { reason: "auto" } });
    }
  }

  await db.query(`update supply_risk_settings set last_scanned_at = now() where company_id = $1`, [actor.companyId]);
  return { scanned: scannedItemIds.length, detected, resolved, escalated };
}

export async function supplyRiskRoutes(app: FastifyInstance) {
  app.get("/api/supply-risk-settings", async (req) =>
    tenant(req, "purchase.view", async (db, actor) => {
      await ensureSettings(db);
      const r = (await db.query(
        `select enabled, stock_drop_pct as "stockDropPct", price_increase_pct as "priceIncreasePct",
                lead_time_increase_days as "leadTimeIncreaseDays", scan_frequency_hours as "scanFrequencyHours",
                last_scanned_at as "lastScannedAt", updated_at as "updatedAt"
           from supply_risk_settings where company_id = $1`,
        [actor.companyId],
      )).rows[0];
      if (!r) throw notFound("Ayar");
      return r;
    }),
  );

  app.post("/api/supply-risk-settings", async (req) => {
    const input = parse(
      z.object({
        enabled: z.boolean(), stockDropPct: z.number().min(1).max(100), priceIncreasePct: z.number().min(1).max(500),
        leadTimeIncreaseDays: z.number().int().min(1).max(365), scanFrequencyHours: z.number().int().min(1).max(720),
      }),
      req.body,
    );
    return tenant(req, "supply.risk.manage", async (db, actor) => {
      await ensureSettings(db);
      await db.query(
        `update supply_risk_settings set enabled = $2, stock_drop_pct = $3, price_increase_pct = $4,
                lead_time_increase_days = $5, scan_frequency_hours = $6, updated_by = $7, updated_at = now()
          where company_id = $1`,
        [actor.companyId, input.enabled, input.stockDropPct, input.priceIncreasePct, input.leadTimeIncreaseDays, input.scanFrequencyHours, actor.userId],
      );
      return { ok: true };
    });
  });

  app.post("/api/supply-risks/scan", async (req) =>
    tenant(req, "supply.risk.manage", async (db, actor) => runSupplyRiskScan(db, actor, { force: true })),
  );

  app.get("/api/supply-risks", async (req) => {
    const q = z.object({ status: z.enum(["open", "resolved", "all"]).default("open") }).parse(req.query);
    return tenant(req, "purchase.view", async (db) => {
      const r = await db.query(
        `select sr.id, sr.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.mpn, i.manufacturer,
                sr.risk_type as "riskType", sr.severity, sr.status, sr.change_summary as "changeSummary",
                sr.source_fetched_at as "sourceFetchedAt", sr.open_request_qty as "openRequestQty", sr.open_po_qty as "openPoQty",
                sr.earliest_need_date as "earliestNeedDate", sr.has_approved_alternate as "hasApprovedAlternate",
                sr.recommended_action as "recommendedAction", sr.responsible_role as "responsibleRole",
                sr.detected_at as "detectedAt", sr.resolved_at as "resolvedAt", sr.resolved_reason as "resolvedReason"
           from supply_risks sr join items i on i.id = sr.item_id
          where ($1::text = 'all' or sr.status = $1)
          order by (sr.severity = 'critical') desc, sr.detected_at desc limit 300`,
        [q.status],
      );
      return r.rows;
    });
  });

  app.get("/api/supply-risks/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "purchase.view", async (db) => {
      const r = (await db.query(
        `select sr.*, i.code as "itemCode", i.name as "itemName", i.mpn, i.manufacturer, dc.name as "connectorName"
           from supply_risks sr join items i on i.id = sr.item_id left join distributor_connectors dc on dc.id = sr.connector_id
          where sr.id = $1`,
        [id],
      )).rows[0];
      if (!r) throw notFound("Risk");
      return r;
    });
  });

  app.post("/api/supply-risks/:id/resolve", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "supply.risk.manage", async (db, actor) => {
      const r = await db.query(
        `update supply_risks set status = 'resolved', resolved_at = now(), resolved_reason = $2
          where id = $1 and status = 'open' returning id`,
        [id, input.reason],
      );
      if (r.rowCount === 0) throw notFound("Açık risk");
      await closeTasks(db, actor.companyId, "supply_risk", id);
      await recordEvent(db, actor, { entityType: "supply_risk", entityId: id, eventType: "supply_risk.resolved", reason: input.reason, after: { reason: "manual" } });
      return { ok: true };
    });
  });
}
