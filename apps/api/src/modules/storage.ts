import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conflict, notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { parse, tenant } from "../http/context";

const MSL_LEVELS = ["1", "2", "2a", "3", "4", "5", "5a", "6"] as const;

const StorageInput = z.object({
  mslLevel: z.enum(MSL_LEVELS).nullable().optional(),
  floorLifeHours: z.number().int().min(1).max(100_000).nullable().optional(),
  shelfLifeDays: z.number().int().min(1).max(100_000).nullable().optional(),
  storageCondition: z.string().max(200).nullable().optional(),
  issuePolicy: z.enum(["fifo", "fefo"]).optional(),
});

const LotExpiryInput = z.object({
  mfgDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

/** Kalan raf ömrü/kullanım süresine göre durum: AI süre uydurmaz, yalnız elle girilen tarihlere göre hesaplar. */
function shelfStatus(expiresAt: string | null, floorLifeExpiresAt: string | null, now: Date): "expired" | "expiring_soon" | "ok" | "unknown" {
  const dates = [expiresAt, floorLifeExpiresAt].filter((x): x is string => !!x).map((x) => new Date(x).getTime());
  if (!dates.length) return "unknown";
  const earliest = Math.min(...dates);
  if (earliest <= now.getTime()) return "expired";
  if (earliest - now.getTime() <= 14 * 24 * 3600 * 1000) return "expiring_soon";
  return "ok";
}

/**
 * W33 — MSL, raf ömrü, ambalaj ve koşul (prompt §14). Kalem düzeyinde saklama kuralları isteğe bağlıdır
 * (gereksiz alan bütün parçalara zorunlu tutulmaz); lot düzeyinde üretim/son kullanma tarihi elle girilir.
 */
export async function storageRoutes(app: FastifyInstance) {
  app.post("/api/items/:id/storage", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(StorageInput, req.body);
    return tenant(req, "item.storage.manage", async (db, actor) => {
      const b = await db.query(
        `select msl_level, floor_life_hours, shelf_life_days, storage_condition, issue_policy from items where id = $1 for update`,
        [id],
      );
      if (!b.rows[0]) throw notFound("Kalem");
      const cur = b.rows[0];
      const next = {
        mslLevel: input.mslLevel === undefined ? cur.msl_level : input.mslLevel,
        floorLifeHours: input.floorLifeHours === undefined ? cur.floor_life_hours : input.floorLifeHours,
        shelfLifeDays: input.shelfLifeDays === undefined ? cur.shelf_life_days : input.shelfLifeDays,
        storageCondition: input.storageCondition === undefined ? cur.storage_condition : input.storageCondition,
        issuePolicy: input.issuePolicy ?? cur.issue_policy,
      };
      await db.query(
        `update items set msl_level = $2, floor_life_hours = $3, shelf_life_days = $4, storage_condition = $5, issue_policy = $6 where id = $1`,
        [id, next.mslLevel, next.floorLifeHours, next.shelfLifeDays, next.storageCondition, next.issuePolicy],
      );
      await recordEvent(db, actor, { entityType: "item", entityId: id, eventType: "storage.updated", before: cur, after: next });
      return { id, ...next };
    });
  });

  /** Mal kabul veya üretimde lotun üretim/son kullanma tarihi elle girilir; sunucu tarih uydurmaz. */
  app.post("/api/lots/:id/expiry", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(LotExpiryInput, req.body);
    return tenant(req, "item.storage.manage", async (db, actor) => {
      const b = await db.query(`select mfg_date, expires_at from lots where id = $1 for update`, [id]);
      if (!b.rows[0]) throw notFound("Lot");
      const cur = b.rows[0];
      const next = {
        mfgDate: input.mfgDate === undefined ? cur.mfg_date : input.mfgDate,
        expiresAt: input.expiresAt === undefined ? cur.expires_at : input.expiresAt,
      };
      await db.query(`update lots set mfg_date = $2, expires_at = $3 where id = $1`, [id, next.mfgDate, next.expiresAt]);
      await recordEvent(db, actor, { entityType: "lot", entityId: id, eventType: "expiry.set", before: cur, after: next });
      return { id, ...next };
    });
  });

  /** Paket açılışı kaydı: MSL'li kalemlerde kullanım süresi (floor life) bu andan itibaren başlar. */
  app.post("/api/lots/:id/open", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "inventory.issue", async (db, actor) => {
      const b = await db.query(
        `select l.opened_at, i.floor_life_hours from lots l join items i on i.id = l.item_id where l.id = $1 for update of l`,
        [id],
      );
      if (!b.rows[0]) throw notFound("Lot");
      if (b.rows[0].opened_at) throw conflict("already_opened", "Bu lotun paketi zaten açılmış olarak işaretli");
      const r = await db.query(
        `update lots set opened_at = now(), opened_by = $2 where id = $1 returning opened_at`,
        [id, actor.userId],
      );
      const openedAt: Date = r.rows[0].opened_at;
      const floorLifeExpiresAt = b.rows[0].floor_life_hours ? new Date(openedAt.getTime() + b.rows[0].floor_life_hours * 3600_000) : null;
      await recordEvent(db, actor, { entityType: "lot", entityId: id, eventType: "opened", after: { openedAt, floorLifeExpiresAt } });
      return { id, openedAt, floorLifeExpiresAt };
    });
  });

  /** Kalemin lotlarını şirketin FIFO/FEFO politikasına göre sıralı listeler; MSL/raf ömrü durumunu hesaplar. */
  app.get("/api/items/:id/lots", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "inventory.view", async (db) => {
      const item = (await db.query(
        `select id, code, msl_level as "mslLevel", floor_life_hours as "floorLifeHours", shelf_life_days as "shelfLifeDays",
                storage_condition as "storageCondition", issue_policy as "issuePolicy"
           from items where id = $1`,
        [id],
      )).rows[0];
      if (!item) throw notFound("Kalem");
      const order = item.issuePolicy === "fefo" ? "l.expires_at asc nulls last, l.created_at asc" : "l.created_at asc";
      const rows = (await db.query(
        `select l.id, l.lot_no as "lotNo", l.mfg_date as "mfgDate", l.expires_at as "expiresAt", l.opened_at as "openedAt",
                l.inspection_status as "inspectionStatus", l.created_at as "createdAt",
                coalesce((select sum(b.qty) from stock_balances b where b.lot_id = l.id), 0) as qty
           from lots l where l.item_id = $1 order by ${order}`,
        [id],
      )).rows;
      const now = new Date();
      const withStatus = rows.map((r: any) => {
        const floorLifeExpiresAt = r.openedAt && item.floorLifeHours ? new Date(new Date(r.openedAt).getTime() + item.floorLifeHours * 3600_000).toISOString() : null;
        return { ...r, floorLifeExpiresAt, status: shelfStatus(r.expiresAt, floorLifeExpiresAt, now) };
      });
      return { item, lots: withStatus };
    });
  });
}
