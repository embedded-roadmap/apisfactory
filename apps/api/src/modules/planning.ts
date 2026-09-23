import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { recordEvent, type Actor } from "../lib/records";
import { can, ctxOf, parse, tenant } from "../http/context";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const Day = z.string().regex(DATE);
const PRIORITIES = ["low", "normal", "high", "critical"] as const;
const OPEN = ["open", "in_progress", "blocked"];
const ENTITY_TABLE: Record<string, string> = {
  product: "products", product_revision: "product_revisions", sales_order: "sales_orders", work_order: "work_orders",
  change_request: "change_requests", rma: "rmas", shipment: "shipments", purchase_request: "purchase_requests",
};

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

const taskCols = `t.id, t.title, t.description, t.status, t.kind, t.priority, t.milestone, t.start_date::text as "startDate", t.due_date::text as "dueDate",
  t.baseline_start::text as "baselineStart", t.baseline_due::text as "baselineDue", t.started_at as "startedAt", t.closed_at as "closedAt",
  t.assignee_role as "assigneeRole", t.assignee_user_id as "assigneeUserId", au.name as "assigneeName", t.department_id as "departmentId", dp.name as "departmentName",
  t.entity_type as "entityType", t.entity_id as "entityId", t.checklist, t.blocked_category as "blockedCategory", t.blocked_reason as "blockedReason",
  t.external_delay as "externalDelay", t.cancel_reason as "cancelReason", t.created_at as "createdAt", cu.name as "createdBy"`;
const taskFrom = `from tasks t left join users au on au.id = t.assignee_user_id left join departments dp on dp.id = t.department_id left join users cu on cu.id = t.created_by`;

async function loadTask(db: Db, id: string) {
  const r = await db.query(`select ${taskCols} ${taskFrom} where t.id = $1`, [id]);
  if (!r.rows[0]) throw notFound("Görev");
  const pred = await db.query(
    `select d.depends_on_id as id, d.lag_days as "lagDays", t.title, t.status, t.due_date::text as "dueDate" from task_dependencies d join tasks t on t.id = d.depends_on_id where d.task_id = $1`,
    [id],
  );
  const succ = await db.query(
    `select d.task_id as id, d.lag_days as "lagDays", t.title, t.status, t.start_date::text as "startDate" from task_dependencies d join tasks t on t.id = d.task_id where d.depends_on_id = $1`,
    [id],
  );
  return { ...r.rows[0], predecessors: pred.rows, successors: succ.rows };
}

/** Kullanıcı görevin sorumlusu mu (kişi veya — kişi atanmamışsa — rol üzerinden)? */
function isAssignee(req: FastifyRequest, t: { assignee_user_id: string | null; assignee_role: string | null }) {
  const c = ctxOf(req);
  if (t.assignee_user_id) return t.assignee_user_id === c.userId;
  return !!t.assignee_role && c.roles.includes(t.assignee_role);
}

