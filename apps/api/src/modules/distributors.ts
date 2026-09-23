import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { USABLE_LOCATION_TYPES } from "@apisfactory/shared";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { recordEvent, type Actor } from "../lib/records";
import { normalizeDecimal, parseCsv, sha256 } from "../lib/csv";
import { can, parse, tenant } from "../http/context";

/**
 * W17 — Distribütör fiyat/stok. Gerçek distribütör API'si bağlı DEĞİL.
 *  - test: MPN'den deterministik sentetik teklif (TEST VERİSİ — gerçek fiyat/stok değildir; ekranda işaretli).
 *  - price_file: şirketin indirdiği fiyat listesi (CSV) — gerçek veri, dosya ve yükleme zamanıyla.
 * Her teklif kaynak, alınma zamanı ve son geçerlilikle önbellekte tutulur; süresi geçen teklif "eski" işaretlenir,
 * yenileme günlük çağrı kotasına tabidir. Fiyatlar yalnız maliyet görme yetkisiyle görünür.
 */

const KEYS = [
  ["digikey", "DigiKey", "USD"], ["mouser", "Mouser", "USD"], ["farnell", "Farnell", "EUR"], ["nexar", "Nexar / Octopart", "USD"], ["lcsc", "LCSC", "USD"],
] as const;

type Connector = { id: string; key: string; name: string; mode: string; supplier_id: string | null; cache_ttl_minutes: number; daily_call_limit: number; currency: string };
type Break = { qty: number; price: number };

export async function ensureConnectors(db: Db) {
  for (const [key, name, cur] of KEYS) {
    await db.query(`insert into distributor_connectors (company_id, key, name, currency) values (app_company_id(), $1, $2, $3) on conflict do nothing`, [key, name, cur]);
  }
}

/** Deterministik sentetik teklif (TEST). Aynı MPN + bağlayıcı her zaman aynı değerleri üretir. */
export function syntheticOffer(key: string, mpn: string, currency: string) {
  const h = createHash("sha256").update(`${key}:${mpn.toUpperCase()}`).digest();
  const n = (i: number) => h[i]! / 255;
  if (n(0) < 0.08) return null; // katalogda yok
  const base = Math.round((0.02 + n(1) ** 3 * 25) * 10000) / 10000;
  const breaks: Break[] = [1, 10, 100, 1000].map((q, i) => ({ qty: q, price: Math.round(base * (1 - i * 0.12 * n(2)) * 10000) / 10000 }));
  const stock = n(3) < 0.15 ? 0 : Math.round(n(4) ** 2 * 50000);
  const lifecycle = n(5) < 0.05 ? "eol" : n(5) < 0.12 ? "nrnd" : "active";
  return {
    sku: `${key.toUpperCase().slice(0, 3)}-${mpn.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)}`,
    stock, moq: n(6) < 0.2 ? 100 : 1, multiple: 1, leadTimeDays: stock > 0 ? 3 + Math.round(n(7) * 5) : 20 + Math.round(n(8) * 60),
    lifecycle, currency, breaks,
  };
}

export function priceFor(breaks: Break[], qty: number) {
  const sorted = [...breaks].sort((a, b) => a.qty - b.qty);
  let p: number | null = null;
  for (const b of sorted) if (qty >= b.qty) p = b.price;
  return p ?? sorted[0]?.price ?? null;
}

async function callsToday(db: Db, connectorId: string) {
  return Number((await db.query(`select count(*) as n from connector_calls where connector_id = $1 and outcome in ('ok', 'not_found') and created_at >= date_trunc('day', now())`, [connectorId])).rows[0].n);
}

/**
 * Bir MPN için teklifleri döner: taze önbellek varsa onu kullanır; test bağlayıcısında (refresh veya süresi geçmişse)
 * kota içinde yeniden üretir. Fiyat dosyası bağlayıcısı yalnız yüklenen dosyadan okur (yenilenmez).
 */
