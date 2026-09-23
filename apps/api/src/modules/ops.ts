import type { FastifyInstance } from "fastify";
import { tenant } from "../http/context";
import { ensureConnectors as ensureDistributorConnectors } from "./distributors";
import { ensureEinvoiceCargoConnectors } from "./dispatch";

/**
 * W38 — bağlayıcı operasyon panosu. Yeni tablo yok: distribütör (`connector_calls`) ve e-belge/kargo
 * (`document_dispatches`) için zaten tutulan değişmez çağrı/gönderim kayıtlarının özetidir.
 * Gerçek dış API bağlantısı olan hiçbir bağlayıcı yok (W03/W17/W36); pano yalnız kota, önbellek isabeti,
 * hata sayısı ve son etkinliği gösterir — canlıya geçildiğinde aynı ekran gerçek verilerle çalışacaktır.
 */
export async function opsRoutes(app: FastifyInstance) {
  app.get("/api/connectors/status", async (req) =>
    tenant(req, "audit.view", async (db) => {
      await ensureDistributorConnectors(db);
      await ensureEinvoiceCargoConnectors(db);
      const distributors = await db.query(
        `select c.id, 'distributor' as category, c.key, c.name, c.mode, c.daily_call_limit as "quota", c.cache_ttl_minutes as "cacheTtlMinutes",
                (select count(*) from connector_calls k where k.connector_id = c.id and k.outcome in ('ok', 'not_found') and k.created_at >= date_trunc('day', now()))::int as "activityToday",
                (select count(*) from connector_calls k where k.connector_id = c.id and k.outcome in ('ok', 'not_found'))::int as "activityTotal",
                (select count(*) from connector_calls k where k.connector_id = c.id and k.outcome = 'cache_hit' and k.created_at >= date_trunc('day', now()))::int as "cacheHitsToday",
                (select count(*) from connector_calls k where k.connector_id = c.id and k.outcome = 'error' and k.created_at >= now() - interval '7 days')::int as "errorsWeek",
                (select count(*) from connector_calls k where k.connector_id = c.id and k.outcome = 'quota_exceeded' and k.created_at >= date_trunc('day', now()))::int as "quotaHitsToday",
                (select max(k.created_at) from connector_calls k where k.connector_id = c.id and k.outcome in ('ok', 'cache_hit'))::text as "lastActivityAt"
           from distributor_connectors c order by c.key`,
      );
      const einvoice = await db.query(
        `select c.id, 'einvoice' as category, c.key, c.name, c.mode, null::int as "quota", null::int as "cacheTtlMinutes",
                (select count(*) from document_dispatches d where d.kind = 'einvoice' and d.connector_id = c.id and d.created_at >= date_trunc('day', now()))::int as "activityToday",
                (select count(*) from document_dispatches d where d.kind = 'einvoice' and d.connector_id = c.id)::int as "activityTotal",
                null::int as "cacheHitsToday", 0 as "errorsWeek", 0 as "quotaHitsToday",
                (select max(d.created_at) from document_dispatches d where d.kind = 'einvoice' and d.connector_id = c.id)::text as "lastActivityAt"
           from einvoice_connectors c order by c.key`,
      );
      const cargo = await db.query(
        `select c.id, 'cargo' as category, c.key, c.name, c.mode, null::int as "quota", null::int as "cacheTtlMinutes",
                (select count(*) from document_dispatches d where d.kind = 'cargo_label' and d.connector_id = c.id and d.created_at >= date_trunc('day', now()))::int as "activityToday",
                (select count(*) from document_dispatches d where d.kind = 'cargo_label' and d.connector_id = c.id)::int as "activityTotal",
                null::int as "cacheHitsToday", 0 as "errorsWeek", 0 as "quotaHitsToday",
                (select max(d.created_at) from document_dispatches d where d.kind = 'cargo_label' and d.connector_id = c.id)::text as "lastActivityAt"
           from cargo_connectors c order by c.key`,
      );
      const rows = [...distributors.rows, ...einvoice.rows, ...cargo.rows].map((r) => ({
        ...r,
        quotaPct: r.quota ? Math.round((r.activityToday / r.quota) * 1000) / 10 : null,
        cacheHitPct: r.cacheHitsToday !== null && r.activityToday + r.cacheHitsToday > 0 ? Math.round((r.cacheHitsToday / (r.activityToday + r.cacheHitsToday)) * 1000) / 10 : null,
      }));
      return {
        rows,
        summary: {
          connected: rows.filter((r) => r.mode !== "not_connected").length,
          total: rows.length,
          errorsWeek: rows.reduce((n, r) => n + (r.errorsWeek ?? 0), 0),
          quotaHitsToday: rows.reduce((n, r) => n + (r.quotaHitsToday ?? 0), 0),
        },
      };
    }),
  );
}
