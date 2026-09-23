import type { Db } from "../db/pool";

/** Varsayılan rota şablonu: revizyonun yayımlanmış rotası yoksa kullanılır; süreler iş merkezinin standart süresinden gelir. */
export const DEFAULT_ROUTE: { wc: string; name: string; gate?: boolean }[] = [
  { wc: "HAZ", name: "Malzeme hazırlama" },
  { wc: "SMT", name: "Dizgi (SMT)" },
  { wc: "LEH", name: "Lehim / THT" },
  { wc: "PRG", name: "Programlama" },
  { wc: "TST", name: "Fonksiyon testi", gate: true },
  { wc: "MON", name: "Mekanik montaj" },
];

export type RouteOp = {
  seq: number;
  name: string;
  workCenterId: string | null;
  workCenter: string;
  setupMinutes: number;
  minutesPerUnit: number;
  isQualityGate: boolean;
  instructions: string | null;
};
export type Route = { routingId: string | null; versionNo: number | null; source: "routing" | "default"; ops: RouteOp[] };

async function routingOps(db: Db, routingId: string): Promise<RouteOp[]> {
  const r = await db.query(
    `select o.seq, o.name, o.work_center_id as "workCenterId", wc.code as "workCenter", o.setup_minutes::float8 as "setupMinutes",
            o.minutes_per_unit::float8 as "minutesPerUnit", o.is_quality_gate as "isQualityGate", o.instructions
       from routing_operations o join work_centers wc on wc.id = o.work_center_id where o.routing_id = $1 order by o.seq`,
    [routingId],
  );
  return r.rows;
}

export async function defaultRoute(db: Db): Promise<RouteOp[]> {
  const wcs = await db.query(`select id, code, setup_minutes::float8 as s, minutes_per_unit::float8 as m from work_centers`);
  const by = new Map(wcs.rows.map((w) => [w.code as string, w]));
  return DEFAULT_ROUTE.map((op, i) => {
    const w = by.get(op.wc);
    return { seq: (i + 1) * 10, name: op.name, workCenterId: w?.id ?? null, workCenter: op.wc, setupMinutes: w?.s ?? 0, minutesPerUnit: w?.m ?? 0, isQualityGate: !!op.gate, instructions: null };
  });
}

/** Revizyonun geçerli rotası: en son yayımlanan sürüm; yoksa varsayılan şablon. */
export async function routeFor(db: Db, revisionId: string): Promise<Route> {
  const r = await db.query(
    `select id, version_no from routings where product_revision_id = $1 and status = 'published' order by version_no desc limit 1`,
    [revisionId],
  );
  if (r.rows[0]) return { routingId: r.rows[0].id, versionNo: r.rows[0].version_no, source: "routing", ops: await routingOps(db, r.rows[0].id) };
  return { routingId: null, versionNo: null, source: "default", ops: await defaultRoute(db) };
}

export { routingOps };

/** Rota kuralları: en az bir operasyon, benzersiz sıra, tam olarak bir kalite kapısı (test ve son kalite akışı buna bağlı). */
export function validateRoute(ops: { seq: number; name: string; isQualityGate: boolean; workCenterId: string | null }[]) {
  const errors: string[] = [];
  if (!ops.length) errors.push("Rotada en az bir operasyon olmalı");
  const seqs = new Set<number>();
  for (const o of ops) {
    if (seqs.has(o.seq)) errors.push(`Sıra numarası tekrar ediyor: ${o.seq}`);
    seqs.add(o.seq);
    if (!o.name.trim()) errors.push(`${o.seq}: operasyon adı boş`);
    if (!o.workCenterId) errors.push(`${o.seq}: iş merkezi seçilmeli`);
  }
  const gates = ops.filter((o) => o.isQualityGate).length;
  if (gates !== 1) errors.push(`Rotada tam olarak bir kalite kapısı (test operasyonu) olmalı; şu an ${gates}`);
  return errors;
}

/** Operasyonun planlanan süresi (dakika) = hazırlık + adet × birim süre. */
export const plannedMinutes = (op: { setupMinutes: number; minutesPerUnit: number }, qty: number) => op.setupMinutes + qty * op.minutesPerUnit;
