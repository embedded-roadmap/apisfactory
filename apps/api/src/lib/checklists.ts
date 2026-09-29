import { z } from "zod";
import type { Db } from "../db/pool";
import { conflict } from "./errors";

/**
 * Kontrol listeleri (R16/R17/R18; ana talimat §15, §16). Plan maddeleri: onay (check), ölçüm (measure, alt/üst sınır,
 * birim), metin (text). Karar sunucuda: zorunlu madde eksikse veya ölçüm sınır dışıysa ya da onay "hayır" ise kaldı.
 * Uygulanabilir plan = kodun en yüksek sürümü, aktif ve bağlama uyan (boş bağlam alanı = hepsine uyar).
 * Kapanış kuralı: bağlamdaki her uygulanabilir planın GÜNCEL sürümüne karşı en son kayıt "geçti" olmalı.
 */

export const CheckItem = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().min(2).max(200),
  kind: z.enum(["check", "measure", "text"]),
  required: z.boolean().default(true),
  unit: z.string().max(20).optional(),
  low: z.number().optional(),
  high: z.number().optional(),
});
export type CheckItem = z.infer<typeof CheckItem>;

export type Context = { type: "operation" | "receipt_line" | "work_order"; id: string };
type PlanRow = { id: string; code: string; version_no: number; name: string; stage: string; items: CheckItem[] };

export function evaluate(items: CheckItem[], results: { key: string; value: unknown }[]) {
  const findings: string[] = [];
  const clean: { key: string; value: unknown }[] = [];
  for (const it of items) {
    const r = results.find((x) => x.key === it.key);
    const v = r?.value;
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      if (it.required) findings.push(`${it.label}: zorunlu, girilmedi`);
      continue;
    }
    if (it.kind === "check") {
      if (typeof v !== "boolean") { findings.push(`${it.label}: evet/hayır bekleniyor`); continue; }
      if (!v) findings.push(`${it.label}: uygun değil`);
    } else if (it.kind === "measure") {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) { findings.push(`${it.label}: sayı bekleniyor`); continue; }
      if (it.low !== undefined && n < it.low) findings.push(`${it.label}: ${n}${it.unit ?? ""} < alt sınır ${it.low}`);
      if (it.high !== undefined && n > it.high) findings.push(`${it.label}: ${n}${it.unit ?? ""} > üst sınır ${it.high}`);
      clean.push({ key: it.key, value: n });
      continue;
    } else if (typeof v !== "string") { findings.push(`${it.label}: metin bekleniyor`); continue; }
    clean.push({ key: it.key, value: v });
  }
  const unknown = results.filter((x) => !items.some((i) => i.key === x.key)).map((x) => x.key);
  if (unknown.length) findings.push(`Planda olmayan madde: ${unknown.join(", ")}`);
  return { passed: findings.length === 0, findings, results: clean };
}

/** Bağlamın uygulanabilir planları (güncel sürümler). */
export async function applicablePlans(db: Db, ctx: Context): Promise<PlanRow[]> {
  let stageSql: string;
  let params: unknown[];
  if (ctx.type === "operation") {
    const op = (await db.query(
      `select o.work_center_id, w.product_revision_id from work_order_operations o join work_orders w on w.id = o.work_order_id where o.id = $1`,
      [ctx.id],
    )).rows[0];
    if (!op) return [];
    stageSql = `p.stage in ('in_process', 'packing') and (p.work_center_id is null or p.work_center_id = $1) and (p.product_revision_id is null or p.product_revision_id = $2)`;
    params = [op.work_center_id, op.product_revision_id];
  } else if (ctx.type === "receipt_line") {
    const line = (await db.query(`select l.item_id from goods_receipt_lines gl join lots l on l.id = gl.lot_id where gl.id = $1`, [ctx.id])).rows[0];
    if (!line) return [];
    stageSql = `p.stage = 'incoming' and (p.item_id is null or p.item_id = $1) and $2::uuid is null`;
    params = [line.item_id, null];
  } else {
    const wo = (await db.query(`select product_revision_id from work_orders where id = $1`, [ctx.id])).rows[0];
    if (!wo) return [];
    stageSql = `p.stage = 'final' and (p.product_revision_id is null or p.product_revision_id = $1) and $2::uuid is null`;
    params = [wo.product_revision_id, null];
  }
  return (await db.query(
    `select p.id, p.code, p.version_no, p.name, p.stage, p.items
       from (select distinct on (code) * from check_plans order by code, version_no desc) p
      where p.active and ${stageSql} order by p.code`,
    params,
  )).rows as PlanRow[];
}

/** Bağlam için planlar + her planın güncel sürümüne karşı en son kaydı. */
export async function checkStatus(db: Db, ctx: Context) {
  const plans = await applicablePlans(db, ctx);
  const out = [];
  for (const p of plans) {
    const last = (await db.query(
      `select r.id, r.passed, r.findings, r.results, r.recorded_at as "recordedAt", u.name as "recordedBy"
         from check_records r left join users u on u.id = r.recorded_by
        where r.plan_id = $1 and r.context_type = $2 and r.context_id = $3 order by r.recorded_at desc limit 1`,
      [p.id, ctx.type, ctx.id],
    )).rows[0] ?? null;
    out.push({ planId: p.id, code: p.code, versionNo: p.version_no, name: p.name, stage: p.stage, items: p.items, last });
  }
  return out;
}

/** Kapanış kuralı: eksik veya kalan kontrol varsa 409 (checklist_required / checklist_failed). */
export async function assertChecksPassed(db: Db, ctx: Context, what: string) {
  const st = await checkStatus(db, ctx);
  const missing = st.filter((s) => !s.last).map((s) => `${s.code} v${s.versionNo}`);
  if (missing.length) throw conflict("checklist_required", `${what}: kontrol listesi doldurulmadan kapatılamaz (${missing.join(", ")})`, { missing });
  const failed = st.filter((s) => s.last && !s.last.passed);
  if (failed.length) throw conflict("checklist_failed", `${what}: son kontrol kaydı başarısız (${failed.map((s) => s.code).join(", ")}); yeniden kontrol veya kalite kararı gerekir`, { failed: failed.map((s) => ({ code: s.code, findings: s.last!.findings })) });
}
