import { approverFromRequest, evaluateApproval } from "../lib/workflow";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { conflict, notFound } from "../lib/errors";
import { closeTasks, nextCode, openTask, recordEvent, type Actor } from "../lib/records";
import { parse, tenant } from "../http/context";

async function loadChange(db: Db, id: string) {
  const r = await db.query(
    `select c.id, c.code, c.title, c.description, c.urgency, c.stop_production as "stopProduction", c.status,
            c.decision_type as "decisionType", c.effectivity, c.open_work_order_decisions as "openWorkOrderDecisions",
            c.decision_note as "decisionNote", c.device_serial as "deviceSerial", c.created_at as "createdAt", c.decided_at as "decidedAt",
            c.product_revision_id as "productRevisionId", p.code as "productCode", pr.rev,
            w.id as "workOrderId", w.code as "workOrderCode", w.status as "workOrderStatus",
            ou.name as "openedBy", du.name as "decidedBy"
       from change_requests c join product_revisions pr on pr.id = c.product_revision_id join products p on p.id = pr.product_id
       left join work_orders w on w.id = c.work_order_id
       left join users ou on ou.id = c.opened_by left join users du on du.id = c.decided_by
      where c.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw notFound("Değişiklik talebi");
  const open = await db.query(
    `select id, code, status, qty from work_orders where product_revision_id = $1 and status in ('planned', 'released', 'in_progress', 'on_hold') order by code`,
    [r.rows[0].productRevisionId],
  );
  return { ...r.rows[0], openWorkOrders: open.rows };
}

const WO_ACTION_TR: Record<string, string> = { hold: "beklet", rework_after: "devam, sonra yeniden işle", cancel_remaining: "kalanı iptal" };

/** W32 devamı: bağlı, henüz tamamlanmamış fason iş(ler)ini "incelemede" işaretler ve satın alma/üretime karar görevi açar. */
async function flagLinkedSubcontractJobs(db: Db, actor: Actor, workOrderId: string, changeCode: string, action: string, note: string) {
  const jobs = await db.query(
    `select id, code from subcontract_jobs where work_order_id = $1 and status not in ('completed', 'rejected', 'cancelled')`,
    [workOrderId],
  );
  for (const j of jobs.rows) {
    const reason = `${changeCode}: bağlı iş emri "${WO_ACTION_TR[action] ?? action}" — bu fason iş için devam/durdur/yeniden işle kararı gerekli`;
    await db.query(`update subcontract_jobs set review_reason = $2 where id = $1`, [j.id, reason]);
    await recordEvent(db, actor, { entityType: "subcontract_job", entityId: j.id, eventType: "review.flagged", after: { changeRequest: changeCode, action }, reason: note });
    await openTask(db, actor.companyId, { kind: "subcontract_review", title: `Fason iş ${j.code}: ${changeCode} kararı sonrası devam/durdur/yeniden işle kararı gerekli`, entityType: "subcontract_job", entityId: j.id, assigneeRole: "purchasing" });
  }
}

async function holdWorkOrder(db: Db, actor: Actor, woId: string, reason: string) {
  const w = await db.query(`select status from work_orders where id = $1 for update`, [woId]);
  if (!w.rows[0]) throw notFound("İş emri");
  const from = w.rows[0].status as string;
  if (!["released", "in_progress"].includes(from)) throw conflict("invalid_transition", `"${from}" durumundaki iş emri bekletilemez`);
  // Bekletmeden önceki durum olayda saklanır; devam ettirmede buraya dönülür.
  await db.query(`update work_orders set status = 'on_hold', hold_reason = $2 where id = $1`, [woId, reason]);
  await recordEvent(db, actor, { entityType: "work_order", entityId: woId, eventType: "status.on_hold", before: { status: from }, after: { status: "on_hold" }, reason });
}

/**
 * Mühendislik değişiklik talebi (prompt §9). Talep BOM'u, revizyonu veya açık işi kendiliğinden değiştirmez:
 * karar kalıcı revizyonsa Ar-Ge yeni revizyon açar ve yayımlar; açık iş emirleri için karar ayrı kaydedilir.
 */
export async function changeRoutes(app: FastifyInstance) {
  app.get("/api/change-requests", async (req) =>
    tenant(req, "change.view", async (db) => {
      const r = await db.query(
        `select c.id, c.code, c.title, c.status, c.urgency, c.stop_production as "stopProduction", c.decision_type as "decisionType",
                c.created_at as "createdAt", p.code as "productCode", pr.rev, w.code as "workOrderCode"
           from change_requests c join product_revisions pr on pr.id = c.product_revision_id join products p on p.id = pr.product_id
           left join work_orders w on w.id = c.work_order_id
          order by (c.status = 'open') desc, c.created_at desc limit 200`,
      );
      return r.rows;
    }),
  );

  app.get("/api/change-requests/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "change.view", (db) => loadChange(db, id));
  });

  app.post("/api/change-requests", async (req) => {
    const input = parse(
      z.object({
        productRevisionId: z.string().uuid().optional(),
        workOrderId: z.string().uuid().optional(),
        deviceSerial: z.string().max(80).optional(),
        title: z.string().min(3).max(200),
        description: z.string().min(10).max(5000),
        urgency: z.enum(["low", "normal", "high", "critical"]).default("normal"),
        stopProduction: z.boolean().default(false),
      }),
      req.body,
    );
    return tenant(req, "change.create", async (db, actor) => {
      let revisionId = input.productRevisionId;
      if (input.workOrderId) {
        const w = await db.query(`select product_revision_id from work_orders where id = $1`, [input.workOrderId]);
        if (!w.rows[0]) throw notFound("İş emri");
        revisionId = w.rows[0].product_revision_id;
      }
      if (!revisionId) throw conflict("revision_required", "Ürün revizyonu veya iş emri seçilmeli");
      const code = await nextCode(db, actor.companyId, "change_request", "DT");
      const r = await db.query(
        `insert into change_requests (company_id, code, product_revision_id, work_order_id, device_serial, title, description, urgency, stop_production, opened_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [code, revisionId, input.workOrderId ?? null, input.deviceSerial ?? null, input.title, input.description, input.urgency, input.stopProduction, actor.userId],
      );
      const id = r.rows[0].id as string;
      await recordEvent(db, actor, { entityType: "change_request", entityId: id, eventType: "created", after: { code, ...input, productRevisionId: revisionId } });
      // Üretimi durdur istenmişse yalnızca bağlı iş emri bekletilir; bu, yetkili karar verene kadar geçicidir.
      if (input.stopProduction && input.workOrderId) await holdWorkOrder(db, actor, input.workOrderId, `${code}: ${input.title}`);
      await openTask(db, actor.companyId, { kind: "change_decision", title: `Değişiklik talebi ${code} — ${input.title}`, entityType: "change_request", entityId: id, assigneeRole: "rd" });
      return loadChange(db, id);
    });
  });

  app.post("/api/change-requests/:id/decide", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.discriminatedUnion("decision", [
        z.object({
          decision: z.literal("approve"),
          decisionType: z.enum(["deviation", "permanent_revision", "stop_production", "field_action"]),
          effectivity: z.string().min(3).max(500),
          note: z.string().min(3).max(2000),
          openWorkOrders: z.array(z.object({ workOrderId: z.string().uuid(), action: z.enum(["continue", "hold", "rework_after", "cancel_remaining"]) })).default([]),
        }),
        z.object({ decision: z.literal("reject"), note: z.string().min(3).max(2000) }),
      ]),
      req.body,
    );
    return tenant(req, "change.decide", async (db, actor) => {
      const c = await db.query(`select * from change_requests where id = $1 for update`, [id]);
      const cr = c.rows[0];
      if (!cr) throw notFound("Değişiklik talebi");
      if (cr.status !== "open") throw conflict("invalid_transition", `Talep "${cr.status}" durumunda`);
      // Kendi talebine karar: onay politikasına göre (varsayılan kapalı; vekâleten kararda vekâlet verenin talebi de sayılır).
      const pol = await evaluateApproval(db, "change_request", approverFromRequest(req, "change.decide"), { requesterId: cr.opened_by, amount: null, currency: null });
      if (!pol.allowed && pol.code === "self_approval") throw conflict("self_approval", "Talebi açan kişi kendi talebine karar veremez (onay politikası)");

      if (input.decision === "reject") {
        await db.query(`update change_requests set status = 'rejected', decision_note = $2, decided_by = $3, decided_at = now() where id = $1`, [id, input.note, actor.userId]);
        await recordEvent(db, actor, { entityType: "change_request", entityId: id, eventType: "status.rejected", before: { status: "open" }, after: { status: "rejected" }, reason: input.note });
      } else {
        // Açık iş emirleri için karar zorunlu: her birinin ne olacağı açıkça yazılır (prompt §9).
        const open = await db.query(
          `select id, code, status from work_orders where product_revision_id = $1 and status in ('planned', 'released', 'in_progress', 'on_hold')`,
          [cr.product_revision_id],
        );
        const given = new Map(input.openWorkOrders.map((o) => [o.workOrderId, o.action]));
        const missing = open.rows.filter((w) => !given.has(w.id)).map((w) => w.code);
        if (missing.length) throw conflict("open_work_orders_undecided", `Açık iş emirleri için karar verilmeli: ${missing.join(", ")}`, { missing });
        const decisions = [];
        for (const w of open.rows) {
          const action = given.get(w.id)!;
          decisions.push({ workOrderId: w.id, code: w.code, action });
          if (action === "hold" && ["released", "in_progress"].includes(w.status)) await holdWorkOrder(db, actor, w.id, `${cr.code}: ${input.note}`);
          if (action === "continue" && w.status === "on_hold") await resume(db, actor, w.id, `${cr.code} kararıyla devam`);
          await recordEvent(db, actor, { entityType: "work_order", entityId: w.id, eventType: "change.decision", after: { changeRequest: cr.code, action }, reason: input.note });
          // W32 devamı: "beklet/yeniden işle/kalanı iptal" kararı, bu işe bağlı henüz tamamlanmamış fason iş(ler)ine
          // otomatik yansımaz (dış firmaya sunucu bir şey söylemez) — yalnız devam/durdur/yeniden işle kararı için işaretlenir.
          if (action !== "continue") await flagLinkedSubcontractJobs(db, actor, w.id, cr.code, action, input.note);
        }
        await db.query(
          `update change_requests set status = 'approved', decision_type = $2, effectivity = $3, open_work_order_decisions = $4, decision_note = $5, decided_by = $6, decided_at = now() where id = $1`,
          [id, input.decisionType, input.effectivity, JSON.stringify(decisions), input.note, actor.userId],
        );
        await recordEvent(db, actor, {
          entityType: "change_request", entityId: id, eventType: "status.approved", before: { status: "open" },
          after: { status: "approved", decisionType: input.decisionType, effectivity: input.effectivity, openWorkOrders: decisions }, reason: input.note,
        });
        if (input.decisionType === "permanent_revision") {
          await openTask(db, actor.companyId, { kind: "change_implement", title: `${cr.code}: yeni revizyon aç ve devret`, entityType: "change_request", entityId: id, assigneeRole: "rd" });
        }
      }
      await closeTasks(db, actor.companyId, "change_decision", id);
      return loadChange(db, id);
    });
  });

  /** Kalıcı revizyon kararının uygulandığı yeni revizyon bağlanır; talep kapanır. */
  app.post("/api/change-requests/:id/implemented", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ note: z.string().min(3).max(2000) }), req.body);
    return tenant(req, "change.decide", async (db, actor) => {
      const c = await db.query(`select status from change_requests where id = $1 for update`, [id]);
      if (!c.rows[0]) throw notFound("Değişiklik talebi");
      if (c.rows[0].status !== "approved") throw conflict("invalid_transition", "Yalnızca onaylanmış talep uygulandı olarak kapatılır");
      await db.query(`update change_requests set status = 'implemented' where id = $1`, [id]);
      await recordEvent(db, actor, { entityType: "change_request", entityId: id, eventType: "status.implemented", before: { status: "approved" }, after: { status: "implemented" }, reason: input.note });
      await closeTasks(db, actor.companyId, "change_implement", id);
      return loadChange(db, id);
    });
  });

  app.post("/api/work-orders/:id/hold", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "production.plan", async (db, actor) => {
      await holdWorkOrder(db, actor, id, input.reason);
      return { id, status: "on_hold" };
    });
  });

  app.post("/api/work-orders/:id/resume", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "production.plan", async (db, actor) => {
      // Durdurma talebi açıkken iş emri devam ettirilemez; karar değişiklik talebinde verilir.
      const blocking = await db.query(`select code from change_requests where work_order_id = $1 and stop_production and status = 'open'`, [id]);
      if (blocking.rows[0]) throw conflict("change_request_open", `${blocking.rows[0].code} açık; üretimi durdurma kararı verilmeden devam edilemez`);
      const status = await resume(db, actor, id, input.reason);
      return { id, status };
    });
  });
}

async function resume(db: Db, actor: Actor, woId: string, reason: string): Promise<string> {
  const w = await db.query(`select status from work_orders where id = $1 for update`, [woId]);
  if (!w.rows[0]) throw notFound("İş emri");
  if (w.rows[0].status !== "on_hold") throw conflict("invalid_transition", "İş emri beklemede değil");
  const started = await db.query(`select count(*)::int as n from work_order_operations where work_order_id = $1 and status <> 'pending'`, [woId]);
  const to = started.rows[0].n > 0 ? "in_progress" : "released";
  await db.query(`update work_orders set status = $2, hold_reason = null where id = $1`, [woId, to]);
  await recordEvent(db, actor, { entityType: "work_order", entityId: woId, eventType: `status.${to}`, before: { status: "on_hold" }, after: { status: to }, reason });
  return to;
}
