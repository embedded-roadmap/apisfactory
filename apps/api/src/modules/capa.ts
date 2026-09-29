import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { conflict, notFound } from "../lib/errors";
import { closeTasks, openTask, recordEvent } from "../lib/records";
import { parse, tenant } from "../http/context";
import { settings } from "../lib/capa";

/**
 * R18 — düzeltici faaliyet (DF) ve etkinlik kontrolü. Tespit: lib/capa.ts (kalite kararı sırasında).
 * Akış: open → (kök neden + faaliyet + kontrol süresi) action_taken → doğrulama: etkili → closed, etkisiz → open (yeniden).
 * Faaliyeti giren doğrulayamaz. Faaliyetten sonra aynı hata tekrar ettiyse "etkili" kararı gerekçe (≥ 20 karakter) ister.
 */

async function loadCapa(db: Db, id: string) {
  const c = (await db.query(
    `select c.id, c.code, c.status, c.defect_code as "defectCode", c.trigger, c.root_cause as "rootCause", c.action, c.action_at as "actionAt",
            au.name as "actionBy", c.action_by as "actionById", c.check_due::text as "checkDue", c.verified_at as "verifiedAt", vu.name as "verifiedBy",
            c.verification_note as "verificationNote", c.reopen_count as "reopenCount", c.created_at as "createdAt", p.id as "productId", p.code as "productCode", p.name as "productName"
       from corrective_actions c join products p on p.id = c.product_id left join users au on au.id = c.action_by left join users vu on vu.id = c.verified_by
      where c.id = $1`,
    [id],
  )).rows[0];
  if (!c) throw notFound("Düzeltici faaliyet");
  const occurrences = (await db.query(
    `select n.id, n.created_at as "createdAt", d.serial, w.code as "workOrderCode", n.decision, n.note
       from nonconformances n join devices d on d.id = n.device_id join work_orders w on w.id = d.work_order_id
      where n.capa_id = $1 order by n.created_at`,
    [id],
  )).rows;
  const since = c.actionAt ? occurrences.filter((o) => new Date(o.createdAt) > new Date(c.actionAt)).length : null;
  return { ...c, occurrences, recurrencesSinceAction: since };
}

export async function capaRoutes(app: FastifyInstance) {
  app.get("/api/capa-settings", async (req) => tenant(req, "production.view", (db) => settings(db)));

  app.post("/api/capa-settings", async (req) => {
    const input = parse(z.object({ threshold: z.number().int().min(2).max(100), windowDays: z.number().int().min(1).max(365), reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "quality.plan.manage", async (db, actor) => {
      const before = await settings(db);
      await db.query(
        `insert into capa_settings (company_id, threshold, window_days, updated_by) values (app_company_id(), $1, $2, $3)
         on conflict (company_id) do update set threshold = excluded.threshold, window_days = excluded.window_days, updated_by = excluded.updated_by, updated_at = now()`,
        [input.threshold, input.windowDays, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "capa_settings", entityId: actor.companyId, eventType: "updated", before, after: input, reason: input.reason });
      return { threshold: input.threshold, windowDays: input.windowDays };
    });
  });

  app.get("/api/capas", async (req) => {
    const q = z.object({ status: z.enum(["open", "action_taken", "closed"]).optional() }).parse(req.query);
    return tenant(req, "production.view", async (db) =>
      (await db.query(
        `select c.id, c.code, c.status, c.defect_code as "defectCode", p.code as "productCode", c.check_due::text as "checkDue", c.reopen_count as "reopenCount",
                (select count(*) from nonconformances n where n.capa_id = c.id)::int as occurrences, c.created_at as "createdAt"
           from corrective_actions c join products p on p.id = c.product_id
          where ($1::text is null or c.status = $1) order by (c.status = 'closed'), c.created_at desc`,
        [q.status ?? null],
      )).rows,
    );
  });

  app.get("/api/capas/:id", async (req) => tenant(req, "production.view", (db) => loadCapa(db, (req.params as { id: string }).id)));

  app.post("/api/capas/:id/action", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ rootCause: z.string().min(10).max(4000), action: z.string().min(10).max(4000), checkAfterDays: z.number().int().min(1).max(365) }), req.body);
    return tenant(req, "quality.plan.manage", async (db, actor) => {
      const c = (await db.query(`select status, code from corrective_actions where id = $1 for update`, [id])).rows[0];
      if (!c) throw notFound("Düzeltici faaliyet");
      if (c.status !== "open") throw conflict("invalid_transition", "Faaliyet yalnız açık DF'ye girilir");
      await db.query(
        `update corrective_actions set status = 'action_taken', root_cause = $2, action = $3, action_by = $4, action_at = now(),
                check_due = current_date + $5::int where id = $1`,
        [id, input.rootCause, input.action, actor.userId, input.checkAfterDays],
      );
      await closeTasks(db, actor.companyId, "capa", id);
      await openTask(db, actor.companyId, { kind: "capa_verify", title: `Etkinlik kontrolü ${c.code}`, entityType: "corrective_action", entityId: id, assigneeRole: "quality" });
      await db.query(`update tasks set due_date = current_date + $2::int where kind = 'capa_verify' and entity_id = $1 and status = 'open'`, [id, input.checkAfterDays]);
      await recordEvent(db, actor, { entityType: "corrective_action", entityId: id, eventType: "action_taken", after: input });
      return loadCapa(db, id);
    });
  });

  app.post("/api/capas/:id/verify", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ effective: z.boolean(), note: z.string().max(2000).optional() }), req.body);
    return tenant(req, "quality.plan.manage", async (db, actor) => {
      await db.query(`select id from corrective_actions where id = $1 for update`, [id]);
      const c = await loadCapa(db, id);
      if (c.status !== "action_taken") throw conflict("invalid_transition", "Doğrulama faaliyet girildikten sonra yapılır");
      if (c.actionById === actor.userId) throw conflict("self_verification", "Faaliyeti giren kişi etkinliği doğrulayamaz");
      if (input.effective && c.recurrencesSinceAction > 0 && (input.note ?? "").trim().length < 20) {
        throw conflict("recurrence_after_action", `Faaliyetten sonra ${c.recurrencesSinceAction} tekrar var; "etkili" kararı için gerekçe (≥ 20 karakter) gerekli`);
      }
      if (!input.effective && !(input.note ?? "").trim()) throw conflict("reason_required", "Etkisiz kararı için gerekçe gerekli");
      if (input.effective) {
        await db.query(`update corrective_actions set status = 'closed', verified_by = $2, verified_at = now(), verification_note = $3 where id = $1`, [id, actor.userId, input.note ?? null]);
      } else {
        await db.query(`update corrective_actions set status = 'open', reopen_count = reopen_count + 1, verification_note = $2 where id = $1`, [id, input.note]);
        await openTask(db, actor.companyId, { kind: "capa", title: `Düzeltici faaliyet ${c.code} etkisiz — yeniden ele al`, entityType: "corrective_action", entityId: id, assigneeRole: "quality" });
      }
      await closeTasks(db, actor.companyId, "capa_verify", id);
      await recordEvent(db, actor, { entityType: "corrective_action", entityId: id, eventType: input.effective ? "verified.effective" : "verified.ineffective", after: { recurrencesSinceAction: c.recurrencesSinceAction }, reason: input.note });
      return loadCapa(db, id);
    });
  });
}
