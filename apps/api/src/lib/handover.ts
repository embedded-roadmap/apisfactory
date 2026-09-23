import type { Db } from "../db/pool";

export const REQUIREMENTS = ["test_plan", "firmware", "firmware_sha", "routing"] as const;
export type Requirement = (typeof REQUIREMENTS)[number];
const LABEL: Record<Requirement | "bom", string> = {
  bom: "Yayımlanmış BOM bağlı",
  test_plan: "Yayımlanmış test planı",
  firmware: "Firmware sürümü girilmiş",
  firmware_sha: "Firmware SHA-256 özeti girilmiş",
  routing: "Yayımlanmış rota",
};

export type HandoverPolicy = {
  versionNo: number | null;
  requireTestPlan: boolean;
  requireFirmware: boolean;
  requireFirmwareSha: boolean;
  requireRouting: boolean;
  note: string | null;
};

export async function currentHandoverPolicy(db: Db): Promise<HandoverPolicy> {
  const r = await db.query(
    `select version_no as "versionNo", require_test_plan as "requireTestPlan", require_firmware as "requireFirmware",
            require_firmware_sha as "requireFirmwareSha", require_routing as "requireRouting", note
       from handover_policies order by version_no desc limit 1`,
  );
  return r.rows[0] ?? { versionNo: null, requireTestPlan: false, requireFirmware: false, requireFirmwareSha: false, requireRouting: false, note: null };
}

export type ReadinessItem = { key: Requirement | "bom"; label: string; required: boolean; ok: boolean; detail: string | null; waiver: { reason: string; by: string | null; at: string } | null };

/**
 * Devir hazırlığı: BOM her zaman zorunlu; diğerleri şirketin devir politikasına göre.
 * Muafiyet yalnızca zorunlu ve eksik maddeyi karşılar; gerekçesi ve kimin verdiği kontrol listesinde görünür.
 */
export async function handoverReadiness(db: Db, revisionId: string) {
  const policy = await currentHandoverPolicy(db);
  const r = (await db.query(
    `select pr.bom_version_id, pr.firmware_version, pr.firmware_sha256, b.status as bom_status, b.version_no as bom_no,
            (select max(version_no) from test_plans tp where tp.product_revision_id = pr.id and tp.status = 'published') as plan_no,
            (select max(version_no) from routings rt where rt.product_revision_id = pr.id and rt.status = 'published') as routing_no
       from product_revisions pr left join bom_versions b on b.id = pr.bom_version_id where pr.id = $1`,
    [revisionId],
  )).rows[0];
  if (!r) return null;
  const waivers = await db.query(
    `select w.requirement, w.reason, u.name as by, w.created_at as at from handover_waivers w left join users u on u.id = w.granted_by where w.revision_id = $1`,
    [revisionId],
  );
  const wv = new Map(waivers.rows.map((w) => [w.requirement as string, { reason: w.reason as string, by: w.by as string | null, at: w.at as string }]));
  const item = (key: Requirement | "bom", required: boolean, ok: boolean, detail: string | null): ReadinessItem => ({
    key, label: LABEL[key], required, ok, detail, waiver: key !== "bom" && required && !ok ? wv.get(key) ?? null : null,
  });
  const items: ReadinessItem[] = [
    item("bom", true, !!r.bom_version_id && r.bom_status === "published", r.bom_version_id ? `BOM v${r.bom_no} (${r.bom_status === "published" ? "yayımlı" : "taslak"})` : "bağlı değil"),
    item("test_plan", policy.requireTestPlan, r.plan_no != null, r.plan_no != null ? `v${r.plan_no}` : "yok"),
    item("firmware", policy.requireFirmware, !!r.firmware_version, r.firmware_version ?? "girilmemiş"),
    item("firmware_sha", policy.requireFirmwareSha, !!r.firmware_sha256, r.firmware_sha256 ? `${String(r.firmware_sha256).slice(0, 12)}…` : "girilmemiş"),
    item("routing", policy.requireRouting, r.routing_no != null, r.routing_no != null ? `v${r.routing_no}` : "yok (varsayılan şablon kullanılır)"),
  ];
  const missing = items.filter((i) => i.required && !i.ok && !i.waiver);
  return { policyVersion: policy.versionNo, ready: missing.length === 0, missing: missing.map((m) => m.key), items };
}
