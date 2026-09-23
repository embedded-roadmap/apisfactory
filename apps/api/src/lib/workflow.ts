import type { FastifyRequest } from "fastify";
import type { Db } from "../db/pool";
import { conflict } from "./errors";
import { openTask, recordEvent, enqueue, type Actor } from "./records";
import { ctxOf } from "../http/context";

export type PolicyKind = "purchase_request" | "change_request" | "rma_decision" | "incoming_inspection" | "device_disposition";

export async function currentPolicy(db: Db, kind: PolicyKind) {
  const p = (await db.query(
    `select id, kind, version_no as "versionNo", allow_self_approval as "allowSelfApproval", timeout_hours as "timeoutHours",
            escalate_to_role as "escalateToRole", note, created_at as "createdAt"
       from approval_policies where kind = $1 order by version_no desc limit 1`,
    [kind],
  )).rows[0] as
    | { id: string; kind: string; versionNo: number; allowSelfApproval: boolean; timeoutHours: number | null; escalateToRole: string | null; note: string; createdAt: string }
    | undefined;
  if (!p) return null;
  const limits = (await db.query(
    `select role_code as "roleCode", max_amount as "maxAmount", currency from approval_limits where policy_id = $1 order by role_code`,
    [p.id],
  )).rows as { roleCode: string; maxAmount: string | null; currency: string }[];
  return { ...p, limits };
}

type Approver = { userId: string; roles: string[]; onBehalfOf?: string };

export type ApprovalDecision = {
  allowed: boolean;
  code?: "self_approval" | "over_limit" | "amount_unknown" | "currency_mismatch";
  message?: string;
  policyVersion: number | null;
  approverLimit: string | null | "unlimited";
  escalateToRoles: string[];
};

/**
 * Onay kuralı (prompt §5): kendi talebini onaylama politikası ve rol bazlı parasal limit.
 * Vekâleten onayda hem vekilin hem vekâlet verenin talebi "kendi talebi" sayılır; limit vekâlet verenin rollerinden alınır.
 * Politika yoksa varsayılan: kendi talebini onaylama kapalı, parasal limit yok.
 */
export async function evaluateApproval(
  db: Db,
  kind: PolicyKind,
  approver: Approver,
  input: { requesterId: string | null; amount: string | null; currency: string | null },
): Promise<ApprovalDecision> {
  const p = await currentPolicy(db, kind);
  const base = { policyVersion: p?.versionNo ?? null, escalateToRoles: [] as string[] };
  const allowSelf = p?.allowSelfApproval ?? false;
  if (!allowSelf && input.requesterId && (input.requesterId === approver.userId || input.requesterId === approver.onBehalfOf)) {
    return { ...base, allowed: false, code: "self_approval", message: "Kendi talebinizi onaylayamazsınız (onay politikası)", approverLimit: null };
  }
  if (!p || p.limits.length === 0) return { ...base, allowed: true, approverLimit: "unlimited" };
  const mine = p.limits.filter((l) => approver.roles.includes(l.roleCode));
  const higher = (amount: number | null) =>
    p.limits.filter((l) => l.maxAmount === null || (amount !== null && Number(l.maxAmount) >= amount)).map((l) => l.roleCode).filter((r) => !approver.roles.includes(r));
  if (!mine.length) {
    return { ...base, allowed: false, code: "over_limit", message: "Rolünüz için bu türde onay limiti tanımlı değil", approverLimit: null, escalateToRoles: higher(input.amount === null ? null : Number(input.amount)) };
  }
  if (mine.some((l) => l.maxAmount === null)) return { ...base, allowed: true, approverLimit: "unlimited" };
  const best = mine.reduce((a, b) => (Number(a.maxAmount) >= Number(b.maxAmount) ? a : b));
  if (input.amount === null) {
    return { ...base, allowed: false, code: "amount_unknown", message: "Tutar bilinmiyor; limitli onaycı onaylayamaz (sınırsız yetkili rol onaylar)", approverLimit: best.maxAmount, escalateToRoles: p.limits.filter((l) => l.maxAmount === null).map((l) => l.roleCode) };
  }
  if (input.currency && input.currency !== best.currency) {
    return { ...base, allowed: false, code: "currency_mismatch", message: `Tutar ${input.currency}, limit ${best.currency}; kur dönüşümü yok`, approverLimit: best.maxAmount, escalateToRoles: p.limits.filter((l) => l.maxAmount === null).map((l) => l.roleCode) };
  }
  if (Number(input.amount) > Number(best.maxAmount)) {
    return { ...base, allowed: false, code: "over_limit", message: `Tutar ${input.amount} ${input.currency ?? ""}; onay limitiniz ${best.maxAmount} ${best.currency}`, approverLimit: best.maxAmount, escalateToRoles: higher(Number(input.amount)) };
  }
  return { ...base, allowed: true, approverLimit: best.maxAmount };
}

/** İstekteki kullanıcının onaycı kimliği: kendi rolleri veya — izin vekâletle geldiyse — vekâlet verenin rolleri. */
export function approverFromRequest(req: FastifyRequest, perm: string): Approver {
  const c = ctxOf(req);
  const delegator = c.delegated[perm];
  if (delegator) {
    const d = c.delegators.find((x) => x.userId === delegator)!;
    return { userId: c.userId, roles: d.roles, onBehalfOf: delegator };
  }
  return { userId: c.userId, roles: c.roles };
}