async function offersFor(db: Db, actor: Actor, item: { id: string | null; mpn: string; manufacturer: string | null }, opts: { refresh: boolean }) {
  await ensureConnectors(db);
  const conns = (await db.query(`select * from distributor_connectors where mode <> 'not_connected' order by key`)).rows as Connector[];
  const out = [];
  const warnings: string[] = [];
  for (const c of conns) {
    const cached = (await db.query(
      `select * from part_offers where connector_id = $1 and lower(mpn) = lower($2) order by fetched_at desc limit 1`,
      [c.id, item.mpn],
    )).rows[0];
    let row = cached;
    const fresh = cached && new Date(cached.expires_at) > new Date();
    if (c.mode === "test" && (!fresh || opts.refresh)) {
      if ((await callsToday(db, c.id)) >= c.daily_call_limit) {
        await db.query(`insert into connector_calls (company_id, connector_id, mpn, outcome, called_by) values (app_company_id(), $1, $2, 'quota_exceeded', $3)`, [c.id, item.mpn, actor.userId]);
        warnings.push(`${c.name}: günlük çağrı kotası (${c.daily_call_limit}) doldu; önbellekteki teklif gösteriliyor`);
      } else {
        const s = syntheticOffer(c.key, item.mpn, c.currency);
        await db.query(`insert into connector_calls (company_id, connector_id, mpn, outcome, called_by) values (app_company_id(), $1, $2, $3, $4)`, [c.id, item.mpn, s ? "ok" : "not_found", actor.userId]);
        if (s) {
          row = (await db.query(
            `insert into part_offers (company_id, connector_id, item_id, mpn, manufacturer, sku, stock, moq, multiple, lead_time_days, lifecycle, currency, price_breaks, source, source_ref, expires_at)
             values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'test_connector', 'sentetik test kataloğu', now() + make_interval(mins => $13)) returning *`,
            [c.id, item.id, item.mpn, item.manufacturer, s.sku, s.stock, s.moq, s.multiple, s.leadTimeDays, s.lifecycle, s.currency, JSON.stringify(s.breaks), c.cache_ttl_minutes],
          )).rows[0];
        } else row = null;
      }
    } else if (cached) {
      await db.query(`insert into connector_calls (company_id, connector_id, mpn, outcome, called_by) values (app_company_id(), $1, $2, 'cache_hit', $3)`, [c.id, item.mpn, actor.userId]);
    }
    if (!row) continue;
    out.push({
      connectorId: c.id, connector: c.name, connectorKey: c.key, mode: c.mode, supplierId: c.supplier_id,
      sku: row.sku, stock: row.stock === null ? null : Number(row.stock), moq: row.moq === null ? null : Number(row.moq), leadTimeDays: row.lead_time_days,
      lifecycle: row.lifecycle, currency: row.currency, breaks: row.price_breaks as Break[], source: row.source, sourceRef: row.source_ref,
      fetchedAt: row.fetched_at, expiresAt: row.expires_at, stale: new Date(row.expires_at) <= new Date(),
      testData: row.source === "test_connector",
    });
  }
  return { offers: out, warnings, connectorsActive: conns.length };
}

function hidePrices<T extends { breaks: Break[] }>(offers: T[], show: boolean) {
  return show ? offers : offers.map((o) => ({ ...o, breaks: [] }));
}

