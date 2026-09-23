/**
 * Durum makineleri (prompt §7). Geçişler sunucuda doğrulanır; istemci yalnızca gösterir.
 * Genel "kaydı güncelle" uç noktası durum değiştiremez.
 */
export type Transition<S extends string> = { from: readonly S[]; to: S };

export const REVISION_STATES = ["draft", "development", "pilot", "handover_review", "released", "rejected", "suspended", "end_of_life"] as const;
export type RevisionState = (typeof REVISION_STATES)[number];

export const REVISION_TRANSITIONS = {
  start_development: { from: ["draft", "rejected"], to: "development" },
  start_pilot: { from: ["development"], to: "pilot" },
  submit_handover: { from: ["development", "pilot"], to: "handover_review" },
  // "release" yalnızca üç birim onayı tamamlanınca sunucu tarafından uygulanır.
  release: { from: ["handover_review"], to: "released" },
  reject: { from: ["handover_review"], to: "rejected" },
  suspend: { from: ["released"], to: "suspended" },
} as const satisfies Record<string, Transition<RevisionState>>;

export const HANDOVER_AREAS = ["rd", "production", "quality"] as const;
export type HandoverArea = (typeof HANDOVER_AREAS)[number];

export const SALES_ORDER_STATES = ["draft", "availability_review", "firm", "cancelled"] as const;
export type SalesOrderState = (typeof SALES_ORDER_STATES)[number];

export const BOM_STATES = ["draft", "published", "archived"] as const;
export type BomState = (typeof BOM_STATES)[number];

export const LOCATION_TYPES = ["stock", "incoming_inspection", "quarantine", "production", "subcontractor", "finished"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];
/** Yalnızca bu konum tiplerindeki miktar "kullanılabilir" sayılır (prompt §4, §14). */
export const USABLE_LOCATION_TYPES: readonly LocationType[] = ["stock", "finished"];

export const PURCHASE_REQUEST_STATES = ["open", "approved", "rejected", "converted", "cancelled"] as const;
export type PurchaseRequestState = (typeof PURCHASE_REQUEST_STATES)[number];

export const INSPECTION_DECISIONS = ["accept", "reject", "partial"] as const;

/** Veri durumu: demo, test, canlı, bağlanmadı, eski veri, hata ayrı gösterilir (prompt §2.9). */
export const DATA_MODES = ["demo", "test", "live", "not_connected", "stale", "error"] as const;
export type DataMode = (typeof DATA_MODES)[number];

export function canTransition<S extends string>(t: Transition<S>, current: S): boolean {
  return (t.from as readonly string[]).includes(current);
}
