import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { defaultRoute, plannedMinutes, routeFor, routingOps, validateRoute, type RouteOp } from "../lib/routing";
import { parse, tenant } from "../http/context";

/**
 * W20 — Revizyon bazında rota ve standart süre. Taslak düzenlenir, yayımlanan sürüm değişmez; yeni iş emri
 * en son yayımlanan sürümü kopyalar, açık iş emirleri kendi sürümünde kalır. Termin ve kuyruk bu sürelerle hesaplanır.
 */

const OpInput = z.object({
  seq: z.number().int().min(1).max(9999),
  name: z.string().min(1).max(120),
  workCenterId: z.string().uuid(),
  setupMinutes: z.number().min(0).max(100000),
  minutesPerUnit: z.number().min(0).max(100000),
  isQualityGate: z.boolean().default(false),
  instructions: z.string().max(2000).optional().nullable(),
});

async function loadRouting(db: Db, id: string) {
  const r = await db.query(
    `select r.id, r.product_revision_id as "revisionId", r.version_no as "versionNo", r.status, r.note, r.created_at as "createdAt", cu.name as "createdBy",
            r.published_at as "publishedAt", pu.name as "publishedBy",
            (select count(*) from work_orders w where w.routing_id = r.id)::int as "workOrderCount"
       from routings r left join users cu on cu.id = r.created_by left join users pu on pu.id = r.published_by where r.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw notFound("Rota");
  const ops = await routingOps(db, id);
  return { ...r.rows[0], operations: ops, errors: validateRoute(ops) };
}

async function writeOps(db: Db, routingId: string, ops: z.infer<typeof OpInput>[]) {
  await db.query(`delete from routing_operations where routing_id = $1`, [routingId]);
  for (const o of ops) {
    await db.query(
      `insert into routing_operations (company_id, routing_id, seq, name, work_center_id, setup_minutes, minutes_per_unit, is_quality_gate, instructions)
       values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [routingId, o.seq, o.name.trim(), o.workCenterId, o.setupMinutes, o.minutesPerUnit, o.isQualityGate, o.instructions?.trim() || null],
    );
  }
}

/** Rota özeti: adet için operasyon ve iş merkezi bazında dakika ve gün. */
async function estimateRoute(db: Db, ops: RouteOp[], qty: number) {
  const wcs = await db.query(`select code, daily_minutes from work_centers`);
  const daily = new Map(wcs.rows.map((w) => [w.code as string, Number(w.daily_minutes)]));
  const rows = ops.map((o) => {
    const m = plannedMinutes(o, qty);
    const d = daily.get(o.workCenter) ?? 450;
    return { seq: o.seq, name: o.name, workCenter: o.workCenter, minutes: Math.round(m * 10) / 10, days: Math.max(1, Math.ceil(m / d)) };
  });
  const totalMinutes = rows.reduce((a, r) => a + r.minutes, 0);
  const days = rows.reduce((a, r) => a + r.days, 0);
  const bottleneck = rows.reduce<(typeof rows)[number] | null>((a, r) => (!a || r.minutes > a.minutes ? r : a), null);
  return { qty, operations: rows, totalMinutes: Math.round(totalMinutes), totalHours: Math.round(totalMinutes / 6) / 10, days, bottleneck: bottleneck?.workCenter ?? null };
}

