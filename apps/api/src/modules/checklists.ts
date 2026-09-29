import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conflict, forbidden, notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { can, parse, tenant } from "../http/context";
import { CheckItem, applicablePlans, checkStatus, evaluate, type Context } from "../lib/checklists";

/**
 * R16/R17/R18 — kontrol listeleri (ayrıntı: lib/checklists.ts).
 * Plan yazma yalnız kalite (quality.plan.manage) — operatör limit değiştiremez. Kayıt: giriş kontrolü kalite veya
 * teknisyen, ara/son/paketleme üretim uygulayıcısı veya kalite. Kapanış kuralları üretim ve mal kabul uçlarında uygulanır.
 */

const ContextInput = z.object({ contextType: z.enum(["operation", "receipt_line", "work_order"]), contextId: z.string().uuid() });

export async function checklistRoutes(app: FastifyInstance) {
  app.get("/api/check-plans", async (req) => {
    const q = z.object({ stage: z.enum(["incoming", "in_process", "final", "packing"]).optional(), all: z.string().optional() }).parse(req.query);
    return tenant(req, "production.view", async (db) =>
      (await db.query(
        `select p.id, p.code, p.version_no as "versionNo", p.name, p.stage, p.active, p.items, p.note, pr.rev, pp.code as "productCode",
                wc.code as "workCenterCode", i.code as "itemCode", u.name as "createdBy", p.created_at as "createdAt",
                (p.version_no = (select max(x.version_no) from check_plans x where x.code = p.code)) as current
           from check_plans p left join product_revisions pr on pr.id = p.product_revision_id left join products pp on pp.id = pr.product_id
           left join work_centers wc on wc.id = p.work_center_id left join items i on i.id = p.item_id left join users u on u.id = p.created_by
          where ($1::text is null or p.stage = $1)
            and ($2::boolean or p.version_no = (select max(x.version_no) from check_plans x where x.code = p.code))
          order by p.code, p.version_no desc`,
        [q.stage ?? null, q.all === "1"],
      )).rows,
    );
  });

  /** Yeni plan veya mevcut kodun yeni sürümü (önceki sürümler değişmez; açık kapanışlar güncel sürümü ister). */
  app.post("/api/check-plans", async (req) => {
    const input = parse(
      z.object({
        code: z.string().regex(/^[A-Z0-9-]{2,30}$/),
        name: z.string().min(3).max(200),
        stage: z.enum(["incoming", "in_process", "final", "packing"]),
        productRevisionId: z.string().uuid().optional(),
        workCenterCode: z.string().optional(),
        itemId: z.string().uuid().optional(),
        items: z.array(CheckItem).min(1).max(60),
        active: z.boolean().default(true),
        note: z.string().min(3).max(500),
      }),
      req.body,
    );
    return tenant(req, "quality.plan.manage", async (db, actor) => {
      const keys = new Set<string>();
      for (const it of input.items) {
        if (keys.has(it.key)) throw conflict("duplicate", `Madde anahtarı tekrar ediyor: ${it.key}`);
        keys.add(it.key);
        if (it.kind === "measure" && it.low === undefined && it.high === undefined) throw conflict("invalid_limit", `${it.label}: ölçüm için en az bir sınır gerekli`);
        if (it.low !== undefined && it.high !== undefined && it.low > it.high) throw conflict("invalid_limit", `${it.label}: alt sınır üst sınırdan büyük`);
      }
      if (input.itemId && input.stage !== "incoming") throw conflict("invalid_scope", "Kalem bağlamı yalnız giriş kontrolünde");
      if (input.workCenterCode && !["in_process", "packing"].includes(input.stage)) throw conflict("invalid_scope", "İş merkezi bağlamı yalnız ara kontrol ve paketlemede");
      let wcId: string | null = null;
      if (input.workCenterCode) {
        wcId = (await db.query(`select id from work_centers where code = $1`, [input.workCenterCode])).rows[0]?.id ?? null;
        if (!wcId) throw notFound("İş merkezi");
      }
      await db.query(`select pg_advisory_xact_lock(hashtext('check_plan:' || app_company_id()::text || $1))`, [input.code]);
      const prev = (await db.query(`select stage, version_no from check_plans where code = $1 order by version_no desc limit 1`, [input.code])).rows[0];
      if (prev && prev.stage !== input.stage) throw conflict("stage_change", `Plan aşaması değiştirilemez (${prev.stage}); yeni kod açın`);
      const n = (prev?.version_no ?? 0) + 1;
      const r = await db.query(
        `insert into check_plans (company_id, code, version_no, name, stage, product_revision_id, work_center_id, item_id, items, active, note, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [input.code, n, input.name, input.stage, input.productRevisionId ?? null, wcId, input.itemId ?? null, JSON.stringify(input.items), input.active, input.note, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "check_plan", entityId: r.rows[0].id, eventType: prev ? "revised" : "created", after: { ...input, versionNo: n }, reason: input.note });
      return { id: r.rows[0].id as string, versionNo: n };
    });
  });

  app.get("/api/check-status", async (req) => {
    const q = ContextInput.parse(req.query);
    return tenant(req, "production.view", (db) => checkStatus(db, { type: q.contextType, id: q.contextId }));
  });

  /** Kontrol kaydı: karar sunucuda; başarısız kayıt da saklanır (silinmez), yeniden kontrol yeni kayıttır. */
  app.post("/api/check-records", async (req) => {
    const input = parse(
      ContextInput.extend({
        planId: z.string().uuid(),
        results: z.array(z.object({ key: z.string().max(40), value: z.union([z.boolean(), z.number(), z.string().max(2000)]).nullable() })).max(60),
      }),
      req.body,
    );
    const allowed = input.contextType === "receipt_line"
      ? can(req, "quality.incoming.decide") || can(req, "production.execute")
      : can(req, "production.execute") || can(req, "production.test.record") || can(req, "quality.final.release");
    if (!allowed) throw forbidden("production.execute");
    return tenant(req, null, async (db, actor) => {
      const ctx: Context = { type: input.contextType, id: input.contextId };
      const plans = await applicablePlans(db, ctx);
      const plan = plans.find((p) => p.id === input.planId);
      if (!plan) {
        const exists = await db.query(`select 1 from check_plans where id = $1`, [input.planId]);
        if (!exists.rowCount) throw notFound("Kontrol planı");
        throw conflict("plan_not_applicable", "Plan bu kayda uygulanmıyor veya güncel sürüm değil");
      }
      const ev = evaluate(plan.items, input.results);
      const r = await db.query(
        `insert into check_records (company_id, plan_id, context_type, context_id, results, passed, findings, recorded_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [plan.id, ctx.type, ctx.id, JSON.stringify(ev.results), ev.passed, JSON.stringify(ev.findings), actor.userId],
      );
      await recordEvent(db, actor, { entityType: "check_record", entityId: r.rows[0].id, eventType: ev.passed ? "passed" : "failed", after: { plan: `${plan.code} v${plan.version_no}`, context: ctx, findings: ev.findings } });
      return { id: r.rows[0].id as string, passed: ev.passed, findings: ev.findings };
    });
  });
}