/** Döngüsel bağımlılık: yeni kenar (task → dependsOn) eklendiğinde dependsOn zaten task'a bağlıysa döngü oluşur. */
async function createsCycle(db: Db, taskId: string, dependsOn: string) {
  const r = await db.query(
    `with recursive up(id) as (
       select depends_on_id from task_dependencies where task_id = $1
       union select d.depends_on_id from task_dependencies d join up on d.task_id = up.id
     ) select 1 from up where id = $2 limit 1`,
    [dependsOn, taskId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Tarih değişikliğinin etkisi (prompt §20): ardıl görevlerde bağımlılık çakışması ve bağlı siparişin müşteri
 * taahhüdüne etkisi hesaplanır. Hiçbir tarih veya taahhüt otomatik değiştirilmez.
 */
async function impactOf(db: Db, taskId: string) {
  const t = (await db.query(`select id, due_date::text as due, entity_type, entity_id from tasks where id = $1`, [taskId])).rows[0];
  const successors: { id: string; title: string; startDate: string | null; requiredStart: string; daysLate: number }[] = [];
  if (t.due) {
    const s = await db.query(
      `select t.id, t.title, t.start_date::text as start, d.lag_days from task_dependencies d join tasks t on t.id = d.task_id
        where d.depends_on_id = $1 and t.status in ('open', 'in_progress', 'blocked')`,
      [taskId],
    );
    for (const x of s.rows) {
      const required = addDays(t.due, 1 + Number(x.lag_days));
      if (x.start && x.start < required) successors.push({ id: x.id, title: x.title, startDate: x.start, requiredStart: required, daysLate: diffDays(required, x.start) });
    }
  }
  const commitments: { salesOrderId: string; code: string; promisedDate: string; taskDue: string; daysLate: number }[] = [];
  if (t.due) {
    let so: { id: string; code: string; promised: string | null } | undefined;
    if (t.entity_type === "sales_order") so = (await db.query(`select id, code, promised_date::text as promised from sales_orders where id = $1`, [t.entity_id])).rows[0];
    if (t.entity_type === "work_order") {
      so = (await db.query(
        `select so.id, so.code, so.promised_date::text as promised from work_orders w join production_needs pn on pn.id = w.production_need_id
           join sales_order_lines l on l.id = pn.sales_order_line_id join sales_orders so on so.id = l.order_id where w.id = $1`,
        [t.entity_id],
      )).rows[0];
    }
    if (so?.promised && t.due > so.promised) commitments.push({ salesOrderId: so.id, code: so.code, promisedDate: so.promised, taskDue: t.due, daysLate: diffDays(t.due, so.promised) });
  }
  return { successors, commitments, note: commitments.length ? "Müşteri taahhüdü değiştirilmedi; satış ekibinin kararı gerekir." : null };
}

async function assertEntity(db: Db, type: string, id: string) {
  const table = ENTITY_TABLE[type];
  if (!table) throw badRequest(`Bilinmeyen bağlantı türü: ${type}`);
  const r = await db.query(`select 1 from ${table} where id = $1`, [id]);
  if (!r.rowCount) throw notFound("Bağlı kayıt");
}

async function assertMember(db: Db, userId: string) {
  const r = await db.query(`select 1 from memberships where user_id = $1 and status = 'active'`, [userId]);
  if (!r.rowCount) throw conflict("not_member", "Sorumlu kişi bu şirkette aktif üye değil");
}

const TaskInput = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(4000).optional(),
  assigneeUserId: z.string().uuid().optional(),
  assigneeRole: z.string().max(40).optional(),
  departmentId: z.string().uuid().optional(),
  priority: z.enum(PRIORITIES).default("normal"),
  startDate: Day.optional(),
  dueDate: Day.optional(),
  milestone: z.boolean().default(false),
  checklist: z.array(z.string().min(1).max(200)).max(50).default([]),
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  dependsOn: z.array(z.object({ taskId: z.string().uuid(), lagDays: z.number().int().min(-365).max(365).default(0) })).max(20).default([]),
});

export async function planningRoutes(app: FastifyInstance) {
  // ---- Görevler -----------------------------------------------------------------------
  app.get("/api/tasks", async (req) => {
    const q = z.object({
      status: z.string().optional(), assignee: z.string().optional(), departmentId: z.string().uuid().optional(),
      entityType: z.string().optional(), entityId: z.string().uuid().optional(), kind: z.string().optional(),
    }).parse(req.query);
    const c = ctxOf(req);
    return tenant(req, "task.view", async (db) => {
      const r = await db.query(
        `select ${taskCols}, (t.due_date is not null and t.due_date < current_date and t.status in ('open', 'in_progress', 'blocked')) as overdue
           ${taskFrom}
          where ($1::text is null or (case when $1 = 'active' then t.status in ('open', 'in_progress', 'blocked') else t.status = $1 end))
            and ($2::text is null or (case when $2 = 'me' then (t.assignee_user_id = $7 or (t.assignee_user_id is null and t.assignee_role = any($8))) else t.assignee_user_id::text = $2 end))
            and ($3::uuid is null or t.department_id = $3) and ($4::text is null or t.entity_type = $4) and ($5::uuid is null or t.entity_id = $5)
            and ($6::text is null or t.kind = $6)
          order by t.due_date nulls last, array_position(array['critical', 'high', 'normal', 'low'], t.priority), t.created_at desc limit 500`,
        [q.status ?? null, q.assignee ?? null, q.departmentId ?? null, q.entityType ?? null, q.entityId ?? null, q.kind ?? null, c.userId, c.roles],
      );
      return r.rows;
    });
  });

  app.get("/api/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "task.view", async (db) => ({ ...(await loadTask(db, id)), impact: await impactOf(db, id) }));
  });

  app.post("/api/tasks", async (req) => {
    const input = parse(TaskInput, req.body);
    return tenant(req, "task.manage", async (db, actor) => {
      if (!input.assigneeUserId && !input.assigneeRole) throw badRequest("Sorumlu kişi veya rol seçilmeli");
      if (input.assigneeUserId) await assertMember(db, input.assigneeUserId);
      if (input.startDate && input.dueDate && input.startDate > input.dueDate) throw conflict("invalid_dates", "Başlangıç bitişten sonra olamaz");
      if (input.milestone && input.startDate && input.dueDate && input.startDate !== input.dueDate) throw conflict("invalid_dates", "Kilometre taşı tek günlüktür");
      const id: string = randomUUID();
      let entityType = "task";
      let entityId: string = id;
      if (input.entityType || input.entityId) {
        if (!input.entityType || !input.entityId) throw badRequest("Bağlantı türü ve kaydı birlikte verilmeli");
        await assertEntity(db, input.entityType, input.entityId);
        entityType = input.entityType;
        entityId = input.entityId;
      }
      await db.query(
        `insert into tasks (id, company_id, title, description, assignee_role, assignee_user_id, department_id, priority, start_date, due_date, milestone,
                            checklist, entity_type, entity_id, kind, created_by)
         values ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'manual', $14)`,
        [id, input.title, input.description ?? null, input.assigneeRole ?? null, input.assigneeUserId ?? null, input.departmentId ?? null, input.priority,
          input.milestone ? input.dueDate ?? input.startDate ?? null : input.startDate ?? null, input.dueDate ?? input.startDate ?? null, input.milestone,
          JSON.stringify(input.checklist.map((text) => ({ text, done: false }))), entityType, entityId, actor.userId],
      );
      for (const d of input.dependsOn) {
        const p = await db.query(`select 1 from tasks where id = $1`, [d.taskId]);
        if (!p.rowCount) throw notFound("Öncül görev");
        await db.query(`insert into task_dependencies (company_id, task_id, depends_on_id, lag_days) values (app_company_id(), $1, $2, $3)`, [id, d.taskId, d.lagDays]);
      }
      await recordEvent(db, actor, { entityType: "task", entityId: id, eventType: "created", after: { ...input, entityType, entityId } });
      return { ...(await loadTask(db, id)), impact: await impactOf(db, id) };
    });
  });

  /** Plan alanları (başlık, sorumlu, öncelik, tarihler). Tarih değişikliği yetkiye tabi; etkisi döner, başka kayıt değişmez. */
  app.post("/api/tasks/:id/update", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        title: z.string().min(3).max(200).optional(), description: z.string().max(4000).nullable().optional(),
        assigneeUserId: z.string().uuid().nullable().optional(), assigneeRole: z.string().max(40).nullable().optional(), departmentId: z.string().uuid().nullable().optional(),
        priority: z.enum(PRIORITIES).optional(), startDate: Day.nullable().optional(), dueDate: Day.nullable().optional(), reason: z.string().max(500).optional(),
      }),
      req.body,
    );
    return tenant(req, "task.manage", async (db, actor) => {
      const t = (await db.query(`select * from tasks where id = $1 for update`, [id])).rows[0];
      if (!t) throw notFound("Görev");
      if (!OPEN.includes(t.status)) throw conflict("invalid_transition", "Kapanmış görev değiştirilemez");
      const start = input.startDate === undefined ? (t.start_date as string | null) : input.startDate;
      const due = input.dueDate === undefined ? (t.due_date as string | null) : input.dueDate;
      const s = start ? String(start).slice(0, 10) : null;
      const d = due ? String(due).slice(0, 10) : null;
      if (s && d && s > d) throw conflict("invalid_dates", "Başlangıç bitişten sonra olamaz");
      if (t.milestone && s && d && s !== d) throw conflict("invalid_dates", "Kilometre taşı tek günlüktür");
      const datesChanged = input.startDate !== undefined || input.dueDate !== undefined;
      if (datesChanged && t.baseline_due && !input.reason) throw conflict("reason_required", "Baz planı olan görevin tarihi gerekçesiz değiştirilemez");
      if (input.assigneeUserId) await assertMember(db, input.assigneeUserId);
      const nextUser = input.assigneeUserId === undefined ? t.assignee_user_id : input.assigneeUserId;
      const nextRole = input.assigneeRole === undefined ? t.assignee_role : input.assigneeRole;
      if (!nextUser && !nextRole) throw badRequest("Sorumlu kişi veya rol kalmalı");
      await db.query(
        `update tasks set title = $2, description = $3, assignee_user_id = $4, assignee_role = $5, department_id = $6, priority = $7, start_date = $8, due_date = $9 where id = $1`,
        [id, input.title ?? t.title, input.description === undefined ? t.description : input.description, nextUser, nextRole,
          input.departmentId === undefined ? t.department_id : input.departmentId, input.priority ?? t.priority, s, d],
      );
      await recordEvent(db, actor, {
        entityType: "task", entityId: id, eventType: datesChanged ? "rescheduled" : "updated",
        before: { startDate: t.start_date, dueDate: t.due_date, assigneeUserId: t.assignee_user_id, priority: t.priority }, after: input, reason: input.reason,
      });
      return { ...(await loadTask(db, id)), impact: await impactOf(db, id) };
    });
  });

  /**
   * Durum: sorumlu kişi veya görev yöneticisi değiştirir. Kapanış için kontrol listesi ve öncüllerin tamamı gerekir.
   * Engel kategorisi tedarikçi/müşteri ise gecikme dış kaynaklı sayılır ve kişisel performansa yazılmaz.
   */
  app.post("/api/tasks/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        status: z.enum(["open", "in_progress", "blocked", "done"]),
        blockedCategory: z.enum(["supplier", "customer", "material", "equipment", "quality", "other"]).optional(),
        reason: z.string().max(1000).optional(),
      }),
      req.body,
    );
    return tenant(req, "task.view", async (db, actor) => {
      const t = (await db.query(`select * from tasks where id = $1 for update`, [id])).rows[0];
      if (!t) throw notFound("Görev");
      if (!can(req, "task.manage") && !isAssignee(req, t)) throw forbidden("task.manage");
      if (t.kind !== "manual") throw conflict("system_task", "Sistem görevi ilgili işlem tamamlanınca kendiliğinden kapanır");
      if (!OPEN.includes(t.status)) throw conflict("invalid_transition", `Görev "${t.status}" durumunda`);
      if (input.status === "blocked") {
        if (!input.blockedCategory || !input.reason || input.reason.length < 3) throw conflict("reason_required", "Engel kategorisi ve açıklaması zorunlu");
      }
      if (input.status === "done") {
        const left = (t.checklist as { done: boolean }[]).filter((c) => !c.done).length;
        if (left) throw conflict("checklist_incomplete", `Kontrol listesinde ${left} madde tamamlanmadı`);
        const open = await db.query(
          `select t.title from task_dependencies d join tasks t on t.id = d.depends_on_id where d.task_id = $1 and t.status <> 'done'`,
          [id],
        );
        if (open.rowCount) throw conflict("dependency_open", `Öncül görev tamamlanmadı: ${open.rows.map((r) => r.title).join(", ")}`);
      }
      const external = input.status === "blocked" ? ["supplier", "customer"].includes(input.blockedCategory!) : t.external_delay;
      await db.query(
        `update tasks set status = $2,
                started_at = case when $2 in ('in_progress', 'done') then coalesce(started_at, now()) else started_at end,
                closed_at = case when $2 = 'done' then now() else null end, closed_by = case when $2 = 'done' then $3::uuid else null end,
                blocked_category = case when $2 = 'blocked' then $4 else blocked_category end,
                blocked_reason = case when $2 = 'blocked' then $5 else blocked_reason end,
                external_delay = $6
          where id = $1`,
        [id, input.status, actor.userId, input.blockedCategory ?? null, input.reason ?? null, external],
      );
      await recordEvent(db, actor, { entityType: "task", entityId: id, eventType: `status.${input.status}`, before: { status: t.status }, after: { status: input.status, blockedCategory: input.blockedCategory }, reason: input.reason });
      return loadTask(db, id);
    });
  });

  app.post("/api/tasks/:id/checklist", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ index: z.number().int().min(0), done: z.boolean() }), req.body);
    return tenant(req, "task.view", async (db, actor) => {
      const t = (await db.query(`select * from tasks where id = $1 for update`, [id])).rows[0];
      if (!t) throw notFound("Görev");
      if (!can(req, "task.manage") && !isAssignee(req, t)) throw forbidden("task.manage");
      if (!OPEN.includes(t.status)) throw conflict("invalid_transition", "Kapanmış görevin listesi değiştirilemez");
      const list = t.checklist as { text: string; done: boolean }[];
      if (!list[input.index]) throw notFound("Kontrol maddesi");
      list[input.index]!.done = input.done;
      await db.query(`update tasks set checklist = $2 where id = $1`, [id, JSON.stringify(list)]);
      await recordEvent(db, actor, { entityType: "task", entityId: id, eventType: "checklist.updated", after: { item: list[input.index]!.text, done: input.done } });
      return loadTask(db, id);
    });
  });

  app.post("/api/tasks/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "task.manage", async (db, actor) => {
      const t = (await db.query(`select status, kind from tasks where id = $1 for update`, [id])).rows[0];
      if (!t) throw notFound("Görev");
      if (t.kind !== "manual") throw conflict("system_task", "Sistem görevi iptal edilemez; ilgili süreçte karar verilir");
      if (!OPEN.includes(t.status)) throw conflict("invalid_transition", `Görev "${t.status}" durumunda`);
      await db.query(`update tasks set status = 'cancelled', cancel_reason = $2, closed_at = now(), closed_by = $3 where id = $1`, [id, input.reason, actor.userId]);
      await recordEvent(db, actor, { entityType: "task", entityId: id, eventType: "status.cancelled", before: { status: t.status }, reason: input.reason });
      return loadTask(db, id);
    });
  });

  app.post("/api/tasks/:id/dependencies", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ dependsOn: z.string().uuid(), lagDays: z.number().int().min(-365).max(365).default(0), remove: z.boolean().default(false) }), req.body);
    return tenant(req, "task.manage", async (db, actor) => {
      if (id === input.dependsOn) throw conflict("dependency_cycle", "Görev kendisine bağlanamaz");
      await db.query(`select pg_advisory_xact_lock(hashtext('task_deps:' || app_company_id()::text))`);
      const both = await db.query(`select id from tasks where id = any($1)`, [[id, input.dependsOn]]);
      if (both.rowCount !== 2) throw notFound("Görev");
      if (input.remove) {
        await db.query(`delete from task_dependencies where task_id = $1 and depends_on_id = $2`, [id, input.dependsOn]);
      } else {
        if (id === input.dependsOn || (await createsCycle(db, id, input.dependsOn))) throw conflict("dependency_cycle", "Döngüsel bağımlılık oluşturulamaz");
        await db.query(
          `insert into task_dependencies (company_id, task_id, depends_on_id, lag_days) values (app_company_id(), $1, $2, $3)
           on conflict (task_id, depends_on_id) do update set lag_days = excluded.lag_days`,
          [id, input.dependsOn, input.lagDays],
        );
      }
      await recordEvent(db, actor, { entityType: "task", entityId: id, eventType: input.remove ? "dependency.removed" : "dependency.added", after: input });
      return { ...(await loadTask(db, id)), impact: await impactOf(db, id) };
    });
  });

  /** Baz plan: seçili (veya tarihli bütün açık) görevlerin güncel tarihleri baz olarak dondurulur. */
  app.post("/api/tasks/baseline", async (req) => {
    const input = parse(z.object({ taskIds: z.array(z.string().uuid()).max(500).optional(), note: z.string().min(3).max(500) }), req.body);
    return tenant(req, "task.manage", async (db, actor) => {
      const r = await db.query(
        `update tasks set baseline_start = start_date, baseline_due = due_date
          where kind = 'manual' and status in ('open', 'in_progress', 'blocked') and due_date is not null and ($1::uuid[] is null or id = any($1)) returning id`,
        [input.taskIds ?? null],
      );
      for (const x of r.rows) await recordEvent(db, actor, { entityType: "task", entityId: x.id, eventType: "baseline.set", reason: input.note });
      return { count: r.rowCount };
    });
  });

  // ---- Gantt ------------------------------------------------------------------------
  /** Aynı görev/iş emri verisinden: bağımlılık, kilometre taşı, tatil, baz plan ve gerçekleşen. */
  app.get("/api/gantt", async (req) => {
    const q = z.object({ from: Day, to: Day, departmentId: z.string().uuid().optional() }).parse(req.query);
    return tenant(req, "task.view", async (db) => {
      const tasks = await db.query(
        `select ${taskCols} ${taskFrom}
          where t.kind = 'manual' and t.status <> 'cancelled' and t.due_date is not null
            and coalesce(t.start_date, t.due_date) <= $2 and t.due_date >= $1 and ($3::uuid is null or t.department_id = $3)
          order by coalesce(t.start_date, t.due_date), t.due_date`,
        [q.from, q.to, q.departmentId ?? null],
      );
      const ids = tasks.rows.map((t) => t.id);
      const deps = await db.query(`select task_id as "taskId", depends_on_id as "dependsOn", lag_days as "lagDays" from task_dependencies where task_id = any($1) or depends_on_id = any($1)`, [ids]);
      const wos = await db.query(
        `select w.id, w.code, w.status, coalesce(w.released_at, w.created_at)::date::text as "startDate",
                coalesce(w.completed_at::date, w.due_date, (coalesce(w.released_at, w.created_at) + interval '7 days')::date)::text as "dueDate",
                w.due_date::text as "plannedDue", w.completed_at as "completedAt", p.code as "productCode", so.promised_date::text as "promisedDate", so.code as "salesOrderCode"
           from work_orders w join product_revisions pr on pr.id = w.product_revision_id join products p on p.id = pr.product_id
           left join production_needs pn on pn.id = w.production_need_id left join sales_order_lines l on l.id = pn.sales_order_line_id left join sales_orders so on so.id = l.order_id
          where w.status <> 'cancelled' and coalesce(w.released_at, w.created_at)::date <= $2 and coalesce(w.completed_at::date, w.due_date, current_date) >= $1
          order by 4`,
        [q.from, q.to],
      );
      const holidays = (await db.query(`select day::text as day, name from holidays where day between $1 and $2 order by day`, [q.from, q.to])).rows;
      const byId = new Map(tasks.rows.map((t) => [t.id as string, t]));
      const conflicts = [];
      for (const d of deps.rows) {
        const a = byId.get(d.dependsOn);
        const b = byId.get(d.taskId);
        if (a?.dueDate && b?.startDate) {
          const required = addDays(a.dueDate, 1 + Number(d.lagDays));
          if (b.startDate < required) conflicts.push({ taskId: d.taskId, dependsOn: d.dependsOn, requiredStart: required, daysLate: diffDays(required, b.startDate) });
        }
      }
      const today = new Date().toISOString().slice(0, 10);
      return {
        from: q.from, to: q.to, today,
        tasks: tasks.rows.map((t) => ({
          ...t, overdue: t.status !== "done" && t.dueDate < today,
          slipDays: t.baselineDue ? diffDays(t.dueDate, t.baselineDue) : null,
          actualEnd: t.closedAt ? new Date(t.closedAt).toISOString().slice(0, 10) : null,
        })),
        dependencies: deps.rows, workOrders: wos.rows, holidays, conflicts,
      };
    });
  });

  // ---- Organizasyon -------------------------------------------------------------------
  /** Şema: departman ağacı, yöneticiler ve (tarihe göre) üyeler. Bu şema veri erişim yetkisi vermez. */
  app.get("/api/org", async (req) => {
    const q = z.object({ date: Day.optional() }).parse(req.query);
    const on = q.date ?? new Date().toISOString().slice(0, 10);
    return tenant(req, "task.view", async (db) => {
      const deps = await db.query(`select id, code, name, parent_id as "parentId", active from departments order by code`);
      const mem = await db.query(
        `select dm.id, dm.department_id as "departmentId", dm.user_id as "userId", u.name, u.email, dm.is_manager as "isManager", dm.temporary,
                dm.valid_from::text as "validFrom", dm.valid_to::text as "validTo", dm.note
           from department_members dm join users u on u.id = dm.user_id
          where dm.valid_from <= $1 and (dm.valid_to is null or dm.valid_to >= $1) order by dm.is_manager desc, u.name`,
        [on],
      );
      const users = await db.query(
        `select u.id, u.name, u.email, array_agg(distinct r.code) filter (where r.code is not null) as roles
           from memberships m join users u on u.id = m.user_id left join membership_roles mr on mr.membership_id = m.id left join roles r on r.id = mr.role_id
          where m.status = 'active' group by u.id, u.name, u.email order by u.name`,
      );
      return { date: on, departments: deps.rows.map((d) => ({ ...d, members: mem.rows.filter((m) => m.departmentId === d.id) })), users: users.rows,
        note: "Organizasyon şeması raporlama ilişkisini gösterir; veri erişim yetkisi rollerden gelir." };
    });
  });

  app.post("/api/departments", async (req) => {
    const input = parse(z.object({ code: z.string().min(2).max(20), name: z.string().min(2).max(120), parentId: z.string().uuid().optional() }), req.body);
    return tenant(req, "org.manage", async (db, actor) => {
      const r = await db.query(`insert into departments (company_id, code, name, parent_id) values (app_company_id(), $1, $2, $3) returning id`, [input.code, input.name, input.parentId ?? null]);
      await recordEvent(db, actor, { entityType: "department", entityId: r.rows[0].id, eventType: "created", after: input });
      return { id: r.rows[0].id, ...input };
    });
  });

  app.post("/api/departments/:id/update", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ name: z.string().min(2).max(120).optional(), parentId: z.string().uuid().nullable().optional(), active: z.boolean().optional() }), req.body);
    return tenant(req, "org.manage", async (db, actor) => {
      const d = (await db.query(`select * from departments where id = $1 for update`, [id])).rows[0];
      if (!d) throw notFound("Departman");
      if (input.parentId) {
        const cyc = await db.query(
          `with recursive up(id) as (select parent_id from departments where id = $1 union select p.parent_id from departments p join up on p.id = up.id where p.parent_id is not null)
           select 1 from up where id = $2`,
          [input.parentId, id],
        );
        if (input.parentId === id || cyc.rowCount) throw conflict("org_cycle", "Departman kendi altına bağlanamaz");
      }
      await db.query(`update departments set name = $2, parent_id = $3, active = $4 where id = $1`, [
        id, input.name ?? d.name, input.parentId === undefined ? d.parent_id : input.parentId, input.active ?? d.active,
      ]);
      await recordEvent(db, actor, { entityType: "department", entityId: id, eventType: "updated", before: { name: d.name, parentId: d.parent_id, active: d.active }, after: input });
      return { id, ...input };
    });
  });

  /** Üyelik: çoklu departman, geçici görevlendirme ve tarihçe. Bitirilen üyelik silinmez. */
  app.post("/api/departments/:id/members", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({ userId: z.string().uuid(), isManager: z.boolean().default(false), temporary: z.boolean().default(false), validFrom: Day.optional(), validTo: Day.optional(), note: z.string().max(300).optional() }),
      req.body,
    );
    return tenant(req, "org.manage", async (db, actor) => {
      const d = await db.query(`select 1 from departments where id = $1 and active`, [id]);
      if (!d.rowCount) throw notFound("Departman");
      await assertMember(db, input.userId);
      if (input.temporary && !input.validTo) throw conflict("valid_to_required", "Geçici görevlendirmenin bitiş tarihi olmalı");
      const from = input.validFrom ?? new Date().toISOString().slice(0, 10);
      const dup = await db.query(
        `select 1 from department_members where department_id = $1 and user_id = $2 and (valid_to is null or valid_to >= $3) and ($4::date is null or valid_from <= $4)`,
        [id, input.userId, from, input.validTo ?? null],
      );
      if (dup.rowCount) throw conflict("duplicate", "Kişi bu tarihlerde zaten bu departmanda");
      const r = await db.query(
        `insert into department_members (company_id, department_id, user_id, is_manager, temporary, valid_from, valid_to, note, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [id, input.userId, input.isManager, input.temporary, from, input.validTo ?? null, input.note ?? null, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "department", entityId: id, eventType: "member.added", after: input });
      return { id: r.rows[0].id };
    });
  });

  app.post("/api/department-members/:id/end", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ validTo: Day, reason: z.string().min(3).max(300) }), req.body);
    return tenant(req, "org.manage", async (db, actor) => {
      const m = (await db.query(`select * from department_members where id = $1 for update`, [id])).rows[0];
      if (!m) throw notFound("Üyelik");
      if (input.validTo < String(m.valid_from).slice(0, 10)) throw conflict("invalid_dates", "Bitiş başlangıçtan önce olamaz");
      await db.query(`update department_members set valid_to = $2 where id = $1`, [id, input.validTo]);
      await recordEvent(db, actor, { entityType: "department", entityId: m.department_id, eventType: "member.ended", after: { userId: m.user_id, validTo: input.validTo }, reason: input.reason });
      return { id, validTo: input.validTo };
    });
  });

  // ---- Ekip performansı ---------------------------------------------------------------
  /**
   * Haftalık/aylık/özel dönem (prompt §18 son paragraf). Mesaj sayısı veya çevrim içi süre ölçülmez; tek bir "puan" yoktur.
   * Tedarikçi/müşteri kaynaklı gecikme kişinin zamanında tamamlama oranından çıkarılır ve ayrıca gösterilir.
   */
  app.get("/api/reports/team", async (req) => {
    const q = z.object({ from: Day, to: Day, period: z.enum(["week", "month"]).default("week"), departmentId: z.string().uuid().optional() }).parse(req.query);
    return tenant(req, "team.report.view", async (db) => {
      const users = await db.query(
        `select u.id, u.name,
                (select string_agg(d.name, ', ') from department_members dm join departments d on d.id = dm.department_id
                  where dm.user_id = u.id and dm.valid_from <= $2 and (dm.valid_to is null or dm.valid_to >= $1)) as departments
           from memberships m join users u on u.id = m.user_id
          where m.status = 'active' and ($3::uuid is null or exists (select 1 from department_members dm where dm.user_id = u.id and dm.department_id = $3
                                                                     and dm.valid_from <= $2 and (dm.valid_to is null or dm.valid_to >= $1)))
          order by u.name`,
        [q.from, q.to, q.departmentId ?? null],
      );
      const rows = [];
      for (const u of users.rows) {
        const t = (await db.query(
          `select count(*) filter (where status = 'done' and closed_at::date between $2 and $3)::int as closed,
                  count(*) filter (where status = 'done' and closed_at::date between $2 and $3 and due_date is not null and closed_at::date <= due_date)::int as on_time,
                  count(*) filter (where status = 'done' and closed_at::date between $2 and $3 and due_date is not null and closed_at::date > due_date and not external_delay)::int as late_internal,
                  count(*) filter (where status = 'done' and closed_at::date between $2 and $3 and due_date is not null and closed_at::date > due_date and external_delay)::int as late_external,
                  count(*) filter (where status in ('open', 'in_progress', 'blocked') and due_date < least($3::date + 1, current_date))::int as overdue_open,
                  count(*) filter (where status = 'blocked' and external_delay)::int as blocked_external
             from tasks where kind = 'manual' and assignee_user_id = $1`,
          [u.id, q.from, q.to],
        )).rows[0];
        const ops = (await db.query(
          `select count(*)::int as n from events where actor_user_id = $1 and event_type = 'operation.complete' and created_at >= $2::date and created_at < ($3::date + 1)`,
          [u.id, q.from, q.to],
        )).rows[0].n;
        const tests = (await db.query(`select count(*)::int as n from test_runs where operator_id = $1 and created_at >= $2::date and created_at < ($3::date + 1)`, [u.id, q.from, q.to])).rows[0].n;
        const denominator = t.on_time + t.late_internal;
        rows.push({
          userId: u.id, name: u.name, departments: u.departments, tasksClosed: t.closed, onTime: t.on_time, lateInternal: t.late_internal, lateExternal: t.late_external,
          onTimeRate: denominator ? Number((t.on_time / denominator).toFixed(4)) : null, overdueOpen: t.overdue_open, blockedExternal: t.blocked_external,
          operationsCompleted: ops, testsRecorded: tests,
        });
      }
      // Dönem kovaları (şirket geneli): kapanan, zamanında, dış kaynaklı gecikme.
      const unit = q.period === "week" ? "week" : "month";
      const buckets = (await db.query(
        `select date_trunc($3, closed_at)::date::text as period,
                count(*)::int as closed,
                count(*) filter (where due_date is not null and closed_at::date <= due_date)::int as on_time,
                count(*) filter (where due_date is not null and closed_at::date > due_date and not external_delay)::int as late_internal,
                count(*) filter (where due_date is not null and closed_at::date > due_date and external_delay)::int as late_external
           from tasks where kind = 'manual' and status = 'done' and closed_at::date between $1 and $2
          group by 1 order by 1`,
        [q.from, q.to, unit],
      )).rows;
      return {
        from: q.from, to: q.to, period: q.period, rows, buckets,
        definitions: {
          onTimeRate: "Dönemde kapanan, bitiş tarihli görevlerden bitiş tarihinde veya önce kapananlar / (zamanında + iç kaynaklı geciken). Tedarikçi/müşteri kaynaklı gecikme paydadan çıkarılır.",
          operationsCompleted: "Kişinin tamamladığı üretim operasyonu sayısı (olay defterinden). İş karmaşıklığı ve parti büyüklüğü farklı olduğu için kişiler arası sıralama için kullanılmaz.",
          testsRecorded: "Kişinin kaydettiği test çalışması sayısı. Test sonucu (geçti/kaldı) kişinin performansı sayılmaz.",
        },
        notes: [
          "Mesaj sayısı, çevrim içi süre ve tıklama gibi etkinlik ölçüleri kullanılmaz; toplu bir verimlilik puanı üretilmez.",
          "Engel kategorisi tedarikçi veya müşteri olan görevlerin gecikmesi kişiye yazılmaz, ayrı sütunda gösterilir.",
          "Prototip/pilot/seri ayrımı ve ürün karmaşıklığı henüz modellenmedi; üretim sayıları karşılaştırma amacıyla kullanılmamalı.",
        ],
      };
    });
  });
}
