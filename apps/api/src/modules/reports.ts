/**
 * W30/W31 (oturumun 2026-09-26 devam talimatı §6/§7): yönetici raporları ve stratejik AI önerileri.
 *
 * Akış: GET /api/reports/executive canlı hesaplar (kaydetmez). POST /api/reports/generate hesaplayıp
 * report_findings olarak kalıcı kayıt açar; onay gerektiren bulgular için sorumlu role inceleme görevi
 * açılır (görev açma reddedilmez — insan kararı gerekir). POST /findings/:id/decision o görevi
 * approve/reject/defer ile kapatır; approve ai_suggestions kaydı ve (W31) uygulama görevi açar.
 * measure/verify/reopen: beklenen faydayı gözlenenden ayrı tutar, bağımsız doğrulama zorunlu kılar.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { closeTasks, openTask, recordEvent } from "../lib/records";
import { parse, tenant } from "../http/context";
import { computeArea, REPORT_AREAS, type ReportArea, type ReportScope } from "../lib/report-findings";
import { aiConfig, generateNarratives } from "../lib/ai-narrative";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const Period = z.object({
  periodKind: z.enum(["weekly", "monthly", "yearly"]),
  from: z.string().regex(DATE),
  to: z.string().regex(DATE),
  productId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
});

async function computeAllAreas(db: Db, from: string, to: string, scope: ReportScope) {
  const out = {} as Record<ReportArea, Awaited<ReturnType<typeof computeArea>>>;
  for (const area of REPORT_AREAS) out[area] = await computeArea(db, area, from, to, scope);
  return out;
}

export async function reportsRoutes(app: FastifyInstance) {
  /** Canlı yönetici raporu: 8 alanı kural tabanlı (deterministik) hesaplar, kaydetmez. AI yorumu yalnız kaydedilmiş
   * bulgular için üretilir (POST /api/reports/findings/narrate) — canlı hesapta serbest metin AI yorumu yoktur. */
  app.get("/api/reports/executive", async (req) => {
    const q = parse(Period, req.query);
    return tenant(req, "report.view", async (db) => {
      const areas = await computeAllAreas(db, q.from, q.to, { productId: q.productId ?? null, supplierId: q.supplierId ?? null });
      const ai = aiConfig();
      return {
        periodKind: q.periodKind, from: q.from, to: q.to, scope: { productId: q.productId ?? null, supplierId: q.supplierId ?? null },
        aiStatus: "unavailable",
        aiConfigured: ai.available,
        aiNote: ai.available
          ? `Bulgular gerçek verilerden kural tabanlı üretildi. AI yorumu (${ai.model}) raporu kaydettikten sonra kayıtlı bulgular için istenebilir.`
          : "AI servisi (LLM) yapılandırılmadı: bulgular gerçek verilerden kural tabanlı üretildi; serbest metin yorum beklemededir.",
        areas,
      };
    });
  });

  app.get("/api/reports/ai-status", async (req) => tenant(req, "report.view", async () => aiConfig()));

  /**
   * Kayıtlı bulgulara AI yorumu (madde 3). Sağlayıcı çağrısı veri tabanı işlemi DIŞINDA yapılır (uzun sürebilir):
   * 1) bulgular okunur, 2) Claude çağrılır, 3) yalnız hâlâ yorumsuz olanlara yazılır (yarış koruması).
   * Bulgunun sayısal alanları ve cause_type değişmez; yorum bir kez üretilir. Maliyet doğurduğu için karar yetkisi ister.
   */
  app.post("/api/reports/findings/narrate", async (req) => {
    const input = parse(z.object({ findingIds: z.array(z.string().uuid()).min(1).max(20) }), req.body);
    const pending = await tenant(req, "report.suggestion.decide", async (db) =>
      (
        await db.query(
          `select id, area, period_from::text as "periodFrom", period_to::text as "periodTo", finding, evidence, cause_type as "causeType",
                  cause_text as "causeText", action_options as "actionOptions", uncertainty, success_metric as "successMetric"
             from report_findings where id = any($1::uuid[]) and ai_status = 'unavailable' order by area`,
          [input.findingIds],
        )
      ).rows,
    );
    if (!pending.length) return { generated: [], skipped: input.findingIds, model: null };
    const out = await generateNarratives(pending);
    return tenant(req, "report.suggestion.decide", async (db, actor) => {
      const generated: string[] = [];
      for (const [id, narrative] of out.narratives) {
        const r = await db.query(
          `update report_findings set ai_status = 'generated', ai_narrative = $2, ai_model = $3, ai_generated_at = now(), ai_generated_by = $4
            where id = $1 and ai_status = 'unavailable'`,
          [id, narrative, out.model, actor.userId],
        );
        if (!r.rowCount) continue;
        generated.push(id);
        await recordEvent(db, actor, { entityType: "report_finding", entityId: id, eventType: "ai_narrative.generated", after: { model: out.model, chars: narrative.length } });
      }
      return { generated, skipped: input.findingIds.filter((x) => !generated.includes(x)), model: out.model };
    });
  });

  /** Bulguları kalıcı kaydeder; onay gerektirenler için sorumlu role inceleme görevi açar. */
  app.post("/api/reports/generate", async (req) => {
    const q = parse(Period, req.body);
    return tenant(req, "report.view", async (db, actor) => {
      const areas = await computeAllAreas(db, q.from, q.to, { productId: q.productId ?? null, supplierId: q.supplierId ?? null });
      const created = [];
      for (const area of REPORT_AREAS) {
        const d = areas[area];
        const r = await db.query(
          `insert into report_findings (company_id, area, period_kind, period_from, period_to, scope, finding, evidence, source_refs,
                                         cause_type, cause_text, action_options, expected_impact, uncertainty, responsible_role,
                                         requires_approval, success_metric, measurement_due_at, generated_by)
           values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id`,
          [
            area, q.periodKind, q.from, q.to, JSON.stringify({ productId: q.productId ?? null, supplierId: q.supplierId ?? null }),
            d.finding, JSON.stringify(d.evidence), JSON.stringify(d.sourceRefs), d.causeType, d.causeText,
            JSON.stringify(d.actionOptions), d.expectedImpact === null ? null : JSON.stringify(d.expectedImpact), d.uncertainty,
            d.responsibleRole, d.requiresApproval, d.successMetric, d.measurementDueAt, actor.userId,
          ],
        );
        const id = r.rows[0].id as string;
        await recordEvent(db, actor, { entityType: "report_finding", entityId: id, eventType: "generated", after: { area, causeType: d.causeType } });
        if (d.requiresApproval) {
          await openTask(db, actor.companyId, {
            kind: "report_finding_review", title: `Yönetici raporu bulgusu incelenmeli: ${area}`, entityType: "report_finding", entityId: id, assigneeRole: d.responsibleRole,
          });
        }
        created.push({ id, area, causeType: d.causeType, requiresApproval: d.requiresApproval });
      }
      return { periodKind: q.periodKind, from: q.from, to: q.to, findings: created };
    });
  });

  app.get("/api/reports/findings/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "report.view", async (db) => {
      const r = await db.query(`select * from report_findings where id = $1`, [id]);
      if (!r.rows[0]) throw notFound("Bulgu");
      return r.rows[0];
    });
  });

  app.get("/api/reports/findings", async (req) => {
    const q = z.object({ area: z.enum(REPORT_AREAS).optional(), status: z.enum(["pending", "decided"]).optional() }).parse(req.query);
    return tenant(req, "report.view", async (db) => {
      const r = await db.query(
        `select f.*, s.id as "suggestionId", s.status as "suggestionStatus"
           from report_findings f left join ai_suggestions s on s.finding_id = f.id
          where ($1::text is null or f.area = $1)
          order by f.created_at desc limit 200`,
        [q.area ?? null],
      );
      const rows = q.status === "pending" ? r.rows.filter((x) => x.requires_approval && !x.suggestionId) : q.status === "decided" ? r.rows.filter((x) => x.suggestionId) : r.rows;
      return rows;
    });
  });

  /** İnceleme kararı: onay → ai_suggestions + uygulama görevi açılır. Red/erteleme → yalnız gerekçe kaydı. */
  app.post("/api/reports/findings/:id/decision", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        decision: z.enum(["approve", "reject", "defer"]),
        reason: z.string().min(3).max(1000),
        baselineMetric: z.string().min(1).max(120).optional(),
        baselineValue: z.number().optional(),
        targetValue: z.number().optional(),
        measurementIntervalDays: z.number().int().positive().optional(),
        dataSource: z.string().min(1).max(200).optional(),
        implementationCost: z.number().min(0).optional(),
        assigneeRole: z.string().min(1).max(60).optional(),
        targetDate: z.string().regex(DATE).optional(),
        budget: z.number().min(0).optional(),
      }),
      req.body,
    );
    return tenant(req, "report.suggestion.decide", async (db, actor) => {
      const f = (await db.query(`select * from report_findings where id = $1 for update`, [id])).rows[0];
      if (!f) throw notFound("Bulgu");
      if (!f.requires_approval) throw conflict("no_decision_needed", "Bu bulgu veri yetersizliği nedeniyle karar gerektirmiyor");
      const existing = (await db.query(`select id from ai_suggestions where finding_id = $1`, [id])).rows[0];
      if (existing) throw conflict("already_decided", "Bu bulgu için zaten bir öneri kaydı var (aynı bulgudan ikinci görev açılmaz)");

      if (input.decision === "approve") {
        if (!input.baselineMetric || input.baselineValue === undefined || input.targetValue === undefined || !input.measurementIntervalDays) {
          throw badRequest("Onay için baselineMetric, baselineValue, targetValue ve measurementIntervalDays gerekli");
        }
        const r = await db.query(
          `insert into ai_suggestions (company_id, finding_id, status, decided_by, decided_at, decision_reason,
                                        baseline_metric, baseline_value, baseline_scope, target_value, measurement_interval_days,
                                        data_source, implementation_cost, created_by)
           values (app_company_id(), $1, 'approved', $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $2) returning id`,
          [
            id, actor.userId, input.reason, input.baselineMetric, input.baselineValue, JSON.stringify(f.scope), input.targetValue,
            input.measurementIntervalDays, input.dataSource ?? null, input.implementationCost ?? null,
          ],
        );
        const suggestionId = r.rows[0].id as string;
        const assigneeRole = input.assigneeRole ?? f.responsible_role;
        await openTask(db, actor.companyId, {
          kind: "ai_suggestion_implementation",
          title: `Öneri uygulaması: ${f.finding}`.slice(0, 200),
          entityType: "ai_suggestion", entityId: suggestionId, assigneeRole,
        });
        const task = await db.query(
          `select id from tasks where company_id = $1 and kind = 'ai_suggestion_implementation' and entity_id = $2 and assignee_role = $3`,
          [actor.companyId, suggestionId, assigneeRole],
        );
        await db.query(`update ai_suggestions set task_id = $2 where id = $1`, [suggestionId, task.rows[0].id]);
        await recordEvent(db, actor, { entityType: "ai_suggestion", entityId: suggestionId, eventType: "approved", after: { findingId: id, targetValue: input.targetValue }, reason: input.reason });
        await closeTasks(db, actor.companyId, "report_finding_review", id, f.responsible_role);
        return { decision: "approve", suggestionId };
      }

      // reject / defer: görev sonuçlanır, öneri açılmaz.
      const status = input.decision === "reject" ? "rejected" : "deferred";
      const r = await db.query(
        `insert into ai_suggestions (company_id, finding_id, status, decided_by, decided_at, decision_reason, created_by)
         values (app_company_id(), $1, $2, $3, now(), $4, $3) returning id`,
        [id, status, actor.userId, input.reason],
      );
      await recordEvent(db, actor, { entityType: "ai_suggestion", entityId: r.rows[0].id, eventType: input.decision, after: { findingId: id }, reason: input.reason });
      await closeTasks(db, actor.companyId, "report_finding_review", id, f.responsible_role);
      return { decision: input.decision, suggestionId: r.rows[0].id };
    });
  });

  /** Gözlenen değeri kaydeder. Ölçen kişi doğrulayamaz (bağımsız doğrulama W31). */
  app.post("/api/reports/suggestions/:id/measure", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ measuredValue: z.number() }), req.body);
    return tenant(req, "report.suggestion.decide", async (db, actor) => {
      const s = (await db.query(`select * from ai_suggestions where id = $1 for update`, [id])).rows[0];
      if (!s) throw notFound("Öneri");
      if (s.status !== "approved") throw conflict("not_approved", `"${s.status}" durumundaki öneri ölçülemez`);
      if (s.closed_at) throw conflict("closed", "Kapatılmış öneri; önce yeniden aç");
      await db.query(`update ai_suggestions set measured_value = $2, measured_at = now(), measured_by = $3 where id = $1`, [id, input.measuredValue, actor.userId]);
      await recordEvent(db, actor, { entityType: "ai_suggestion", entityId: id, eventType: "measured", after: { measuredValue: input.measuredValue } });
      return { id, measuredValue: input.measuredValue };
    });
  });

  /** Bağımsız doğrulama ve kapama. Beklenen fayda (hedef − baz) ile gözlenen fark ayrı raporlanır;
   * fark otomatik olarak tümüyle AI'ya atfedilmez (para birimi/karma/eşzamanlı değişiklik göz önünde tutulmalı). */
  app.post("/api/reports/suggestions/:id/verify", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ note: z.string().max(1000).optional() }), req.body);
    return tenant(req, "report.suggestion.decide", async (db, actor) => {
      const s = (await db.query(`select * from ai_suggestions where id = $1 for update`, [id])).rows[0];
      if (!s) throw notFound("Öneri");
      if (s.measured_value === null) throw conflict("not_measured", "Önce gözlenen değer kaydedilmeli");
      if (s.measured_by === actor.userId) throw forbidden("independent_verification: ölçen kişi doğrulayamaz");
      if (s.closed_at) throw conflict("already_closed", "Zaten kapatılmış");
      const expectedDiff = s.target_value !== null && s.baseline_value !== null ? Number(s.target_value) - Number(s.baseline_value) : null;
      const observedDiff = Number(s.measured_value) - Number(s.baseline_value);
      const netDiff = s.implementation_cost !== null ? observedDiff - Number(s.implementation_cost) : observedDiff;
      await db.query(`update ai_suggestions set verified_by = $2, status = 'closed', closed_at = now() where id = $1`, [id, actor.userId]);
      await recordEvent(db, actor, {
        entityType: "ai_suggestion", entityId: id, eventType: "verified",
        after: { expectedDiff, observedDiff, netDiff, note: input.note ?? null },
        reason: "Bağımsız doğrulama: gözlenen fark ölçen kişiden farklı biri tarafından onaylandı",
      });
      return { id, expectedDiff, observedDiff, netDiff, note: "Fark yalnızca bu öneriye atfedilir varsayımıyla hesaplanmıştır; para birimi, ürün karması ve eşzamanlı değişiklikler ayrıca değerlendirilmelidir." };
    });
  });

  app.post("/api/reports/suggestions/:id/reopen", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(1000) }), req.body);
    return tenant(req, "report.suggestion.decide", async (db, actor) => {
      const s = (await db.query(`select * from ai_suggestions where id = $1 for update`, [id])).rows[0];
      if (!s) throw notFound("Öneri");
      if (!s.closed_at) throw conflict("not_closed", "Yalnızca kapatılmış öneri yeniden açılabilir");
      await db.query(
        `update ai_suggestions set status = 'approved', closed_at = null, verified_by = null, reopened_count = reopened_count + 1 where id = $1`,
        [id],
      );
      await recordEvent(db, actor, { entityType: "ai_suggestion", entityId: id, eventType: "reopened", reason: input.reason });
      return { id, reopenedCount: s.reopened_count + 1 };
    });
  });

  app.get("/api/reports/suggestions/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "report.view", async (db) => {
      const r = await db.query(`select * from ai_suggestions where id = $1`, [id]);
      if (!r.rows[0]) throw notFound("Öneri");
      return r.rows[0];
    });
  });
}

export type { ReportArea };
