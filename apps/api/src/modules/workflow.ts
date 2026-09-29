import type { FastifyInstance } from "fastify";
import { RD_COST_CATEGORIES } from "../lib/rd-cost";
import { DELEGABLE_PERMISSIONS, TASK_KIND_PERMISSION } from "@apisfactory/shared";
import { z } from "zod";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { closeTasks, idempotent, nextCode, openTask, recordEvent } from "../lib/records";
import { can, ctxOf, idempotencyKey, parse, tenant } from "../http/context";
import { approverFromRequest, assertApproval, currentPolicy, estimatePurchase, evaluateApproval, runEscalations, withApproval, type PolicyKind } from "../lib/workflow";
import { fromMicro, max, toMicro } from "../lib/decimal";
import { freeQty } from "./sales";

const KINDS = ["purchase_request", "change_request", "rma_decision", "incoming_inspection", "device_disposition"] as const;
const ROLE_CODES = ["admin", "manager", "rd", "production", "technician", "quality", "warehouse", "sales", "purchasing", "accounting"];
const MAX_DELEGATION_DAYS = 90;

export async function workflowRoutes(app: FastifyInstance) {
  // ---- Onay politikaları -----------------------------------------------------------------
  app.get("/api/workflow/policies", async (req) =>
    tenant(req, "task.view", async (db) => {
      const current = [];
      for (const k of KINDS) current.push({ kind: k, policy: await currentPolicy(db, k) });
      const history = (await db.query(
        `select p.kind, p.version_no as "versionNo", p.allow_self_approval as "allowSelfApproval", p.timeout_hours as "timeoutHours",
                p.escalate_to_role as "escalateToRole", p.escalate_to_role_2 as "escalateToRole2", p.note, p.created_at as "createdAt", u.name as "createdBy"
           from approval_policies p left join users u on u.id = p.created_by order by p.kind, p.version_no desc`,
      )).rows;
      return { current, history, defaults: "Politika yoksa: kendi talebini onaylama kapalı, parasal limit ve süre yok." };
    }),
  );

  /** Yeni politika sürümü. Açık işler yeni sürümle değerlendirilir; geçmiş kararlar kendi sürüm numarasını olayda taşır. */
  app.post("/api/workflow/policies", async (req) => {
    const input = parse(
      z.object({
        kind: z.enum(KINDS),
        allowSelfApproval: z.boolean().default(false),
        timeoutHours: z.number().int().min(1).max(2160).nullable().default(null),
        escalateToRole: z.string().nullable().default(null),
        escalateToRole2: z.string().nullable().default(null),
        note: z.string().min(3).max(1000),
        limits: z.array(z.object({ roleCode: z.string(), maxAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable(), currency: z.string().regex(/^[A-Z]{3}$/) })).max(20).default([]),
      }),
      req.body,
    );
    return tenant(req, "workflow.manage", async (db, actor) => {
      if (input.escalateToRole && !ROLE_CODES.includes(input.escalateToRole)) throw badRequest("Bilinmeyen rol");
      if (input.timeoutHours && !input.escalateToRole) throw conflict("escalation_role_required", "Süre tanımlandıysa yükseltilecek rol seçilmeli");
      if (input.escalateToRole === "admin") throw conflict("admin_not_allowed", "Teknik sistem yöneticisi iş onayı almaz");
      if (input.escalateToRole2 && !ROLE_CODES.includes(input.escalateToRole2)) throw badRequest("Bilinmeyen rol (2. seviye)");
      if (input.escalateToRole2 && !input.escalateToRole) throw conflict("escalation_role_required", "İkinci seviye için önce birinci yükseltme rolü tanımlanmalı");
      if (input.escalateToRole2 === "admin") throw conflict("admin_not_allowed", "Teknik sistem yöneticisi iş onayı almaz");
      if (input.escalateToRole2 && input.escalateToRole2 === input.escalateToRole) throw badRequest("İkinci seviye birinci seviyeyle aynı rol olamaz");
      for (const l of input.limits) {
        if (!ROLE_CODES.includes(l.roleCode)) throw badRequest(`Bilinmeyen rol: ${l.roleCode}`);
        if (l.roleCode === "admin") throw conflict("admin_not_allowed", "Teknik sistem yöneticisine onay limiti verilemez");
      }
      await db.query(`select pg_advisory_xact_lock(hashtext('policy:' || app_company_id()::text || $1))`, [input.kind]);
      const n = (await db.query(`select coalesce(max(version_no), 0) + 1 as n from approval_policies where kind = $1`, [input.kind])).rows[0].n;
      const p = await db.query(
        `insert into approval_policies (company_id, kind, version_no, allow_self_approval, timeout_hours, escalate_to_role, escalate_to_role_2, note, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [input.kind, n, input.allowSelfApproval, input.timeoutHours, input.escalateToRole, input.escalateToRole2, input.note, actor.userId],
      );
      for (const l of input.limits) {
        await db.query(`insert into approval_limits (company_id, policy_id, role_code, max_amount, currency) values (app_company_id(), $1, $2, $3, $4)`, [p.rows[0].id, l.roleCode, l.maxAmount, l.currency]);
      }
      await recordEvent(db, actor, { entityType: "approval_policy", entityId: p.rows[0].id, eventType: "created", after: { ...input, versionNo: n } });
      return currentPolicy(db, input.kind);
    });
  });

  /** Kuru çalıştırma: politikayı örnek onaycı/tutarla dener, hiçbir şey yazmaz. */
  app.post("/api/workflow/policies/dry-run", async (req) => {
    const input = parse(
      z.object({ kind: z.enum(KINDS), approverUserId: z.string().uuid(), requesterUserId: z.string().uuid().optional(), amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }),
      req.body,
    );
    return tenant(req, "workflow.manage", async (db) => {
      const roles = (await db.query(
        `select array_agg(r.code) as roles from memberships m join membership_roles mr on mr.membership_id = m.id join roles r on r.id = mr.role_id where m.user_id = $1 and m.status = 'active'`,
        [input.approverUserId],
      )).rows[0]?.roles ?? [];
      const d = await evaluateApproval(db, input.kind as PolicyKind, { userId: input.approverUserId, roles }, { requesterId: input.requesterUserId ?? null, amount: input.amount ?? null, currency: input.currency ?? null });
      return { ...d, approverRoles: roles, written: false };
    });
  });

  // ---- Vekâlet ------------------------------------------------------------------------
  app.get("/api/delegations", async (req) => {
    const c = ctxOf(req);
    return tenant(req, "task.view", async (db) => {
      const r = await db.query(
        `select d.id, d.permissions, d.valid_from as "validFrom", d.valid_to as "validTo", d.reason, d.created_at as "createdAt", d.revoked_at as "revokedAt",
                d.delegator_user_id as "delegatorUserId", a.name as "delegatorName", d.delegate_user_id as "delegateUserId", b.name as "delegateName", cu.name as "createdBy",
                (d.revoked_at is null and now() >= d.valid_from and now() < d.valid_to) as active
           from delegations d join users a on a.id = d.delegator_user_id join users b on b.id = d.delegate_user_id join users cu on cu.id = d.created_by
          where $1 or d.delegator_user_id = $2 or d.delegate_user_id = $2
          order by d.valid_to desc limit 200`,
        [can(req, "delegation.manage"), c.userId],
      );
      return { delegable: DELEGABLE_PERMISSIONS, mine: [...c.permissions].filter((p) => (DELEGABLE_PERMISSIONS as readonly string[]).includes(p) && !c.delegated[p]), rows: r.rows };
    });
  });

  /**
   * Vekâlet (prompt §5): süreli (en çok 90 gün) ve kapsamlı; yalnızca vekâlet verenin sahip olduğu onay izinleri.
   * Kişi kendi izinlerini devredebilir; başkası adına vekâlet için vekâlet yönetimi yetkisi gerekir ve yönetici kendini vekil atayamaz.
   */
  app.post("/api/delegations", async (req) => {
    const c = ctxOf(req);
    const input = parse(
      z.object({
        delegatorUserId: z.string().uuid().optional(), delegateUserId: z.string().uuid(), permissions: z.array(z.string()).min(1).max(20),
        validFrom: z.string().datetime({ offset: true }).optional(), validTo: z.string().datetime({ offset: true }), reason: z.string().min(3).max(500),
      }),
      req.body,
    );
    return tenant(req, null, async (db, actor) => {
      const delegator = input.delegatorUserId ?? c.userId;
      if (delegator !== c.userId) {
        if (!can(req, "delegation.manage")) throw forbidden("delegation.manage");
        if (input.delegateUserId === c.userId) throw conflict("self_grant", "Başkasının onay yetkisini kendinize vekâlet olarak veremezsiniz");
      }
      if (delegator === input.delegateUserId) throw conflict("invalid_delegate", "Kişi kendine vekâlet veremez");
      const bad = input.permissions.filter((p) => !(DELEGABLE_PERMISSIONS as readonly string[]).includes(p));
      if (bad.length) throw conflict("not_delegable", `Vekâletle devredilemez: ${bad.join(", ")}`);
      const has = (await db.query(
        `select array_agg(distinct rp.permission) as perms from memberships m join membership_roles mr on mr.membership_id = m.id
           join role_permissions rp on rp.role_id = mr.role_id where m.user_id = $1 and m.status = 'active'`,
        [delegator],
      )).rows[0]?.perms ?? [];
      const missing = input.permissions.filter((p) => !has.includes(p));
      if (missing.length) throw conflict("permission_not_held", `Vekâlet veren bu izinlere sahip değil: ${missing.join(", ")}`);
      const member = await db.query(`select 1 from memberships where user_id = $1 and status = 'active'`, [input.delegateUserId]);
      if (!member.rowCount) throw conflict("not_member", "Vekil bu şirkette aktif üye değil");
      const from = input.validFrom ? new Date(input.validFrom) : new Date();
      const to = new Date(input.validTo);
      if (to <= from) throw conflict("invalid_dates", "Bitiş başlangıçtan sonra olmalı");
      if ((to.getTime() - from.getTime()) / 86400000 > MAX_DELEGATION_DAYS) throw conflict("too_long", `Vekâlet en çok ${MAX_DELEGATION_DAYS} gün olabilir`);
      const r = await db.query(
        `insert into delegations (company_id, delegator_user_id, delegate_user_id, permissions, valid_from, valid_to, reason, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [delegator, input.delegateUserId, input.permissions, from, to, input.reason, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "delegation", entityId: r.rows[0].id, eventType: "created", after: { delegator, delegate: input.delegateUserId, permissions: input.permissions, validFrom: from, validTo: to }, reason: input.reason });
      return { id: r.rows[0].id };
    });
  });

  app.post("/api/delegations/:id/revoke", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    const c = ctxOf(req);
    return tenant(req, null, async (db, actor) => {
      const d = (await db.query(`select * from delegations where id = $1 for update`, [id])).rows[0];
      if (!d) throw notFound("Vekâlet");
      if (d.delegator_user_id !== c.userId && d.delegate_user_id !== c.userId && !can(req, "delegation.manage")) throw forbidden("delegation.manage");
      if (d.revoked_at) throw conflict("invalid_transition", "Vekâlet zaten iptal edildi");
      await db.query(`update delegations set revoked_at = now(), revoked_by = $2 where id = $1`, [id, actor.userId]);
      await recordEvent(db, actor, { entityType: "delegation", entityId: id, eventType: "revoked", reason: input.reason });
      return { id, revoked: true };
    });
  });

  /** Vekilin görev listesi: vekâlet verenin kişisel görevleri ve devredilen izne karşılık gelen rol görevleri. */
  app.get("/api/tasks/delegated", async (req) => {
    const c = ctxOf(req);
    return tenant(req, "task.view", async (db) => {
      const out = [];
      for (const d of c.delegators) {
        const kinds = Object.entries(TASK_KIND_PERMISSION).filter(([, p]) => d.permissions.includes(p)).map(([k]) => k);
        // Limit üstü onay görevleri de vekâlet verenin rolüne açılır (şimdilik yalnız satın alma talebi).
        if (d.permissions.includes("purchase.request.approve")) kinds.push("approval_escalation");
        const r = await db.query(
          `select t.id, t.title, t.kind, t.status, t.assignee_role as "assigneeRole", t.entity_type as "entityType", t.entity_id as "entityId",
                  t.due_at as "dueAt", (t.due_at is not null and t.due_at < now()) as overdue, $3::text as "onBehalfOfName"
             from tasks t
            where t.status in ('open', 'in_progress', 'blocked') and t.kind = any($2) and t.assignee_role = any($1)
            order by t.due_at nulls last, t.created_at limit 100`,
          [d.roles, kinds, (await db.query(`select name from users where id = $1`, [d.userId])).rows[0]?.name],
        );
        out.push(...r.rows);
      }
      return out;
    });
  });

  // ---- Süre aşımı, yükseltme, elle müdahale -----------------------------------------------
  app.post("/api/workflow/escalations/run", async (req) =>
    tenant(req, "workflow.manage", async (db, actor) => ({ escalated: await runEscalations(db, actor) })),
  );

  app.get("/api/workflow/overview", async (req) =>
    tenant(req, "workflow.manage", async (db) => {
      const overdue = await db.query(
        `select t.id, t.title, t.kind, t.assignee_role as "assigneeRole", t.due_at as "dueAt", t.escalated_at as "escalatedAt", t.escalation_level as "escalationLevel",
                t.entity_type as "entityType", t.entity_id as "entityId"
           from tasks t where t.kind <> 'manual' and t.status in ('open', 'in_progress', 'blocked') and t.due_at is not null and t.due_at < now()
          order by t.due_at limit 200`,
      );
      const escalations = await db.query(
        `select t.id, t.title, t.assignee_role as "assigneeRole", t.created_at as "createdAt", t.entity_id as "taskId"
           from tasks t where t.kind in ('escalation', 'approval_escalation') and t.status in ('open', 'in_progress', 'blocked') order by t.created_at desc limit 200`,
      );
      const outbox = await db.query(`select status, count(*)::int as n from outbox where company_id = app_company_id() group by status`);
      return { overdue: overdue.rows, escalations: escalations.rows, outbox: Object.fromEntries(outbox.rows.map((r) => [r.status, r.n])) };
    }),
  );

  /** Elle müdahale: sistem görevini başka role veya kişiye aktarma (gerekçeli, olay kayıtlı). */
  app.post("/api/tasks/:id/reassign", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ assigneeRole: z.string().optional(), assigneeUserId: z.string().uuid().optional(), reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "workflow.manage", async (db, actor) => {
      const t = (await db.query(`select * from tasks where id = $1 for update`, [id])).rows[0];
      if (!t) throw notFound("Görev");
      if (!["open", "in_progress", "blocked"].includes(t.status)) throw conflict("invalid_transition", "Kapanmış görev aktarılamaz");
      if (!input.assigneeRole && !input.assigneeUserId) throw badRequest("Yeni rol veya kişi seçilmeli");
      if (input.assigneeRole && (!ROLE_CODES.includes(input.assigneeRole) || input.assigneeRole === "admin")) throw badRequest("Geçersiz rol");
      if (input.assigneeUserId) {
        const m = await db.query(`select 1 from memberships where user_id = $1 and status = 'active'`, [input.assigneeUserId]);
        if (!m.rowCount) throw conflict("not_member", "Kişi aktif üye değil");
      }
      const perm = TASK_KIND_PERMISSION[t.kind];
      if (perm && input.assigneeRole) {
        const ok = await db.query(`select 1 from roles r join role_permissions rp on rp.role_id = r.id where r.code = $1 and rp.permission = $2`, [input.assigneeRole, perm]);
        if (!ok.rowCount) throw conflict("role_lacks_permission", `Bu rolün "${perm}" izni yok; görev yapılamaz`);
      }
      await db.query(`update tasks set assignee_role = coalesce($2, assignee_role), assignee_user_id = $3 where id = $1`, [id, input.assigneeRole ?? null, input.assigneeUserId ?? null]).catch((e) => {
        if (e.code === "23505") throw conflict("duplicate", "Bu rolde aynı iş için açık görev zaten var");
        throw e;
      });
      await recordEvent(db, actor, { entityType: "task", entityId: id, eventType: "reassigned", before: { role: t.assignee_role, userId: t.assignee_user_id }, after: input, reason: input.reason });
      return { id, ...input };
    });
  });

  // ---- Çıkış kutusu: izleme, tekrar deneme, uzlaştırma ----------------------------------
  app.get("/api/workflow/outbox", async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    return tenant(req, "workflow.manage", async (db) => {
      const r = await db.query(
        `select o.id, o.topic, o.payload, o.status, o.attempts, o.last_error as "lastError", o.available_at as "availableAt", o.created_at as "createdAt",
                o.resolution_note as "resolutionNote", u.name as "resolvedBy"
           from outbox o left join users u on u.id = o.resolved_by
          where o.company_id = app_company_id() and ($1::text is null or o.status = $1) order by o.id desc limit 200`,
        [q.status ?? null],
      );
      return r.rows.map((x) => ({ ...x, id: String(x.id) }));
    });
  });

  /** Başarısız iş yeniden kuyruğa alınır. Sonucu bilinmeyen (unknown) iş körlemesine tekrar denenmez; önce uzlaştırılır. */
  app.post("/api/workflow/outbox/:id/retry", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "workflow.manage", async (db, actor) => {
      const o = (await db.query(`select * from outbox where id = $1 and company_id = app_company_id() for update`, [id])).rows[0];
      if (!o) throw notFound("Kuyruk kaydı");
      if (o.status === "unknown") throw conflict("reconcile_first", "Sonucu bilinmeyen dış işlem tekrar gönderilmez; önce karşı sistemle uzlaştırın");
      if (o.status !== "failed") throw conflict("invalid_transition", `Kayıt "${o.status}" durumunda`);
      await db.query(`update outbox set status = 'pending', available_at = now(), last_error = null, resolved_by = $2, resolution_note = $3 where id = $1`, [id, actor.userId, input.reason]);
      await recordEvent(db, actor, { entityType: "outbox", entityId: actor.companyId, eventType: "retry", after: { id, topic: o.topic }, reason: input.reason });
      return { id, status: "pending" };
    });
  });

  app.post("/api/workflow/outbox/:id/resolve", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ outcome: z.enum(["done", "failed"]), note: z.string().min(3).max(500) }), req.body);
    return tenant(req, "workflow.manage", async (db, actor) => {
      const o = (await db.query(`select * from outbox where id = $1 and company_id = app_company_id() for update`, [id])).rows[0];
      if (!o) throw notFound("Kuyruk kaydı");
      if (!["unknown", "failed"].includes(o.status)) throw conflict("invalid_transition", `Kayıt "${o.status}" durumunda`);
      await db.query(`update outbox set status = $2, resolved_by = $3, resolution_note = $4 where id = $1`, [id, input.outcome, actor.userId, input.note]);
      await recordEvent(db, actor, { entityType: "outbox", entityId: actor.companyId, eventType: `resolved.${input.outcome}`, before: { status: o.status }, after: { id, topic: o.topic }, reason: input.note });
      return { id, status: input.outcome };
    });
  });

  /**
   * Elle satın alma talebi. R04 (Ar-Ge malzeme talebi) buraya `projectId` ile bağlanır:
   * "MPN veya tanımlı genel ihtiyaç": itemId zaten hem belirli MPN'li kalemleri hem de MPN'siz
   * genel/dahili kalemleri kapsıyor (POST /api/items ile MPN'siz oluşturulabilir) — ayrı bir alan
   * gerekmiyor. "Önce mevcut stoktan karşılama değerlendirilsin, kalan satın almaya aktarılsın":
   * yalnızca bir projeye bağlı taleplerde (`projectId` verildiğinde) talep miktarından serbest
   * (rezerve edilmemiş) stok düşülür ve yalnızca kalan satın almaya aktarılır — stok tamamını
   * karşılıyorsa hiçbir talep kaydı açılmaz (gerçekleşmeyen bir satın alma ihtiyacı uydurulmaz),
   * yalnızca kalemin geçmişine bilgi amaçlı bir olay yazılır. Proje bağlantısı olmayan (purchasing
   * vb. tarafından açılan) genel manuel taleplerde davranış öncekiyle birebir aynıdır — stok kontrolü
   * yalnızca "Ar-Ge malzeme talebi" akışının kendi kuralıdır, satın almanın genel talep sürecine
   * dayatılmaz.
   * projectId verilirse talep o projeye bağlanır ve maliyet merkezi açıkça verilmemişse projeninkinden
   * alınır — muhasebe giderin hangi projeye ait olduğunu görebilsin diye.
   */
  app.post("/api/purchase-requests", async (req) => {
    const input = parse(
      z.object({
        itemId: z.string().uuid(),
        qty: z.string().regex(/^\d+(\.\d+)?$/),
        needDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        note: z.string().min(3).max(1000),
        projectId: z.string().uuid().optional(),
        costCenter: z.string().min(1).max(120).optional(),
        rdCostCategory: z.enum(RD_COST_CATEGORIES).optional(),
      }).refine((v) => !v.rdCostCategory || v.projectId, { message: "Gider kategorisi yalnız projeye bağlı talepte verilir" }),
      req.body,
    );
    return tenant(req, "purchase.request.create", (db, actor) =>
      idempotent(db, actor.companyId, "pr_create", idempotencyKey(req), async () => {
        const item = await db.query(`select code from items where id = $1`, [input.itemId]);
        if (!item.rows[0]) throw notFound("Kalem");

        let costCenter = input.costCenter ?? null;
        if (input.projectId) {
          const proj = await db.query(`select code, cost_center, status from rd_projects where id = $1`, [input.projectId]);
          if (!proj.rows[0]) throw notFound("Ar-Ge projesi");
          if (proj.rows[0].status !== "open") throw conflict("project_closed", `Proje "${proj.rows[0].code}" kapalı`);
          costCenter = costCenter ?? proj.rows[0].cost_center;
        }

        // Yalnızca projeye bağlı (Ar-Ge malzeme) taleplerinde: önce mevcut serbest stoktan karşılama
        // değerlendirilir, yalnızca kalan satın almaya aktarılır. Proje bağlantısı yoksa eski davranış.
        let netQty = input.qty;
        let coveredFromStock = "0";
        if (input.projectId) {
          const requested = toMicro(input.qty);
          const free = max(0n, await freeQty(db, input.itemId));
          const covered = requested < free ? requested : free;
          const net = requested - covered;
          if (net <= 0n) {
            await recordEvent(db, actor, {
              entityType: "item", entityId: input.itemId,
              eventType: "material_request.covered_by_stock",
              after: { requestedQty: input.qty, note: input.note, projectId: input.projectId, costCenter },
            });
            return { id: null, code: null, covered: true, requestedQty: input.qty, coveredQty: input.qty, forwardedQty: "0", estimatedAmount: null, currency: null, amountSource: "stoktan tamamen karşılandı" };
          }
          netQty = fromMicro(net);
          coveredFromStock = fromMicro(covered);
        }

        const est = await estimatePurchase(db, input.itemId, netQty);
        const code = await nextCode(db, actor.companyId, "purchase_request", "SAT");
        const r = await db.query(
          `insert into purchase_requests (company_id, code, item_id, qty, need_date, source_type, requested_by, note, estimated_amount, currency, amount_source, project_id, cost_center, rd_cost_category)
           values (app_company_id(), $1, $2, $3, $4, 'manual', $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
          [code, input.itemId, netQty, input.needDate ?? null, actor.userId, input.note, est.amount, est.currency, est.source, input.projectId ?? null, costCenter, input.projectId ? (input.rdCostCategory ?? "prototype_material") : null],
        );
        const id = r.rows[0].id as string;
        await openTask(db, actor.companyId, { kind: "purchase_request_review", title: `Satın alma talebi ${code} — ${item.rows[0].code} × ${netQty}`, entityType: "purchase_request", entityId: id, assigneeRole: "purchasing" });
        await recordEvent(db, actor, {
          entityType: "purchase_request", entityId: id, eventType: "created",
          after: { code, itemId: input.itemId, qty: netQty, needDate: input.needDate, note: input.note, projectId: input.projectId ?? null, costCenter, estimate: est, requestedQty: input.qty, coveredFromStock },
        });
        return { id, code, covered: false, requestedQty: input.qty, coveredQty: coveredFromStock, forwardedQty: netQty, estimatedAmount: est.amount, currency: est.currency, amountSource: est.source };
      }),
    );
  });

  /**
   * Talep kararı. Onayda politika uygulanır: kendi talebini onaylama ve rol limiti; limit aşılırsa üst yetkili role görev açılır.
   * Onay tedarikçiye sipariş GÖNDERMEZ.
   */
  app.post("/api/purchase-requests/:id/decision", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(2000).optional() }), req.body);
    return withApproval(req, () =>
      tenant(req, "purchase.request.approve", async (db, actor) => {
        const r = await db.query(`select pr.*, i.code as item_code from purchase_requests pr join items i on i.id = pr.item_id where pr.id = $1 for update of pr`, [id]);
        const pr = r.rows[0];
        if (!pr) throw notFound("Satın alma talebi");
        if (pr.status !== "open") throw conflict("invalid_transition", `Talep "${pr.status}" durumunda`);
        if (input.decision === "reject" && !input.note) throw conflict("reason_required", "Ret gerekçesi zorunlu");
        let policyVersion: number | null = null;
        if (input.decision === "approve") {
          const d = await assertApproval(
            db, "purchase_request", approverFromRequest(req, "purchase.request.approve"),
            { requesterId: pr.requested_by, amount: pr.estimated_amount, currency: pr.currency },
            { title: `${pr.code} — ${pr.item_code} × ${Number(pr.qty)}`, entityType: "purchase_request", entityId: id },
          );
          policyVersion = d.policyVersion;
        }
        const to = input.decision === "approve" ? "approved" : "rejected";
        await db.query(`update purchase_requests set status = $2, decided_by = $3, decided_at = now() where id = $1`, [id, to, actor.userId]);
        await closeTasks(db, actor.companyId, "purchase_request_review", id);
        await closeTasks(db, actor.companyId, "approval_escalation", id);
        await recordEvent(db, actor, { entityType: "purchase_request", entityId: id, eventType: `status.${to}`, before: { status: "open" }, after: { status: to, policyVersion, onBehalfOf: actor.onBehalfOf ?? null }, reason: input.note });
        return { id, status: to, onBehalfOf: actor.onBehalfOf ?? null };
      }),
    );
  });
}
