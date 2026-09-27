import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { recordEvent, type Actor } from "../lib/records";
import { decryptSecret, encryptSecret } from "../lib/secrets";
import { EINVOICE_PROVIDERS, einvoiceReadiness, type EinvoiceEnvironment } from "../lib/einvoice-providers";
import { parse, tenant } from "../http/context";

/**
 * W36 — e-fatura/e-arşiv ve kargo bağlayıcıları. GERÇEK ENTEGRASYON YOK.
 *  - Sağlayıcı seçimi (entegratör, kargo firması) şirketin ticari kararıdır; burada yaygın seçenekler taslak listelenir,
 *    varsayılan BAĞLANMADI. Yalnız TEST modu var: sentetik ETTN/takip no üretir, hiçbir dış sisteme gönderilmez.
 *  - E-belge: kesilmiş (issued) müşteri faturası için, tür (e-Fatura / e-Arşiv) elle seçilir — mükellef sorgusu yok.
 *    Belge modu "test" olur ve sabitlenir (yeniden gönderilemez); iptal edilen fatura yeniden faturalanır (W24 kuralı).
 *  - Kargo: paketlenmiş sevkiyat için sentetik etiket/takip no üretir; mevcut "sevk et" adımı bunu taşıyıcı olarak kullanır.
 *  - Oturum 41: e-belgede CANLI mod altyapısı — şirket başına şifreli erişim bilgisi (düz metin asla geri dönmez),
 *    sağlayıcıdan bağımsız hazırlık denetimi (vergi kimliği, adres, satır). 'live' moda geçiş yalnız o sağlayıcının
 *    adaptörü EINVOICE_PROVIDERS'a eklenmişse ve erişim bilgisi + ortam kayıtlıysa mümkündür; şu an hiçbir adaptör yok.
 */

const EINVOICE_NAMES: Record<string, string> = { gib_portal: "GİB e-Belge Portalı", uyumsoft: "Uyumsoft", foriba: "Foriba", logo: "Logo e-Fatura", parasut: "Paraşüt", nesbilgi: "Nesbilgi" };
const CARGO_NAMES: Record<string, string> = { yurtici: "Yurtiçi Kargo", aras: "Aras Kargo", mng: "MNG Kargo", ptt: "PTT Kargo", surat: "Sürat Kargo", ups: "UPS" };
const CARGO_PREFIX: Record<string, string> = { yurtici: "YK", aras: "AR", mng: "MG", ptt: "PT", surat: "SR", ups: "1Z" };

export async function ensureEinvoiceCargoConnectors(db: Db) {
  for (const [key, name] of Object.entries(EINVOICE_NAMES)) await db.query(`insert into einvoice_connectors (company_id, key, name) values (app_company_id(), $1, $2) on conflict do nothing`, [key, name]);
  for (const [key, name] of Object.entries(CARGO_NAMES)) await db.query(`insert into cargo_connectors (company_id, key, name) values (app_company_id(), $1, $2) on conflict do nothing`, [key, name]);
}

/** Sentetik ETTN: gerçek GİB kaydı değildir, yalnız test izlenebilirliği için deterministik değildir (her gönderimde yeni). */
function syntheticEttn() {
  return randomUUID();
}

/** Sentetik takip no: bağlayıcı + sevkiyat koduna göre deterministik (aynı sevkiyat için aynı çıktı). */
function syntheticTrackingNo(key: string, shipmentCode: string) {
  const h = createHash("sha256").update(`${key}:${shipmentCode}`).digest();
  const digits = Array.from(h.subarray(0, 9)).map((b) => b % 10).join("");
  return `${CARGO_PREFIX[key] ?? "CG"}${digits}`;
}

