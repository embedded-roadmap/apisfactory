import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "./errors";
import { recordEvent, type Actor } from "./records";
import { encryptSecret } from "./secrets";

/**
 * Bağlayıcı erişim bilgisi (e-belge entegratörü, kargo firması) — ortak kayıt mantığı.
 * Değerler şifreli saklanır; yanıt ve olay kaydı yalnız alan ADLARINI içerir, değerleri asla.
 */

const TABLES = { einvoice: "einvoice_connectors", cargo: "cargo_connectors", distributor: "distributor_connectors" } as const;
export type ConnectorKind = keyof typeof TABLES;

/** 'live' moda geçiş kapısı — tüm bağlayıcı türleri için aynı kural (DB'de ayrıca *_live_ready kısıtı var). */
export function assertLiveAllowed(cur: { name: string; hasCredentials: boolean; environment: string | null }, hasAdapter: boolean) {
  if (!hasAdapter) throw conflict("adapter_not_available", `${cur.name} için gerçek bağlantı henüz geliştirilmedi; canlı moda alınamaz`);
  if (!cur.hasCredentials || !cur.environment) throw conflict("credentials_missing", "Canlı mod için önce erişim bilgisi ve ortam (sandbox/production) kaydedilmeli");
}

export const credentialsSchema = z.object({
  environment: z.enum(["sandbox", "production"]),
  credentials: z
    .record(z.string().min(1).max(100), z.string().min(1).max(4000))
    .refine((c) => Object.keys(c).length >= 1 && Object.keys(c).length <= 10, "1–10 erişim bilgisi alanı gerekli"),
  reason: z.string().min(3).max(500),
});

export async function saveConnectorCredentials(
  db: Db,
  actor: Actor & { userId: string },
  kind: ConnectorKind,
  id: string,
  input: z.infer<typeof credentialsSchema>,
  requiredFields: (key: string) => string[] | undefined,
) {
  const table = TABLES[kind];
  const cur = (await db.query(`select key, environment, credentials_enc is not null as "hasCredentials" from ${table} where id = $1 for update`, [id])).rows[0];
  if (!cur) throw notFound("Bağlayıcı");
  const missing = requiredFields(cur.key)?.filter((f) => !input.credentials[f]) ?? [];
  if (missing.length) throw badRequest(`Eksik erişim bilgisi alanları: ${missing.join(", ")}`, { missing });
  await db.query(
    `update ${table} set environment = $2, credentials_enc = $3, credentials_updated_by = $4, credentials_updated_at = now() where id = $1`,
    [id, input.environment, encryptSecret(input.credentials), actor.userId],
  );
  const fields = Object.keys(input.credentials).sort();
  await recordEvent(db, actor, {
    entityType: `${kind}_connector`, entityId: id, eventType: "credentials.updated",
    before: { environment: cur.environment, hasCredentials: cur.hasCredentials }, after: { environment: input.environment, fields }, reason: input.reason,
  });
  return { id, environment: input.environment, hasCredentials: true, fields };
}
