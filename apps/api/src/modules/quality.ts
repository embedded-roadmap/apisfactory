import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { conflict, notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { parse, tenant } from "../http/context";

const LimitInput = z.object({
  name: z.string().min(1).max(60),
  unit: z.string().max(16).optional(),
  low: z.number().optional(),
  high: z.number().optional(),
  required: z.boolean().default(true),
});

export async function loadTestPlan(db: Db, id: string) {
  const p = await db.query(
    `select id, product_revision_id as "productRevisionId", version_no as "versionNo", status, published_at as "publishedAt" from test_plans where id = $1`,
    [id],
  );
  if (!p.rows[0]) throw notFound("Test planı");
  const l = await db.query(
    `select name, unit, low::float8 as low, high::float8 as high, required from test_limits where test_plan_id = $1 order by seq`,
    [id],
  );
  return { ...p.rows[0], limits: l.rows };
}

/** Revizyonun yürürlükteki (en son yayımlanmış) test planı. */
export async function activeTestPlan(db: Db, revisionId: string): Promise<string | null> {
  const r = await db.query(
    `select id from test_plans where product_revision_id = $1 and status = 'published' order by version_no desc limit 1`,
    [revisionId],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * Kalite: test planı ve limit sürümleri, ekipman ve kalibrasyon, revizyon firmware'i (prompt §8, §16).
 * Limit değişikliği yeni sürümdür; eski test sonuçlarının kararı değişmez; iş emri açıldığı andaki sürümü sabitler.
 */
export async function qualityRoutes(app: FastifyInstance) {
  app.get("/api/revisions/:id/test-plans", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "product.view", async (db) => {
      const r = await db.query(`select id from test_plans where product_revision_id = $1 order by version_no`, [id]);
      const out = [];
      for (const x of r.rows) out.push(await loadTestPlan(db, x.id));
      return out;
    });
  });

  app.post("/api/revisions/:id/test-plans", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ limits: z.array(LimitInput).min(1).max(200) }), req.body);
    return tenant(req, "quality.plan.manage", async (db, actor) => {
      const rev = await db.query(`select id from product_revisions where id = $1`, [id]);
      if (!rev.rows[0]) throw notFound("Revizyon");
      const names = new Set<string>();
      for (const l of input.limits) {
        if (names.has(l.name)) throw conflict("duplicate", `Ölçüm adı tekrar ediyor: ${l.name}`);
        names.add(l.name);
        if (l.low !== undefined && l.high !== undefined && l.low > l.high) throw conflict("invalid_limit", `${l.name}: alt limit üst limitten büyük`);
      }
      const n = (await db.query(`select coalesce(max(version_no), 0) + 1 as n from test_plans where product_revision_id = $1`, [id])).rows[0].n;
      const p = await db.query(
        `insert into test_plans (company_id, product_revision_id, version_no, created_by) values (app_company_id(), $1, $2, $3) returning id`,
        [id, n, actor.userId],
      );
      for (const [i, l] of input.limits.entries()) {
        await db.query(
          `insert into test_limits (company_id, test_plan_id, seq, name, unit, low, high, required) values (app_company_id(), $1, $2, $3, $4, $5, $6, $7)`,
          [p.rows[0].id, i + 1, l.name, l.unit ?? null, l.low ?? null, l.high ?? null, l.required],
        );
      }
      await recordEvent(db, actor, { entityType: "test_plan", entityId: p.rows[0].id, eventType: "created", after: { revisionId: id, versionNo: n, limits: input.limits } });
      return loadTestPlan(db, p.rows[0].id);
    });
  });

  app.post("/api/test-plans/:id/publish", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "quality.plan.manage", async (db, actor) => {
      const p = await db.query(`select status from test_plans where id = $1 for update`, [id]);
      if (!p.rows[0]) throw notFound("Test planı");
      if (p.rows[0].status !== "draft") throw conflict("invalid_transition", "Yalnızca taslak test planı yayımlanır");
      await db.query(`update test_plans set status = 'published', published_at = now() where id = $1`, [id]);
      await recordEvent(db, actor, { entityType: "test_plan", entityId: id, eventType: "status.published", before: { status: "draft" }, after: { status: "published" } });
      return loadTestPlan(db, id);
    });
  });

  /** Firmware sürümü ve SHA-256 özeti devir paketine girer; devirdeki veya yayımlanmış revizyonda değiştirilemez. */
  app.post("/api/revisions/:id/firmware", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ version: z.string().min(1).max(60), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }), req.body);
    return tenant(req, "product.create", async (db, actor) => {
      const r = await db.query(`select status, firmware_version from product_revisions where id = $1 for update`, [id]);
      if (!r.rows[0]) throw notFound("Revizyon");
      if (["handover_review", "released"].includes(r.rows[0].status)) {
        throw conflict("revision_locked", "Devirdeki veya yayımlanmış revizyonun firmware'i değiştirilemez; yeni revizyon açın");
      }
      await db.query(`update product_revisions set firmware_version = $2, firmware_sha256 = $3 where id = $1`, [id, input.version, input.sha256 ?? null]);
      await recordEvent(db, actor, { entityType: "product_revision", entityId: id, eventType: "firmware.set", before: { version: r.rows[0].firmware_version }, after: input });
      return { revisionId: id, firmwareVersion: input.version, firmwareSha256: input.sha256 ?? null };
    });
  });

  app.get("/api/equipment", async (req) =>
    tenant(req, "production.view", async (db) => {
      const r = await db.query(
        `select id, code, name, kind, status, calibration_due as "calibrationDue",
                (calibration_due is not null and calibration_due < current_date) as "calibrationExpired"
           from equipment order by code`,
      );
      return r.rows;
    }),
  );

  app.post("/api/equipment", async (req) => {
    const input = parse(
      z.object({ code: z.string().min(1).max(40), name: z.string().min(1).max(120), kind: z.enum(["test_station", "measuring", "fixture", "programmer"]), calibrationDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
      req.body,
    );
    return tenant(req, "equipment.manage", async (db, actor) => {
      const r = await db.query(
        `insert into equipment (company_id, code, name, kind, calibration_due) values (app_company_id(), $1, $2, $3, $4) returning id`,
        [input.code, input.name, input.kind, input.calibrationDue ?? null],
      );
      await recordEvent(db, actor, { entityType: "equipment", entityId: r.rows[0].id, eventType: "created", after: input });
      return { id: r.rows[0].id, ...input };
    });
  });

  app.post("/api/equipment/:id/calibration", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({ calibratedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), certificate: z.string().max(200).optional() }),
      req.body,
    );
    return tenant(req, "equipment.manage", async (db, actor) => {
      const e = await db.query(`select calibration_due from equipment where id = $1 for update`, [id]);
      if (!e.rows[0]) throw notFound("Ekipman");
      await db.query(
        `insert into calibration_records (company_id, equipment_id, calibrated_on, valid_until, certificate, recorded_by) values (app_company_id(), $1, $2, $3, $4, $5)`,
        [id, input.calibratedOn, input.validUntil, input.certificate ?? null, actor.userId],
      );
      await db.query(`update equipment set calibration_due = $2 where id = $1`, [id, input.validUntil]);
      await recordEvent(db, actor, { entityType: "equipment", entityId: id, eventType: "calibrated", before: { calibrationDue: e.rows[0].calibration_due }, after: input });
      return { id, calibrationDue: input.validUntil };
    });
  });

  app.post("/api/equipment/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ status: z.enum(["active", "out_of_service"]), reason: z.string().min(3) }), req.body);
    return tenant(req, "equipment.manage", async (db, actor) => {
      const e = await db.query(`select status from equipment where id = $1 for update`, [id]);
      if (!e.rows[0]) throw notFound("Ekipman");
      await db.query(`update equipment set status = $2 where id = $1`, [id, input.status]);
      await recordEvent(db, actor, { entityType: "equipment", entityId: id, eventType: `status.${input.status}`, before: { status: e.rows[0].status }, after: { status: input.status }, reason: input.reason });
      return { id, status: input.status };
    });
  });

  /** Sonradan sorunlu bulunan ekipmanla yapılmış testler ve etkilenen cihazlar (prompt §16). */
  app.get("/api/equipment/:id/affected-tests", async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    return tenant(req, "production.view", async (db) => {
      const r = await db.query(
        `select d.serial, d.status as "deviceStatus", t.run_no as "runNo", t.result, t.created_at as "testedAt", w.code as "workOrderCode"
           from test_runs t join devices d on d.id = t.device_id join work_orders w on w.id = d.work_order_id
          where t.equipment_id = $1 and ($2::date is null or t.created_at >= $2::date)
          order by t.created_at`,
        [id, q.from ?? null],
      );
      return r.rows;
    });
  });
}