export async function routingRoutes(app: FastifyInstance) {
  app.get("/api/revisions/:id/routings", async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ qty: z.coerce.number().int().min(1).max(100000).default(100) }).parse(req.query);
    return tenant(req, "production.view", async (db) => {
      const rev = await db.query(
        `select pr.id, pr.rev, pr.status, p.code as "productCode", p.name as "productName" from product_revisions pr join products p on p.id = pr.product_id where pr.id = $1`,
        [id],
      );
      if (!rev.rows[0]) throw notFound("Revizyon");
      const vs = await db.query(`select id from routings where product_revision_id = $1 order by version_no desc`, [id]);
      const versions = [];
      for (const v of vs.rows) versions.push(await loadRouting(db, v.id));
      const active = await routeFor(db, id);
      const openWos = await db.query(
        `select w.code, w.status, rt.version_no as "routingVersionNo" from work_orders w left join routings rt on rt.id = w.routing_id
          where w.product_revision_id = $1 and w.status in ('planned', 'released', 'in_progress', 'on_hold') order by w.code`,
        [id],
      );
      return {
        revision: rev.rows[0],
        versions,
        active: { source: active.source, versionNo: active.versionNo, routingId: active.routingId },
        estimate: await estimateRoute(db, active.ops, q.qty),
        openWorkOrders: openWos.rows,
      };
    });
  });

  /** Yeni taslak: yayımlanmış sürümden, belirtilen sürümden ya da varsayılan şablondan kopyalanır. */
  app.post("/api/revisions/:id/routings", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ copyFrom: z.string().uuid().optional(), note: z.string().max(500).optional() }), req.body ?? {});
    return tenant(req, "capacity.manage", async (db, actor) => {
      const rev = await db.query(`select id from product_revisions where id = $1`, [id]);
      if (!rev.rows[0]) throw notFound("Revizyon");
      const draft = await db.query(`select id from routings where product_revision_id = $1 and status = 'draft'`, [id]);
      if (draft.rows[0]) throw conflict("draft_exists", "Bu revizyonda açık bir rota taslağı var", { routingId: draft.rows[0].id });
      let src: RouteOp[];
      if (input.copyFrom) {
        const c = await db.query(`select product_revision_id from routings where id = $1`, [input.copyFrom]);
        if (!c.rows[0]) throw notFound("Kopyalanacak rota");
        src = await routingOps(db, input.copyFrom);
      } else src = (await routeFor(db, id)).ops;
      if (src.some((o) => !o.workCenterId)) src = src.filter((o) => o.workCenterId);
      const n = (await db.query(`select coalesce(max(version_no), 0) + 1 as n from routings where product_revision_id = $1`, [id])).rows[0].n;
      const r = await db.query(
        `insert into routings (company_id, product_revision_id, version_no, note, created_by) values (app_company_id(), $1, $2, $3, $4) returning id`,
        [id, n, input.note ?? null, actor.userId],
      );
      await writeOps(db, r.rows[0].id, src.map((o) => ({ ...o, workCenterId: o.workCenterId!, instructions: o.instructions })));
      await recordEvent(db, actor, { entityType: "product_revision", entityId: id, eventType: "routing.draft_created", after: { versionNo: n, copyFrom: input.copyFrom ?? "current" } });
      return loadRouting(db, r.rows[0].id);
    });
  });

  /** Taslak operasyonlarını değiştirir (tamamı gönderilir). Yayımlanmış sürüm veri tabanı seviyesinde de değişmez. */
  app.put("/api/routings/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ note: z.string().max(500).optional(), operations: z.array(OpInput).max(60) }), req.body);
    return tenant(req, "capacity.manage", async (db, actor) => {
      const r = (await db.query(`select status, product_revision_id from routings where id = $1 for update`, [id])).rows[0];
      if (!r) throw notFound("Rota");
      if (r.status !== "draft") throw conflict("routing_published", "Yayımlanmış rota değiştirilemez; yeni sürüm açın");
      const wc = await db.query(`select id from work_centers where id = any($1)`, [input.operations.map((o) => o.workCenterId)]);
      if (wc.rowCount !== new Set(input.operations.map((o) => o.workCenterId)).size) throw badRequest("Geçersiz iş merkezi");
      await writeOps(db, id, input.operations);
      if (input.note !== undefined) await db.query(`update routings set note = $2 where id = $1`, [id, input.note]);
      return loadRouting(db, id);
    });
  });

  app.post("/api/routings/:id/publish", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ note: z.string().min(3).max(500) }), req.body);
    return tenant(req, "capacity.manage", async (db, actor) => {
      const r = (await db.query(`select status, product_revision_id, version_no from routings where id = $1 for update`, [id])).rows[0];
      if (!r) throw notFound("Rota");
      if (r.status !== "draft") throw conflict("invalid_transition", "Yalnızca taslak rota yayımlanır");
      const ops = await routingOps(db, id);
      const errors = validateRoute(ops);
      if (errors.length) throw conflict("routing_invalid", errors.join("; "), { errors });
      const prev = (await db.query(`select id, version_no from routings where product_revision_id = $1 and status = 'published'`, [r.product_revision_id])).rows;
      await db.query(`update routings set status = 'archived' where product_revision_id = $1 and status = 'published'`, [r.product_revision_id]);
      await db.query(`update routings set status = 'published', note = $2, published_by = $3, published_at = now() where id = $1`, [id, input.note, actor.userId]);
      const open = await db.query(
        `select count(*)::int as n from work_orders where product_revision_id = $1 and status in ('planned', 'released', 'in_progress', 'on_hold')`,
        [r.product_revision_id],
      );
      await recordEvent(db, actor, {
        entityType: "product_revision", entityId: r.product_revision_id, eventType: "routing.published",
        before: prev.length ? { versionNo: prev[0].version_no } : { source: "default" },
        after: { versionNo: r.version_no, operations: ops.map((o) => ({ seq: o.seq, name: o.name, wc: o.workCenter, setup: o.setupMinutes, perUnit: o.minutesPerUnit, gate: o.isQualityGate })) },
        reason: input.note,
      });
      return { ...(await loadRouting(db, id)), openWorkOrdersUnchanged: open.rows[0].n };
    });
  });

  app.post("/api/routings/:id/discard", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "capacity.manage", async (db, actor) => {
      const r = (await db.query(`select status, product_revision_id, version_no from routings where id = $1 for update`, [id])).rows[0];
      if (!r) throw notFound("Rota");
      if (r.status !== "draft") throw conflict("invalid_transition", "Yalnızca taslak silinebilir");
      await db.query(`delete from routing_operations where routing_id = $1`, [id]);
      await db.query(`delete from routings where id = $1`, [id]);
      await recordEvent(db, actor, { entityType: "product_revision", entityId: r.product_revision_id, eventType: "routing.draft_discarded", after: { versionNo: r.version_no } });
      return { id, discarded: true };
    });
  });

  /** Adet için süre özeti (taslak dahil herhangi bir sürüm). */
  app.get("/api/routings/:id/estimate", async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ qty: z.coerce.number().int().min(1).max(100000) }).parse(req.query);
    return tenant(req, "production.view", async (db) => estimateRoute(db, await routingOps(db, id), q.qty));
  });

  /** Varsayılan şablon (rotası olmayan revizyonlar için). */
  app.get("/api/routings/default", async (req) => tenant(req, "production.view", (db) => defaultRoute(db)));
}
