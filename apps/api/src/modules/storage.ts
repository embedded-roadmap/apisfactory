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
 * Kullanım süresi (floor life) saatinin başlangıcı: paket açılış anı, ya da daha sonraki bir tamamlanmış
 * kurutma (bake-out) çevrimi varsa o anın hangisi daha yeniyse (raf ömrünü/toplam maruziyeti DEĞİL, yalnız
 * kullanım süresi sayacını sıfırlar — JEDEC J-STD-033 prensibi; tabloyu sabit kodlamıyoruz, bkz. 034 migration).
 */
function floorLifeClockStart(openedAt: string | null, floorLifeResetAt: string | null): string | null {
  if (!openedAt) return null;
  if (!floorLifeResetAt) return openedAt;
  return new Date(floorLifeResetAt).getTime() > new Date(openedAt).getTime() ? floorLifeResetAt : openedAt;
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
                l.floor_life_reset_at as "floorLifeResetAt",
                l.inspection_status as "inspectionStatus", l.created_at as "createdAt",
                coalesce((select sum(b.qty) from stock_balances b where b.lot_id = l.id), 0) as qty
           from lots l where l.item_id = $1 order by ${order}`,
        [id],
      )).rows;
      const now = new Date();
      const withStatus = rows.map((r: any) => {
        const clockStart = floorLifeClockStart(r.openedAt, r.floorLifeResetAt);
        const floorLifeExpiresAt = clockStart && item.floorLifeHours ? new Date(new Date(clockStart).getTime() + item.floorLifeHours * 3600_000).toISOString() : null;
        return { ...r, floorLifeExpiresAt, status: shelfStatus(r.expiresAt, floorLifeExpiresAt, now) };
      });
      return { item, lots: withStatus };
    });
  });

  // ---- Kurutma (bake-out) reçetesi ve çevrimi (W33 devamı) ---------------------------------

  /** Reçete sürümleri değişmez (cost_policies ile aynı desen); yeni sürüm eskisini geçersiz kılmaz. */
  app.get("/api/dryout-recipes", async (req) =>
    tenant(req, "inventory.view", async (db) => {
      const r = await db.query(
        `select dr.id, dr.version_no as "versionNo", dr.msl_level as "mslLevel", dr.item_id as "itemId", i.code as "itemCode",
                dr.temperature_c as "temperatureC", dr.duration_hours as "durationHours", dr.source, dr.note,
                dr.created_at as "createdAt", u.name as "createdBy"
           from dryout_recipes dr left join items i on i.id = dr.item_id left join users u on u.id = dr.created_by
          order by dr.version_no desc`,
      );
      return r.rows;
    }),
  );

  app.post("/api/dryout-recipes", async (req) => {
    const input = parse(
      z.object({
        mslLevel: z.enum(MSL_LEVELS).nullable().optional(),
        itemId: z.string().uuid().nullable().optional(),
        temperatureC: z.number().positive().max(300),
        durationHours: z.number().positive().max(1000),
        source: z.string().min(3).max(300),
        note: z.string().max(1000).optional(),
      }),
      req.body,
    );
    return tenant(req, "item.storage.manage", async (db, actor) => {
      await db.query(`select pg_advisory_xact_lock(hashtext('dryout_recipe:' || app_company_id()::text))`);
      const n = (await db.query(`select coalesce(max(version_no), 0) + 1 as n from dryout_recipes`)).rows[0].n;
      const r = await db.query(
        `insert into dryout_recipes (company_id, version_no, msl_level, item_id, temperature_c, duration_hours, source, note, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [n, input.mslLevel ?? null, input.itemId ?? null, input.temperatureC, input.durationHours, input.source, input.note ?? null, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "dryout_recipe", entityId: r.rows[0].id, eventType: "created", after: { versionNo: n, ...input } });
      return { id: r.rows[0].id, versionNo: n, ...input };
    });
  });

  /** Kurutma çevrimi başlatır: fırın (equipment kind=oven) hizmette ve kalibrasyonu geçerli olmalı; lotta açık çevrim varken ikincisi açılamaz. */
  app.post("/api/lots/:id/dryout/start", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ recipeId: z.string().uuid(), equipmentId: z.string().uuid(), note: z.string().max(1000).optional() }), req.body);
    return tenant(req, "production.execute", async (db, actor) => {
      const lot = await db.query(`select id from lots where id = $1 for update`, [id]);
      if (!lot.rows[0]) throw notFound("Lot");
      const recipe = await db.query(`select id from dryout_recipes where id = $1`, [input.recipeId]);
      if (!recipe.rows[0]) throw notFound("Kurutma reçetesi");
      const eq = (await db.query(`select code, kind, status, calibration_due, calibration_due < current_date as expired from equipment where id = $1`, [input.equipmentId])).rows[0];
      if (!eq) throw notFound("Ekipman");
      if (eq.kind !== "oven") throw conflict("not_oven", `${eq.code} bir kurutma fırını değil`);
      if (eq.status !== "active") throw conflict("equipment_out_of_service", `${eq.code} hizmet dışı`);
      if (eq.expired) throw conflict("calibration_expired", `${eq.code} kalibrasyonu ${eq.calibration_due} tarihinde doldu`);
      const open = await db.query(`select id from dryout_cycles where lot_id = $1 and status = 'in_progress'`, [id]);
      if (open.rows[0]) throw conflict("already_in_progress", "Bu lotta zaten açık bir kurutma çevrimi var");
      const r = await db.query(
        `insert into dryout_cycles (company_id, lot_id, recipe_id, equipment_id, started_by, note)
         values (app_company_id(), $1, $2, $3, $4, $5) returning id, started_at`,
        [id, input.recipeId, input.equipmentId, actor.userId, input.note ?? null],
      );
      await recordEvent(db, actor, { entityType: "lot", entityId: id, eventType: "dryout.started", after: { cycleId: r.rows[0].id, recipeId: input.recipeId, equipmentId: input.equipmentId } });
      return { id: r.rows[0].id, lotId: id, startedAt: r.rows[0].started_at, status: "in_progress" };
    });
  });

  /**
   * Kurutma çevrimini kapatır. Gerçekleşen sıcaklık/süre elle girilir (reçeteden farklı olabilir,
   * uydurulmaz). Yalnızca 'completed' sonucu kullanım süresi (floor life) saatini sıfırlar — raf ömrünü
   * (toplam maruziyet) etkilemez; 'aborted' hiçbir şeyi sıfırlamaz.
   */
  app.post("/api/lots/:id/dryout/:cycleId/complete", async (req) => {
    const { id, cycleId } = req.params as { id: string; cycleId: string };
    const input = parse(
      z.object({ status: z.enum(["completed", "aborted"]), actualTemperatureC: z.number().positive().max(300).optional(), actualDurationHours: z.number().positive().max(1000).optional(), note: z.string().max(1000).optional() }),
      req.body,
    );
    return tenant(req, "production.execute", async (db, actor) => {
      const c = await db.query(`select status from dryout_cycles where id = $1 and lot_id = $2 for update`, [cycleId, id]);
      if (!c.rows[0]) throw notFound("Kurutma çevrimi");
      if (c.rows[0].status !== "in_progress") throw conflict("not_in_progress", "Bu çevrim zaten kapatılmış");
      const r = await db.query(
        `update dryout_cycles set status = $3, ended_at = now(), ended_by = $4, actual_temperature_c = $5, actual_duration_hours = $6, note = coalesce($7, note)
          where id = $1 and lot_id = $2 returning ended_at`,
        [cycleId, id, input.status, actor.userId, input.actualTemperatureC ?? null, input.actualDurationHours ?? null, input.note ?? null],
      );
      let floorLifeResetAt: string | null = null;
      if (input.status === "completed") {
        floorLifeResetAt = r.rows[0].ended_at;
        await db.query(`update lots set floor_life_reset_at = $2 where id = $1`, [id, floorLifeResetAt]);
      }
      await recordEvent(db, actor, { entityType: "lot", entityId: id, eventType: `dryout.${input.status}`, after: { cycleId, ...input, floorLifeResetAt } });
      return { id: cycleId, lotId: id, status: input.status, endedAt: r.rows[0].ended_at, floorLifeResetAt };
    });
  });

  app.get("/api/lots/:id/dryout", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "inventory.view", async (db) => {
      const r = await db.query(
        `select dc.id, dc.status, dc.started_at as "startedAt", dc.ended_at as "endedAt", dc.actual_temperature_c as "actualTemperatureC",
                dc.actual_duration_hours as "actualDurationHours", dc.note, dr.version_no as "recipeVersionNo", dr.temperature_c as "recipeTemperatureC",
                dr.duration_hours as "recipeDurationHours", eq.code as "equipmentCode", su.name as "startedBy", eu.name as "endedBy"
           from dryout_cycles dc join dryout_recipes dr on dr.id = dc.recipe_id join equipment eq on eq.id = dc.equipment_id
           left join users su on su.id = dc.started_by left join users eu on eu.id = dc.ended_by
          where dc.lot_id = $1 order by dc.started_at desc`,
        [id],
      );
      return r.rows;
    });
  });
}