const modeSchema = z.object({ mode: z.enum(["not_connected", "test"]), note: z.string().max(500).nullable().optional(), reason: z.string().min(3).max(500) });
const einvoiceModeSchema = modeSchema.extend({ mode: z.enum(["not_connected", "test", "live"]) });
const credentialsSchema = z.object({
  environment: z.enum(["sandbox", "production"]),
  credentials: z
    .record(z.string().min(1).max(100), z.string().min(1).max(4000))
    .refine((c) => Object.keys(c).length >= 1 && Object.keys(c).length <= 10, "1–10 erişim bilgisi alanı gerekli"),
  reason: z.string().min(3).max(500),
});
const kindSchema = z.enum(["e_fatura", "e_arsiv"]);

export async function dispatchRoutes(app: FastifyInstance) {
  // ---- e-fatura/e-arşiv bağlayıcıları ----
  app.get("/api/einvoice-connectors", async (req) =>
    tenant(req, "receivable.view", async (db) => {
      await ensureEinvoiceCargoConnectors(db);
      return (
        await db.query(
          `select id, key, name, mode, note, updated_at as "updatedAt", environment,
                  credentials_enc is not null as "hasCredentials", credentials_updated_at as "credentialsUpdatedAt"
             from einvoice_connectors order by key`,
        )
      ).rows.map((r) => ({ ...r, adapterAvailable: Boolean(EINVOICE_PROVIDERS[r.key]), credentialFields: EINVOICE_PROVIDERS[r.key]?.credentialFields ?? null }));
    }),
  );

  app.post("/api/einvoice-connectors/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(einvoiceModeSchema, req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const cur = (await db.query(`select key, name, mode, note, environment, credentials_enc is not null as "hasCredentials" from einvoice_connectors where id = $1 for update`, [id])).rows[0];
      if (!cur) throw notFound("Bağlayıcı");
      if (input.mode === "live") {
        if (!EINVOICE_PROVIDERS[cur.key]) throw conflict("adapter_not_available", `${cur.name} için gerçek bağlantı henüz geliştirilmedi; canlı moda alınamaz`);
        if (!cur.hasCredentials || !cur.environment) throw conflict("credentials_missing", "Canlı mod için önce erişim bilgisi ve ortam (sandbox/production) kaydedilmeli");
      }
      const before = { mode: cur.mode, note: cur.note };
      await db.query(`update einvoice_connectors set mode = $2, note = $3, updated_by = $4, updated_at = now() where id = $1`, [id, input.mode, input.note ?? null, actor.userId]);
      await recordEvent(db, actor, { entityType: "einvoice_connector", entityId: id, eventType: "updated", before, after: { mode: input.mode, note: input.note }, reason: input.reason });
      return { id, mode: input.mode, note: input.note ?? null };
    });
  });

  /** Entegratör erişim bilgisini şifreli kaydeder. Yanıt ve olay kaydı yalnız alan ADLARINI içerir, değerleri asla. */
  app.post("/api/einvoice-connectors/:id/credentials", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(credentialsSchema, req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const cur = (await db.query(`select key, environment, credentials_enc is not null as "hasCredentials" from einvoice_connectors where id = $1 for update`, [id])).rows[0];
      if (!cur) throw notFound("Bağlayıcı");
      const missing = EINVOICE_PROVIDERS[cur.key]?.credentialFields.filter((f) => !input.credentials[f]) ?? [];
      if (missing.length) throw badRequest(`Eksik erişim bilgisi alanları: ${missing.join(", ")}`, { missing });
      await db.query(
        `update einvoice_connectors set environment = $2, credentials_enc = $3, credentials_updated_by = $4, credentials_updated_at = now() where id = $1`,
        [id, input.environment, encryptSecret(input.credentials), actor.userId],
      );
      const fields = Object.keys(input.credentials).sort();
      await recordEvent(db, actor, {
        entityType: "einvoice_connector", entityId: id, eventType: "credentials.updated",
        before: { environment: cur.environment, hasCredentials: cur.hasCredentials }, after: { environment: input.environment, fields }, reason: input.reason,
      });
      return { id, environment: input.environment, hasCredentials: true, fields };
    });
  });

  /** Sağlayıcıdan bağımsız e-belge hazırlık denetimi: eksik vergi kimliği / adres / satır listesi. */
  app.get("/api/customer-invoices/:id/einvoice-readiness", async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ kind: kindSchema.default("e_fatura") }), req.query);
    return tenant(req, "receivable.view", async (db) => {
      const r = await einvoiceReadiness(db, id, q.kind);
      if (r.issues.some((i) => i.field === "invoice")) throw notFound("Müşteri faturası");
      return { id, kind: q.kind, ready: r.issues.length === 0, issues: r.issues };
    });
  });

  /**
   * Canlı gönderim: hazırlık denetimi zorunlu; adaptör sağlayıcıya gönderir, dönen GERÇEK ETTN kaydedilir.
   * Not: çağrı fatura satırı kilitliyken yapılır (çift gönderimi engeller); yüksek hacimde outbox'a taşınmalı.
   */
  async function sendLive(
    db: Db,
    actor: Actor & { userId: string },
    id: string,
    code: string,
    input: { connectorId: string; kind: "e_fatura" | "e_arsiv" },
    c: { key: string; name: string; environment: EinvoiceEnvironment; credentials_enc: string },
  ) {
    const provider = EINVOICE_PROVIDERS[c.key];
    if (!provider) throw conflict("adapter_not_available", `${c.name} için gerçek bağlantı geliştirilmedi`);
    const ready = await einvoiceReadiness(db, id, input.kind);
    if (!ready.doc) throw conflict("einvoice_not_ready", "E-belge ön koşulları eksik", { issues: ready.issues });
    const res = await provider.send(ready.doc, decryptSecret<Record<string, string>>(c.credentials_enc), c.environment);
    await db.query(
      `update customer_invoices set document_mode = 'live', einvoice_connector_id = $2, einvoice_kind = $3, einvoice_ettn = $4, einvoice_sent_by = $5, einvoice_sent_at = now() where id = $1`,
      [id, input.connectorId, input.kind, res.ettn, actor.userId],
    );
    await db.query(`insert into document_dispatches (company_id, kind, connector_id, entity_type, entity_id, ref, dispatched_by) values (app_company_id(), 'einvoice', $1, 'customer_invoice', $2, $3, $4)`, [input.connectorId, id, res.ettn, actor.userId]);
    await recordEvent(db, actor, { entityType: "customer_invoice", entityId: id, eventType: "einvoice.sent", after: { connector: c.name, kind: input.kind, ettn: res.ettn, providerRef: res.providerRef ?? null, environment: c.environment } });
    return { id, code, documentMode: "live", einvoiceKind: input.kind, einvoiceEttn: res.ettn, connector: c.name, environment: c.environment, testData: false };
  }

  /** Kesilmiş müşteri faturası için sentetik e-belge (TEST — GİB'e iletilmez). Bir kez gönderilir. */
  app.post("/api/customer-invoices/:id/send-einvoice", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ connectorId: z.string().uuid(), kind: kindSchema }), req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const inv = (await db.query(`select status, code, einvoice_sent_at from customer_invoices where id = $1 for update`, [id])).rows[0];
      if (!inv) throw notFound("Müşteri faturası");
      if (inv.status !== "issued") throw conflict("not_issued", "Yalnız kesilmiş fatura e-belge olarak gönderilir");
      if (inv.einvoice_sent_at) throw conflict("already_sent", "Bu fatura için e-belge zaten gönderildi");
      const c = (await db.query(`select key, name, mode, environment, credentials_enc from einvoice_connectors where id = $1`, [input.connectorId])).rows[0];
      if (!c) throw notFound("Bağlayıcı");
      if (c.mode === "live") return sendLive(db, actor, id, inv.code, input, c);
      if (c.mode !== "test") throw conflict("connector_not_ready", `${c.name} bağlı değil (sağlayıcı seçimi bekleniyor); yalnız TEST modunda gönderim yapılabilir`);
      const ettn = syntheticEttn();
      await db.query(
        `update customer_invoices set document_mode = 'test', einvoice_connector_id = $2, einvoice_kind = $3, einvoice_ettn = $4, einvoice_sent_by = $5, einvoice_sent_at = now() where id = $1`,
        [id, input.connectorId, input.kind, ettn, actor.userId],
      );
      await db.query(`insert into document_dispatches (company_id, kind, connector_id, entity_type, entity_id, ref, dispatched_by) values (app_company_id(), 'einvoice', $1, 'customer_invoice', $2, $3, $4)`, [input.connectorId, id, ettn, actor.userId]);
      await recordEvent(db, actor, { entityType: "customer_invoice", entityId: id, eventType: "einvoice.sent", after: { connector: c.name, kind: input.kind, ettn, note: "TEST — resmi değil, GİB'e iletilmedi" } });
      return { id, code: inv.code, documentMode: "test", einvoiceKind: input.kind, einvoiceEttn: ettn, connector: c.name, testData: true };
    });
  });

  // ---- kargo bağlayıcıları ----
  app.get("/api/cargo-connectors", async (req) =>
    tenant(req, "shipment.view", async (db) => {
      await ensureEinvoiceCargoConnectors(db);
      return (await db.query(`select id, key, name, mode, note, updated_at as "updatedAt" from cargo_connectors order by key`)).rows;
    }),
  );

  app.post("/api/cargo-connectors/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(modeSchema, req.body);
    return tenant(req, "shipment.create", async (db, actor) => {
      const before = (await db.query(`select mode, note from cargo_connectors where id = $1 for update`, [id])).rows[0];
      if (!before) throw notFound("Bağlayıcı");
      await db.query(`update cargo_connectors set mode = $2, note = $3, updated_by = $4, updated_at = now() where id = $1`, [id, input.mode, input.note ?? null, actor.userId]);
      await recordEvent(db, actor, { entityType: "cargo_connector", entityId: id, eventType: "updated", before, after: { mode: input.mode, note: input.note }, reason: input.reason });
      return { id, mode: input.mode, note: input.note ?? null };
    });
  });

  /** Paketlenmiş sevkiyat için sentetik kargo etiketi/takip no (TEST — kargo firmasına iletilmez). "Sevk et" bunu taşıyıcı olarak kullanır. */
  app.post("/api/shipments/:id/cargo-label", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ connectorId: z.string().uuid() }), req.body);
    return tenant(req, "shipment.create", async (db, actor) => {
      const s = (await db.query(`select status, code, carrier, tracking_no as "trackingNo" from shipments where id = $1 for update`, [id])).rows[0];
      if (!s) throw notFound("Sevkiyat");
      if (!["preparing", "packed"].includes(s.status)) throw conflict("invalid_transition", "Etiket yalnız sevk edilmeden önce üretilir");
      if (s.trackingNo) throw conflict("already_labeled", "Bu sevkiyat için zaten takip no var");
      const c = (await db.query(`select key, name, mode from cargo_connectors where id = $1`, [input.connectorId])).rows[0];
      if (!c) throw notFound("Bağlayıcı");
      if (c.mode !== "test") throw conflict("connector_not_ready", `${c.name} bağlı değil (sağlayıcı seçimi bekleniyor); yalnız TEST modunda etiket üretilebilir`);
      const trackingNo = syntheticTrackingNo(c.key, s.code);
      const labelRef = `${c.key.toUpperCase()}-${trackingNo}`;
      await db.query(`update shipments set cargo_connector_id = $2, carrier = $3, tracking_no = $4, label_ref = $5 where id = $1`, [id, input.connectorId, c.name, trackingNo, labelRef]);
      await db.query(`insert into document_dispatches (company_id, kind, connector_id, entity_type, entity_id, ref, dispatched_by) values (app_company_id(), 'cargo_label', $1, 'shipment', $2, $3, $4)`, [input.connectorId, id, labelRef, actor.userId]);
      await recordEvent(db, actor, { entityType: "shipment", entityId: id, eventType: "cargo_label.created", after: { connector: c.name, trackingNo, labelRef, note: "TEST — kargo firmasına iletilmedi" } });
      return { id, carrier: c.name, trackingNo, labelRef, testData: true };
    });
  });
}