/**
 * Kuralı uygular; reddedilen onayda limit aşımı ise yetkili üst role görev açılır (onay kaybolmaz).
 * Hata fırlatır; çağıran işlem geri alınır, yükseltme görevi bu yüzden ayrı işlemde açılır (bkz. withEscalation).
 */
export class ApprovalBlocked extends Error {
  constructor(public readonly decision: ApprovalDecision, public readonly task?: { kind: string; title: string; entityType: string; entityId: string }) {
    super(decision.message);
  }
}

export async function assertApproval(db: Db, kind: PolicyKind, approver: Approver, input: { requesterId: string | null; amount: string | null; currency: string | null }, task?: { title: string; entityType: string; entityId: string }) {
  const d = await evaluateApproval(db, kind, approver, input);
  if (!d.allowed) throw new ApprovalBlocked(d, task ? { kind: "approval_escalation", ...task } : undefined);
  return d;
}

export function approvalError(e: ApprovalBlocked) {
  return conflict(e.decision.code!, e.decision.message!, { escalateToRoles: e.decision.escalateToRoles, approverLimit: e.decision.approverLimit, policyVersion: e.decision.policyVersion });
}

/** Tahmini alım tutarı: kalemin en son lot maliyeti × miktar. Bilinmiyorsa null (uydurulmaz). */
export async function estimatePurchase(db: Db, itemId: string, qty: string) {
  const c = (await db.query(
    `select lc.unit_cost, lc.currency, lo.lot_no from lot_costs lc join lots lo on lo.id = lc.lot_id where lo.item_id = $1 order by lc.id desc limit 1`,
    [itemId],
  )).rows[0];
  if (!c) return { amount: null, currency: null, source: "maliyet kaydı yok" };
  return { amount: (Number(qty) * Number(c.unit_cost)).toFixed(2), currency: c.currency as string, source: `son lot maliyeti (${c.lot_no})` };
}

/**
 * Zaman aşımı ve yükseltme (prompt §7): süresi geçen açık sistem görevi için politikadaki üst role görev açılır,
 * olay yazılır ve bildirim çıkış kutusuna konur (test modu). Aynı görev ikinci kez yükseltilmez.
 */
export async function runEscalations(db: Db, actor: Actor) {
  const due = await db.query(
    `select t.id, t.title, t.kind, t.assignee_role, t.due_at, p.escalate_to_role
       from tasks t
       join lateral (select escalate_to_role from approval_policies ap
                      where ap.company_id = t.company_id and ap.kind = case t.kind
                        when 'purchase_request_review' then 'purchase_request' when 'change_decision' then 'change_request'
                        when 'rma_inspect' then 'rma_decision' when 'incoming_inspection' then 'incoming_inspection'
                        when 'device_disposition' then 'device_disposition' end
                      order by ap.version_no desc limit 1) p on true
      where t.status in ('open', 'in_progress', 'blocked') and t.due_at is not null and t.due_at < now() and t.escalated_at is null
        and p.escalate_to_role is not null
      order by t.due_at limit 200 for update of t skip locked`,
  );
  for (const t of due.rows) {
    await db.query(`update tasks set escalated_at = now(), escalation_level = escalation_level + 1 where id = $1`, [t.id]);
    await openTask(db, actor.companyId, {
      kind: "escalation", title: `Süresi geçti: ${t.title} (${t.assignee_role})`, entityType: "task", entityId: t.id, assigneeRole: t.escalate_to_role,
    });
    await recordEvent(db, { ...actor, kind: "automation" }, {
      entityType: "task", entityId: t.id, eventType: "escalated", after: { toRole: t.escalate_to_role, dueAt: t.due_at, kind: t.kind },
    });
    await enqueue(db, actor.companyId, "notification.escalation", { taskId: t.id, toRole: t.escalate_to_role, title: t.title });
  }
  return due.rowCount ?? 0;
}

/**
 * Limit/kural engelinde asıl işlem geri alınır; üst yetkili role "limit üstü onay" görevi ve olay ayrı işlemde yazılır.
 */
export async function withApproval<T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApprovalBlocked) {
      const { tenant } = await import("../http/context");
      await tenant(req, null, async (db, actor) => {
        if (e.task) {
          for (const role of e.decision.escalateToRoles.slice(0, 1)) {
            await openTask(db, actor.companyId, { kind: e.task.kind, title: `Limit üstü onay: ${e.task.title}`, entityType: e.task.entityType, entityId: e.task.entityId, assigneeRole: role });
          }
          await recordEvent(db, actor, {
            entityType: e.task.entityType, entityId: e.task.entityId, eventType: `approval.blocked.${e.decision.code}`,
            after: { escalateToRoles: e.decision.escalateToRoles, approverLimit: e.decision.approverLimit, policyVersion: e.decision.policyVersion },
          });
        }
      });
      throw approvalError(e);
    }
    throw e;
  }
}
