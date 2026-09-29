import type { Db } from "../db/pool";
import { nextCode, openTask, recordEvent, type Actor } from "./records";

/**
 * R18 — tekrarlayan hata tespiti (ana talimat §16). Hata kodlu uygunsuzluk kaydedildiğinde çağrılır:
 *  - Aynı ürün + hata kodu için açık düzeltici faaliyet (DF) varsa kayıt ona bağlanır (tekrar olarak).
 *  - Yoksa: pencere içinde DF'ye bağlı olmayan aynı ürün/kod kayıtları eşiğe ulaştıysa DF açılır, kayıtlar bağlanır,
 *    kaliteye görev düşer.
 */
export async function settings(db: Db) {
  const r = (await db.query(`select threshold, window_days from capa_settings`)).rows[0];
  return { threshold: r?.threshold ?? 3, windowDays: r?.window_days ?? 30 };
}

export async function detectRecurrence(db: Db, actor: Actor, ncId: string) {
  const nc = (await db.query(
    `select n.id, n.defect_code, p.id as product_id, p.code as product_code
       from nonconformances n join devices d on d.id = n.device_id join work_orders w on w.id = d.work_order_id
       join product_revisions pr on pr.id = w.product_revision_id join products p on p.id = pr.product_id
      where n.id = $1`,
    [ncId],
  )).rows[0];
  if (!nc?.defect_code) return null;
  // Aynı ürün + kod için eşzamanlı iki karar aynı anda DF açmasın.
  await db.query(`select pg_advisory_xact_lock(hashtext('capa:' || $1::text || $2))`, [nc.product_id, nc.defect_code]);
  const open = (await db.query(
    `select id, code from corrective_actions where product_id = $1 and defect_code = $2 and status <> 'closed'`,
    [nc.product_id, nc.defect_code],
  )).rows[0];
  if (open) {
    await db.query(`update nonconformances set capa_id = $2 where id = $1`, [ncId, open.id]);
    await recordEvent(db, actor, { entityType: "corrective_action", entityId: open.id, eventType: "recurrence.linked", after: { nonconformanceId: ncId } });
    return { capaId: open.id as string, code: open.code as string, created: false };
  }
  const s = await settings(db);
  const same = (await db.query(
    `select n.id from nonconformances n join devices d on d.id = n.device_id join work_orders w on w.id = d.work_order_id
       join product_revisions pr on pr.id = w.product_revision_id
      where pr.product_id = $1 and n.defect_code = $2 and n.capa_id is null and n.created_at >= now() - make_interval(days => $3)
      order by n.created_at`,
    [nc.product_id, nc.defect_code, s.windowDays],
  )).rows.map((r) => r.id as string);
  if (same.length < s.threshold) return null;
  const code = await nextCode(db, actor.companyId, "corrective_action", "DF");
  const r = await db.query(
    `insert into corrective_actions (company_id, code, product_id, defect_code, trigger) values (app_company_id(), $1, $2, $3, $4) returning id`,
    [code, nc.product_id, nc.defect_code, JSON.stringify({ nonconformanceIds: same, count: same.length, threshold: s.threshold, windowDays: s.windowDays })],
  );
  const id = r.rows[0].id as string;
  await db.query(`update nonconformances set capa_id = $2 where id = any($1)`, [same, id]);
  await openTask(db, actor.companyId, { kind: "capa", title: `Düzeltici faaliyet ${code}: ${nc.product_code} — ${nc.defect_code} (${same.length} tekrar / ${s.windowDays} gün)`, entityType: "corrective_action", entityId: id, assigneeRole: "quality" });
  await recordEvent(db, actor, { entityType: "corrective_action", entityId: id, eventType: "opened", after: { code, product: nc.product_code, defectCode: nc.defect_code, count: same.length, threshold: s.threshold, windowDays: s.windowDays } });
  return { capaId: id, code, created: true };
}
