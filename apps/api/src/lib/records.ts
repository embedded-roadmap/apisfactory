import { POLICY_TASK_KIND } from "@apisfactory/shared";
import type { Db } from "../db/pool";

export type Actor = { companyId: string; userId: string | null; kind?: "human" | "import" | "api" | "automation"; correlationId?: string; onBehalfOf?: string };

/** İş olayı: kim, ne zaman, neyi, önceki/sonraki durum ve gerekçe. Sır içermez. */
export async function recordEvent(
  db: Db,
  actor: Actor,
  e: { entityType: string; entityId: string; eventType: string; before?: unknown; after?: unknown; reason?: string; source?: string },
) {
  await db.query(
    `insert into events (company_id, entity_type, entity_id, event_type, actor_user_id, actor_kind, source, before_state, after_state, reason, correlation_id, on_behalf_of)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      actor.companyId,
      e.entityType,
      e.entityId,
      e.eventType,
      actor.userId,
      actor.kind ?? "human",
      e.source ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.reason ?? null,
      actor.correlationId ?? null,
      actor.onBehalfOf ?? null,
    ],
  );
}

/** Arka plan işi: veri değişikliğiyle aynı işlemde yazılır; işlem geri alınırsa olay da oluşmaz. */
export async function enqueue(db: Db, companyId: string, topic: string, payload: unknown) {
  await db.query("insert into outbox (company_id, topic, payload) values ($1,$2,$3)", [companyId, topic, JSON.stringify(payload)]);
}

/**
 * Role atanmış görev açar; aynı iş için ikinci kez açılmaz. Onay politikasında süre tanımlıysa bitiş zamanı atanır;
 * süresi geçen görev üst sorumluya yükseltilir (lib/workflow.ts).
 */
export async function openTask(
  db: Db,
  companyId: string,
  t: { kind: string; title: string; entityType: string; entityId: string; assigneeRole: string },
) {
  await db.query(
    `insert into tasks (company_id, kind, title, entity_type, entity_id, assignee_role, due_at)
     values ($1, $2, $3, $4, $5, $6,
             now() + make_interval(hours => (select p.timeout_hours from approval_policies p
                                               where p.company_id = $1 and p.kind = $7 order by p.version_no desc limit 1)))
     on conflict (company_id, kind, entity_id, assignee_role) where kind <> 'manual'
     do update set status = 'open', closed_at = null, title = excluded.title, due_at = excluded.due_at, escalated_at = null, escalation_level = 0`,
    [companyId, t.kind, t.title, t.entityType, t.entityId, t.assigneeRole, POLICY_TASK_KIND[t.kind] ?? null],
  );
}

export async function closeTasks(db: Db, companyId: string, kind: string, entityId: string, assigneeRole?: string) {
  const r = await db.query(
    `update tasks set status = 'done', closed_at = now()
      where company_id = $1 and kind = $2 and entity_id = $3 and status in ('open', 'in_progress', 'blocked') and ($4::text is null or assignee_role = $4)
      returning id`,
    [companyId, kind, entityId, assigneeRole ?? null],
  );
  // Asıl iş kapanınca ona ait yükseltme görevleri de kapanır.
  if (r.rowCount) {
    await db.query(
      `update tasks set status = 'done', closed_at = now() where company_id = $1 and kind = 'escalation' and entity_id = any($2) and status in ('open', 'in_progress', 'blocked')`,
      [companyId, r.rows.map((x) => x.id)],
    );
  }
}

/** İnsanın okuyacağı sıralı kod (SO-000123). Satır kilidiyle çakışmasız. */
export async function nextCode(db: Db, companyId: string, name: string, prefix: string): Promise<string> {
  const r = await db.query(
    `insert into counters (company_id, name, value) values ($1,$2,1)
     on conflict (company_id, name) do update set value = counters.value + 1
     returning value`,
    [companyId, name],
  );
  return `${prefix}-${String(r.rows[0].value).padStart(6, "0")}`;
}

/**
 * Tekrar koruması: aynı kapsam+anahtar daha önce işlendiyse kayıtlı yanıtı döner.
 * İlk çağrıda satır kilitlenir; eşzamanlı ikinci çağrı ilkinin bitmesini bekler.
 */
export async function idempotent<T>(db: Db, companyId: string, scope: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const ins = await db.query(
    `insert into idempotency_keys (company_id, scope, key) values ($1,$2,$3) on conflict do nothing returning key`,
    [companyId, scope, key],
  );
  if (ins.rowCount === 0) {
    const prev = await db.query(`select response from idempotency_keys where company_id=$1 and scope=$2 and key=$3 for update`, [companyId, scope, key]);
    if (prev.rows[0]?.response) return prev.rows[0].response as T;
  }
  const result = await fn();
  await db.query(`update idempotency_keys set response = $4 where company_id=$1 and scope=$2 and key=$3`, [companyId, scope, key, JSON.stringify(result)]);
  return result;
}