export async function distributorRoutes(app: FastifyInstance) {
  app.get("/api/distributors", async (req) =>
    tenant(req, "purchase.view", async (db) => {
      await ensureConnectors(db);
      const r = await db.query(
        `select c.id, c.key, c.name, c.mode, c.supplier_id as "supplierId", s.name as "supplierName", c.cache_ttl_minutes as "cacheTtlMinutes", c.daily_call_limit as "dailyCallLimit",
                c.currency, c.note, c.updated_at as "updatedAt",
                (select count(*) from connector_calls k where k.connector_id = c.id and k.outcome in ('ok', 'not_found') and k.created_at >= date_trunc('day', now()))::int as "callsToday",
                (select count(*) from connector_calls k where k.connector_id = c.id and k.outcome = 'cache_hit' and k.created_at >= date_trunc('day', now()))::int as "cacheHitsToday",
                (select count(*) from part_offers o where o.connector_id = c.id)::int as offers,
                (select max(o.fetched_at) from part_offers o where o.connector_id = c.id) as "lastFetchedAt"
           from distributor_connectors c left join suppliers s on s.id = c.supplier_id order by c.key`,
      );
      return r.rows;
    }),
  );

  app.post("/api/distributors/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({ mode: z.enum(["not_connected", "test", "price_file"]), supplierId: z.string().uuid().nullable().optional(), cacheTtlMinutes: z.number().int().min(5).max(43200).optional(), dailyCallLimit: z.number().int().min(0).max(100000).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), reason: z.string().min(3).max(500) }),
      req.body,
    );
    return tenant(req, "supplier.manage", async (db, actor) => {
      const before = (await db.query(`select mode, supplier_id, cache_ttl_minutes, daily_call_limit, currency from distributor_connectors where id = $1 for update`, [id])).rows[0];
      if (!before) throw notFound("Bağlayıcı");
      await db.query(
        `update distributor_connectors set mode = $2, supplier_id = case when $3 then $4 else supplier_id end, cache_ttl_minutes = coalesce($5, cache_ttl_minutes),
                daily_call_limit = coalesce($6, daily_call_limit), currency = coalesce($7, currency), updated_by = $8, updated_at = now() where id = $1`,
        [id, input.mode, input.supplierId !== undefined, input.supplierId ?? null, input.cacheTtlMinutes ?? null, input.dailyCallLimit ?? null, input.currency ?? null, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "distributor_connector", entityId: id, eventType: "updated", before, after: input, reason: input.reason });
      return { id, ...input };
    });
  });

  /**
   * Fiyat listesi yükleme (distribütörden indirilen CSV). Sütunlar: mpn, manufacturer?, sku?, stock?, moq?, lead_time_days?, lifecycle?,
   * ve fiyat kırılımları "price_1", "price_10", "price_100"... (başlıktaki sayı = adet). Tüm satırlar dosyanın yükleme zamanıyla kaydedilir.
   */
  app.post("/api/distributors/:id/price-file", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ fileName: z.string().max(200).optional(), content: z.string().min(1).max(5_000_000), decimal: z.enum([".", ","]).default(".") }), req.body);
    return tenant(req, "supplier.manage", async (db, actor) => {
      const c = (await db.query(`select * from distributor_connectors where id = $1`, [id])).rows[0] as Connector | undefined;
      if (!c) throw notFound("Bağlayıcı");
      if (c.mode !== "price_file") throw conflict("wrong_mode", "Bağlayıcı fiyat dosyası modunda değil");
      const { headers, rows } = parseCsv(input.content);
      const lower = headers.map((h) => h.toLowerCase());
      if (!lower.includes("mpn")) throw badRequest("Dosyada 'mpn' sütunu yok", { headers });
      const priceCols = headers.map((h) => ({ h, m: /^price_(\d+)$/i.exec(h) })).filter((x) => x.m).map((x) => ({ h: x.h, qty: Number(x.m![1]) }));
      if (!priceCols.length) throw badRequest("Fiyat sütunu yok (ör. price_1, price_100)");
      const col = (name: string) => headers[lower.indexOf(name)];
      const ref = `${input.fileName ?? "fiyat listesi"} · ${sha256(input.content).slice(0, 10)}`;
      let saved = 0;
      const errors: string[] = [];
      for (const [i, r] of rows.entries()) {
        const mpn = (r[col("mpn")!] ?? "").trim();
        if (!mpn) { errors.push(`Satır ${i + 2}: mpn boş`); continue; }
        const breaks: Break[] = [];
        let bad = false;
        for (const p of priceCols) {
          const v = r[p.h];
          if (!v || !v.trim()) continue;
          const n = normalizeDecimal(v, input.decimal);
          if (n === null) { bad = true; errors.push(`Satır ${i + 2}: ${p.h} sayı değil`); break; }
          breaks.push({ qty: p.qty, price: Number(n) });
        }
        if (bad || !breaks.length) { if (!bad) errors.push(`Satır ${i + 2}: fiyat yok`); continue; }
        const num = (name: string) => { const k = col(name); const v = k ? r[k] : undefined; const n = v ? normalizeDecimal(v, input.decimal) : null; return n === null ? null : Number(n); };
        const lc = (col("lifecycle") ? r[col("lifecycle")!] : "")?.trim().toLowerCase() || "unknown";
        const item = (await db.query(`select id from items where lower(mpn) = lower($1) limit 1`, [mpn])).rows[0];
        await db.query(
          `insert into part_offers (company_id, connector_id, item_id, mpn, manufacturer, sku, stock, moq, lead_time_days, lifecycle, currency, price_breaks, source, source_ref, expires_at)
           values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'price_file', $12, now() + make_interval(mins => $13))`,
          [id, item?.id ?? null, mpn, col("manufacturer") ? r[col("manufacturer")!] || null : null, col("sku") ? r[col("sku")!] || null : null, num("stock"), num("moq"), num("lead_time_days"),
            ["active", "nrnd", "eol", "obsolete"].includes(lc) ? lc : "unknown", c.currency, JSON.stringify(breaks), ref, c.cache_ttl_minutes],
        );
        saved++;
      }
      await recordEvent(db, actor, { entityType: "distributor_connector", entityId: id, eventType: "price_file.loaded", after: { ref, rows: rows.length, saved, errors: errors.length } });
      return { saved, total: rows.length, errors: errors.slice(0, 50), ref };
    });
  });

  /** Kalemin distribütör teklifleri (önbellek + test bağlayıcısı). */
  app.get("/api/items/:id/offers", async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ refresh: z.coerce.boolean().optional(), qty: z.coerce.number().positive().optional() }).parse(req.query);
    return tenant(req, "purchase.view", async (db, actor) => {
      const it = (await db.query(`select id, code, mpn, manufacturer, lifecycle from items where id = $1`, [id])).rows[0];
      if (!it) throw notFound("Kalem");
      if (!it.mpn) return { item: it, offers: [], warnings: ["Kalemde üretici parça numarası (MPN) yok"], connectorsActive: 0 };
      const r = await offersFor(db, actor, { id: it.id, mpn: it.mpn, manufacturer: it.manufacturer }, { refresh: !!q.refresh });
      const qty = q.qty ?? 1;
      const show = can(req, "field.cost.view");
      const offers = hidePrices(r.offers, show).map((o) => ({ ...o, unitPrice: show ? priceFor(o.breaks, Math.max(qty, o.moq ?? 1)) : null, qty }));
      return { item: it, ...r, offers };
    });
  });

  /**
   * BOM tedarik görünümü: adet için her satırın brüt ihtiyacı, serbest stok, en iyi teklif (stok yeterli olanlardan en ucuz),
   * yaşam döngüsü riski ve tahmini alım tutarı (para birimi bazında; kur dönüşümü yok).
   */
  app.get("/api/boms/:id/sourcing", async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ qty: z.coerce.number().int().min(1).max(1_000_000).default(100), refresh: z.coerce.boolean().optional() }).parse(req.query);
    return tenant(req, "bom.view", async (db, actor) => {
      const b = (await db.query(`select id, product_id from bom_versions where id = $1`, [id])).rows[0];
      if (!b) throw notFound("BOM sürümü");
      const lines = (await db.query(
        `select i.id, i.code, i.mpn, i.manufacturer, i.lifecycle, sum(bl.qty_per)::float8 as qty_per,
                coalesce((select sum(sb.qty) from stock_balances sb join locations l on l.id = sb.location_id where sb.item_id = i.id and l.type = any($2)), 0)::float8 as stock,
                coalesce((select sum(r.qty) from reservations r where r.item_id = i.id and r.status = 'active'), 0)::float8 as reserved
           from bom_lines bl join items i on i.id = bl.item_id where bl.bom_version_id = $1 and not bl.dnp group by i.id order by i.code`,
        [id, USABLE_LOCATION_TYPES],
      )).rows;
      const show = can(req, "field.cost.view");
      const totals: Record<string, number> = {};
      const rows = [];
      const warnings = new Set<string>();
      let testData = false;
      for (const l of lines) {
        const gross = l.qty_per * q.qty;
        const free = Math.max(0, l.stock - l.reserved);
        const toBuy = Math.max(0, gross - free);
        let best = null;
        let lifecycle = l.lifecycle as string | null;
        if (l.mpn && toBuy > 0) {
          const r = await offersFor(db, actor, { id: l.id, mpn: l.mpn, manufacturer: l.manufacturer }, { refresh: !!q.refresh });
          r.warnings.forEach((w) => warnings.add(w));
          const cands = r.offers.map((o) => {
            const buyQty = Math.max(toBuy, o.moq ?? 1);
            const unit = priceFor(o.breaks, buyQty);
            return { ...o, buyQty, unit, total: unit === null ? null : Math.round(unit * buyQty * 100) / 100, enough: (o.stock ?? 0) >= toBuy };
          });
          const pick = [...cands].sort((a, b2) => Number(b2.enough) - Number(a.enough) || (a.total ?? Infinity) - (b2.total ?? Infinity))[0];
          if (pick) {
            best = { connector: pick.connector, sku: pick.sku, stock: pick.stock, enough: pick.enough, leadTimeDays: pick.leadTimeDays, buyQty: pick.buyQty, currency: pick.currency,
              unitPrice: show ? pick.unit : null, total: show ? pick.total : null, fetchedAt: pick.fetchedAt, stale: pick.stale, testData: pick.testData, offers: cands.length };
            if (pick.testData) testData = true;
            if (show && pick.total !== null) totals[pick.currency] = Math.round(((totals[pick.currency] ?? 0) + pick.total) * 100) / 100;
            lifecycle = lifecycle ?? cands.find((c) => c.lifecycle && c.lifecycle !== "active")?.lifecycle ?? pick.lifecycle;
          }
        }
        const risks: string[] = [];
        if (!l.mpn) risks.push("MPN yok");
        if (toBuy > 0 && !best) risks.push("teklif yok");
        if (best && !best.enough) risks.push("distribütör stoğu yetersiz");
        if (best?.stale) risks.push("teklif eski");
        if (lifecycle && ["nrnd", "eol", "obsolete"].includes(lifecycle)) risks.push(`yaşam döngüsü: ${lifecycle.toUpperCase()}`);
        // Onaylı alternatifler (W29): risk varsa veya stok yetmiyorsa, stoğu olan alternatif önerilir.
        const alts = (await db.query(
          `select x.id, x.code, x.mpn, x.lifecycle, a.product_id is not null as "productScoped",
                  greatest(coalesce((select sum(sb.qty) from stock_balances sb join locations lo on lo.id = sb.location_id where sb.item_id = x.id and lo.type = any($3)), 0)
                         - coalesce((select sum(r.qty) from reservations r where r.item_id = x.id and r.status = 'active'), 0), 0)::float8 as free
             from item_alternates a join items x on x.id = a.alternate_item_id
            where a.item_id = $1 and a.status = 'approved' and (a.product_id is null or a.product_id = $2) order by x.code`,
          [l.id, b.product_id, USABLE_LOCATION_TYPES],
        )).rows;
        let suggestion: string | null = null;
        if (toBuy > 0 && alts.length) {
          const covering = alts.find((a) => a.free >= toBuy && !["eol", "obsolete"].includes(a.lifecycle ?? ""));
          if (covering && (risks.length || !best)) suggestion = `Onaylı alternatif ${covering.code} stoktan karşılar (serbest ${covering.free})`;
          else if (covering) suggestion = `Onaylı alternatif ${covering.code} stokta (serbest ${covering.free}); alım yerine kullanılabilir`;
        }
        rows.push({ itemId: l.id, code: l.code, mpn: l.mpn, gross, free, toBuy, best, lifecycle, risks, alternates: alts, suggestion });
      }
      return { qty: q.qty, lines: rows, totals: show ? totals : null, warnings: [...warnings], testData, note: "Kur dönüşümü yapılmaz; tutarlar para birimi bazında. Teklifler önbellekten ve alınma zamanıyla." };
    });
  });

  /** RFQ'ya otomatik teklif: tedarikçiye bağlı aktif bağlayıcıların teklifleri eklenir (elle girilmiş teklifin üzerine yazmaz). */
  app.post("/api/rfqs/:id/auto-quotes", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "purchase.order.manage", async (db, actor) => {
      const r = (await db.query(`select r.status, r.qty::float8 as qty, i.id as item_id, i.mpn, i.manufacturer from rfqs r join items i on i.id = r.item_id where r.id = $1 for update of r`, [id])).rows[0];
      if (!r) throw notFound("Teklif talebi");
      if (r.status !== "open") throw conflict("rfq_closed", "Teklif talebi kapalı");
      if (!r.mpn) throw conflict("mpn_missing", "Kalemde MPN yok; distribütör teklifi alınamaz");
      const o = await offersFor(db, actor, { id: r.item_id, mpn: r.mpn, manufacturer: r.manufacturer }, { refresh: false });
      const added: string[] = [];
      const skipped: string[] = [];
      for (const x of o.offers) {
        if (!x.supplierId) { skipped.push(`${x.connector}: tedarikçiye bağlı değil`); continue; }
        const sup = (await db.query(`select status from suppliers where id = $1`, [x.supplierId])).rows[0];
        if (sup?.status !== "active") { skipped.push(`${x.connector}: tedarikçi bloke`); continue; }
        const prev = (await db.query(`select source from rfq_quotes where rfq_id = $1 and supplier_id = $2`, [id, x.supplierId])).rows[0];
        if (prev && prev.source === "manual") { skipped.push(`${x.connector}: elle girilmiş teklif korunuyor`); continue; }
        const buyQty = Math.max(r.qty, x.moq ?? 1);
        const unit = priceFor(x.breaks, buyQty);
        if (unit === null) { skipped.push(`${x.connector}: fiyat yok`); continue; }
        const lead = (x.stock ?? 0) >= r.qty ? x.leadTimeDays ?? 7 : Math.max(x.leadTimeDays ?? 30, 14);
        const note = `${x.testData ? "TEST VERİSİ — " : ""}${x.connector} ${x.sku ?? ""} · stok ${x.stock ?? "?"} · ${x.sourceRef ?? x.source} · alındı ${new Date(x.fetchedAt).toISOString().slice(0, 16).replace("T", " ")}`;
        await db.query(
          `insert into rfq_quotes (company_id, rfq_id, supplier_id, unit_price, currency, lead_time_days, moq, valid_until, note, source, entered_by)
           values (app_company_id(), $1, $2, $3, $4, $5, $6, $7::timestamptz::date, $8, 'test_connector', $9)
           on conflict (rfq_id, supplier_id) do update set unit_price = excluded.unit_price, currency = excluded.currency, lead_time_days = excluded.lead_time_days, moq = excluded.moq,
             valid_until = excluded.valid_until, note = excluded.note, source = excluded.source, entered_by = excluded.entered_by, created_at = now()`,
          [id, x.supplierId, unit, x.currency, lead, x.moq && x.moq > 1 ? x.moq : null, x.expiresAt, note, actor.userId],
        );
        added.push(x.connector);
      }
      await recordEvent(db, actor, { entityType: "rfq", entityId: id, eventType: "auto_quotes", after: { added, skipped } });
      return { added, skipped, warnings: o.warnings };
    });
  });
}
