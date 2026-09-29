import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { recordEvent, type Actor } from "../lib/records";
import { decryptSecret } from "../lib/secrets";
import { assertLiveAllowed, credentialsSchema, saveConnectorCredentials } from "../lib/connector-credentials";
import { EINVOICE_PROVIDERS, einvoiceReadiness, type EinvoiceEnvironment } from "../lib/einvoice-providers";
import { CARGO_PROVIDERS, cargoReadiness, type CargoEnvironment } from "../lib/cargo-providers";
import { newObjectKey, objectStorage } from "../lib/storage";
import { buildUblTr } from "../lib/ubl-tr";
import { parse, tenant } from "../http/context";

/**
 * W36 — e-fatura/e-arşiv ve kargo bağlayıcıları.
 *  - Sağlayıcı seçimi (entegratör, kargo firması) şirketin ticari kararıdır; yaygın seçenekler taslak listelenir,
 *    varsayılan BAĞLANMADI. TEST modu sentetik ETTN/takip no üretir, hiçbir dış sisteme gönderilmez.
 *  - E-belge: kesilmiş (issued) müşteri faturası için, tür (e-Fatura / e-Arşiv) elle seçilir — mükellef sorgusu yok.
 *    Belge modu sabitlenir (yeniden gönderilemez); iptal edilen fatura yeniden faturalanır (W24 kuralı).
 *  - Kargo: paketlenmiş sevkiyat için etiket/takip no üretir; mevcut "sevk et" adımı bunu taşıyıcı olarak kullanır.
 *  - Oturum 41: CANLI mod altyapısı (her iki tür) — şirket başına şifreli erişim bilgisi (düz metin asla geri dönmez),
 *    sağlayıcıdan bağımsız hazırlık denetimi ve adaptör kayıt defterleri (EINVOICE_PROVIDERS, CARGO_PROVIDERS).
 *    'live' moda geçiş yalnız o sağlayıcının adaptörü eklenmişse ve erişim bilgisi + ortam kayıtlıysa mümkündür;
 *    şu an hiçbir adaptör yok. Kargoda firmaya özel gizli olmayan ayarlar (settings) ayrıca tutulur.
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

const modeSchema = z.object({ mode: z.enum(["not_connected", "test", "live"]), note: z.string().max(500).nullable().optional(), reason: z.string().min(3).max(500) });
const kindSchema = z.enum(["e_fatura", "e_arsiv"]);
type TenantActor = Actor & { userId: string };

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
    const input = parse(modeSchema, req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const cur = (await db.query(`select key, name, mode, note, environment, credentials_enc is not null as "hasCredentials" from einvoice_connectors where id = $1 for update`, [id])).rows[0];
      if (!cur) throw notFound("Bağlayıcı");
      if (input.mode === "live") assertLiveAllowed(cur, Boolean(EINVOICE_PROVIDERS[cur.key]));
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
    return tenant(req, "receivable.manage", (db, actor) => saveConnectorCredentials(db, actor, "einvoice", id, input, (k) => EINVOICE_PROVIDERS[k]?.credentialFields));
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
   * UBL-TR 1.2 belge önizlemesi (sağlayıcıdan bağımsız). Entegratöre gidecek XML'i ve yapısal/aritmetik denetim
   * sonuçlarını döner. Resmi GİB XSD/Schematron doğrulaması entegratör ortamında yapılır.
   */
  app.get("/api/customer-invoices/:id/ubl", async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(
      z.object({
        kind: kindSchema.default("e_fatura"),
        profile: z.enum(["TEMELFATURA", "TICARIFATURA", "EARSIVFATURA"]).optional(),
        number: z.string().max(16).optional(),
        exchangeRate: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
        exemptionCode: z.string().max(10).optional(),
        exemptionReason: z.string().max(250).optional(),
      }),
      req.query,
    );
    return tenant(req, "receivable.view", async (db) => {
      const ready = await einvoiceReadiness(db, id, q.kind);
      if (ready.issues.some((i) => i.field === "invoice")) throw notFound("Müşteri faturası");
      if (!ready.doc) throw conflict("einvoice_not_ready", "E-belge ön koşulları eksik", { issues: ready.issues });
      const inv = (await db.query(`select einvoice_ettn from customer_invoices where id = $1`, [id])).rows[0];
      const r = buildUblTr(ready.doc, {
        profile: q.profile,
        number: q.number ?? null,
        uuid: inv?.einvoice_ettn && /^[0-9a-f-]{36}$/.test(inv.einvoice_ettn) ? inv.einvoice_ettn : undefined,
        exchangeRate: q.exchangeRate ?? null,
        taxExemption: q.exemptionCode && q.exemptionReason ? { code: q.exemptionCode, reason: q.exemptionReason } : null,
      });
      return { id, profile: r.profile, uuid: r.uuid, valid: !r.issues.some((i) => i.severity === "error"), issues: r.issues, xml: r.xml };
    });
  });

  /**
   * Canlı gönderim: hazırlık denetimi zorunlu; adaptör sağlayıcıya gönderir, dönen GERÇEK ETTN kaydedilir.
   * Not: çağrı fatura satırı kilitliyken yapılır (çift gönderimi engeller); yüksek hacimde outbox'a taşınmalı.
   */
  async function sendLive(
    db: Db,
    actor: TenantActor,
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

  /** Kesilmiş müşteri faturası için e-belge: TEST'te sentetik ETTN (GİB'e iletilmez), CANLI'da adaptör. Bir kez gönderilir. */
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
      return (
        await db.query(
          `select id, key, name, mode, note, updated_at as "updatedAt", environment, settings,
                  credentials_enc is not null as "hasCredentials", credentials_updated_at as "credentialsUpdatedAt"
             from cargo_connectors order by key`,
        )
      ).rows.map((r) => {
        const p = CARGO_PROVIDERS[r.key];
        return { ...r, adapterAvailable: Boolean(p), credentialFields: p?.credentialFields ?? null, settingFields: p?.settingFields ?? null, trackingSupported: Boolean(p?.track) };
      });
    }),
  );

  app.post("/api/cargo-connectors/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(modeSchema, req.body);
    return tenant(req, "shipment.create", async (db, actor) => {
      const cur = (await db.query(`select key, name, mode, note, environment, credentials_enc is not null as "hasCredentials" from cargo_connectors where id = $1 for update`, [id])).rows[0];
      if (!cur) throw notFound("Bağlayıcı");
      if (input.mode === "live") assertLiveAllowed(cur, Boolean(CARGO_PROVIDERS[cur.key]));
      const before = { mode: cur.mode, note: cur.note };
      await db.query(`update cargo_connectors set mode = $2, note = $3, updated_by = $4, updated_at = now() where id = $1`, [id, input.mode, input.note ?? null, actor.userId]);
      await recordEvent(db, actor, { entityType: "cargo_connector", entityId: id, eventType: "updated", before, after: { mode: input.mode, note: input.note }, reason: input.reason });
      return { id, mode: input.mode, note: input.note ?? null };
    });
  });

  app.post("/api/cargo-connectors/:id/credentials", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(credentialsSchema, req.body);
    return tenant(req, "shipment.create", (db, actor) => saveConnectorCredentials(db, actor, "cargo", id, input, (k) => CARGO_PROVIDERS[k]?.credentialFields));
  });

  /** Firmaya özel, gizli olmayan ayarlar (servis tipi, ödeme tipi vb.). Adaptör varsa alanlar ona göre doğrulanır. */
  app.post("/api/cargo-connectors/:id/settings", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ settings: z.record(z.string().min(1).max(60), z.string().max(200)), reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "shipment.create", async (db, actor) => {
      const cur = (await db.query(`select key, settings from cargo_connectors where id = $1 for update`, [id])).rows[0];
      if (!cur) throw notFound("Bağlayıcı");
      const fields = CARGO_PROVIDERS[cur.key]?.settingFields;
      if (fields) {
        const known = new Set(fields.map((f) => f.key));
        const unknown = Object.keys(input.settings).filter((k) => !known.has(k));
        if (unknown.length) throw badRequest(`Bu firma için tanımsız ayar: ${unknown.join(", ")}`, { unknown });
        for (const f of fields) {
          const v = input.settings[f.key];
          if (f.required && !v) throw badRequest(`Zorunlu ayar eksik: ${f.label}`, { field: f.key });
          if (v && f.options && !f.options.includes(v)) throw badRequest(`${f.label} için geçersiz değer: ${v}`, { field: f.key, options: f.options });
        }
      }
      if (Object.keys(input.settings).length > 20) throw badRequest("En fazla 20 ayar");
      await db.query(`update cargo_connectors set settings = $2, updated_by = $3, updated_at = now() where id = $1`, [id, JSON.stringify(input.settings), actor.userId]);
      await recordEvent(db, actor, { entityType: "cargo_connector", entityId: id, eventType: "settings.updated", before: { settings: cur.settings }, after: { settings: input.settings }, reason: input.reason });
      return { id, settings: input.settings };
    });
  });

  /** Firmadan bağımsız kargo hazırlık denetimi: gönderici/alıcı adres ve telefonu, kapalı koli. */
  app.get("/api/shipments/:id/cargo-readiness", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "shipment.view", async (db) => {
      const r = await cargoReadiness(db, id);
      if (r.issues.some((i) => i.field === "shipment")) throw notFound("Sevkiyat");
      return { id, ready: r.issues.length === 0, issues: r.issues, totalWeightKg: r.req?.totalWeightKg ?? null, packages: r.req?.packages.length ?? null };
    });
  });

  /**
   * Canlı kargo kaydı: hazırlık denetimi zorunlu; adaptör firmaya gönderir, GERÇEK takip no kaydedilir, etiket dosyası
   * (varsa) nesne depolamaya yazılır. Not: çağrı sevkiyat satırı kilitliyken yapılır (çift kaydı engeller).
   */
  async function labelLive(
    db: Db,
    actor: TenantActor,
    id: string,
    connectorId: string,
    c: { key: string; name: string; environment: CargoEnvironment; credentials_enc: string; settings: Record<string, string> },
  ) {
    const provider = CARGO_PROVIDERS[c.key];
    if (!provider) throw conflict("adapter_not_available", `${c.name} için gerçek bağlantı geliştirilmedi`);
    const ready = await cargoReadiness(db, id);
    if (!ready.req) throw conflict("cargo_not_ready", "Kargo kaydı ön koşulları eksik", { issues: ready.issues });
    const res = await provider.createShipment(ready.req, { credentials: decryptSecret<Record<string, string>>(c.credentials_enc), settings: c.settings, environment: c.environment });
    let labelKey: string | null = null;
    if (res.label) {
      labelKey = newObjectKey(actor.companyId, "cargo-labels", `${ready.req.shipmentCode}.${res.label.contentType === "application/pdf" ? "pdf" : res.label.contentType === "image/png" ? "png" : "zpl"}`);
      await objectStorage().put(labelKey, res.label.data);
    }
    const labelRef = res.labelRef ?? `${c.key.toUpperCase()}-${res.trackingNo}`;
    await db.query(
      `update shipments set cargo_connector_id = $2, carrier = $3, tracking_no = $4, label_ref = $5, cargo_label_mode = 'live',
              label_object_key = $6, label_content_type = $7, cargo_status = 'created', cargo_status_at = now() where id = $1`,
      [id, connectorId, c.name, res.trackingNo, labelRef, labelKey, res.label?.contentType ?? null],
    );
    await db.query(`insert into document_dispatches (company_id, kind, connector_id, entity_type, entity_id, ref, dispatched_by) values (app_company_id(), 'cargo_label', $1, 'shipment', $2, $3, $4)`, [connectorId, id, labelRef, actor.userId]);
    await recordEvent(db, actor, { entityType: "shipment", entityId: id, eventType: "cargo_label.created", after: { connector: c.name, trackingNo: res.trackingNo, labelRef, environment: c.environment, hasLabelFile: Boolean(labelKey) } });
    return { id, carrier: c.name, trackingNo: res.trackingNo, labelRef, labelMode: "live", hasLabelFile: Boolean(labelKey), environment: c.environment, testData: false };
  }

  /** Paketlenmiş sevkiyat için kargo etiketi/takip no: TEST'te sentetik (firmaya iletilmez), CANLI'da adaptör. */
  app.post("/api/shipments/:id/cargo-label", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ connectorId: z.string().uuid() }), req.body);
    return tenant(req, "shipment.create", async (db, actor) => {
      const s = (await db.query(`select status, code, carrier, tracking_no as "trackingNo" from shipments where id = $1 for update`, [id])).rows[0];
      if (!s) throw notFound("Sevkiyat");
      if (!["preparing", "packed"].includes(s.status)) throw conflict("invalid_transition", "Etiket yalnız sevk edilmeden önce üretilir");
      if (s.trackingNo) throw conflict("already_labeled", "Bu sevkiyat için zaten takip no var");
      const c = (await db.query(`select key, name, mode, environment, credentials_enc, settings from cargo_connectors where id = $1`, [input.connectorId])).rows[0];
      if (!c) throw notFound("Bağlayıcı");
      if (c.mode === "live") return labelLive(db, actor, id, input.connectorId, c);
      if (c.mode !== "test") throw conflict("connector_not_ready", `${c.name} bağlı değil (sağlayıcı seçimi bekleniyor); yalnız TEST modunda etiket üretilebilir`);
      const trackingNo = syntheticTrackingNo(c.key, s.code);
      const labelRef = `${c.key.toUpperCase()}-${trackingNo}`;
      await db.query(`update shipments set cargo_connector_id = $2, carrier = $3, tracking_no = $4, label_ref = $5, cargo_label_mode = 'test' where id = $1`, [id, input.connectorId, c.name, trackingNo, labelRef]);
      await db.query(`insert into document_dispatches (company_id, kind, connector_id, entity_type, entity_id, ref, dispatched_by) values (app_company_id(), 'cargo_label', $1, 'shipment', $2, $3, $4)`, [input.connectorId, id, labelRef, actor.userId]);
      await recordEvent(db, actor, { entityType: "shipment", entityId: id, eventType: "cargo_label.created", after: { connector: c.name, trackingNo, labelRef, note: "TEST — kargo firmasına iletilmedi" } });
      return { id, carrier: c.name, trackingNo, labelRef, labelMode: "test", testData: true };
    });
  });

  /** Firmanın döndürdüğü etiket dosyası (PDF/ZPL/PNG) — yalnız CANLI etiketlerde ve firma dosya verdiyse. */
  app.get("/api/shipments/:id/cargo-label-file", async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await tenant(req, "shipment.view", async (db) => {
      const s = (await db.query(`select code, label_object_key, label_content_type from shipments where id = $1`, [id])).rows[0];
      if (!s) throw notFound("Sevkiyat");
      if (!s.label_object_key) throw notFound("Etiket dosyası");
      return { code: s.code as string, contentType: s.label_content_type as string, data: await objectStorage().get(s.label_object_key) };
    });
    const ext = out.contentType === "application/pdf" ? "pdf" : out.contentType === "image/png" ? "png" : "zpl";
    reply.header("content-type", out.contentType).header("content-disposition", `inline; filename="${out.code}-kargo.${ext}"`);
    return out.data;
  });

  /** Takip durumunu firmadan günceller (yalnız CANLI etiket ve firma takip sorgusunu destekliyorsa). */
  app.post("/api/shipments/:id/cargo-track", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "shipment.view", async (db, actor) => {
      const s = (
        await db.query(
          `select s.tracking_no, s.cargo_label_mode, s.cargo_status, c.key, c.name, c.environment, c.credentials_enc, c.settings
             from shipments s left join cargo_connectors c on c.id = s.cargo_connector_id where s.id = $1 for update of s`,
          [id],
        )
      ).rows[0];
      if (!s) throw notFound("Sevkiyat");
      if (s.cargo_label_mode !== "live" || !s.tracking_no) throw conflict("not_live", "Takip sorgusu yalnız canlı kargo kaydı için yapılır");
      const track = CARGO_PROVIDERS[s.key]?.track;
      if (!track) throw conflict("tracking_not_supported", `${s.name} için takip sorgusu geliştirilmedi`);
      if (!s.credentials_enc) throw conflict("credentials_missing", "Bağlayıcının erişim bilgisi silinmiş");
      const t = await track(s.tracking_no, { credentials: decryptSecret<Record<string, string>>(s.credentials_enc), settings: s.settings, environment: s.environment });
      await db.query(`update shipments set cargo_status = $2, cargo_status_raw = $3, cargo_status_at = coalesce($4::timestamptz, now()) where id = $1`, [id, t.status, t.raw, t.at]);
      if (t.status !== s.cargo_status) {
        await recordEvent(db, actor, { entityType: "shipment", entityId: id, eventType: "cargo_status.changed", before: { status: s.cargo_status }, after: { status: t.status, raw: t.raw } });
      }
      return { id, cargoStatus: t.status, cargoStatusRaw: t.raw, cargoStatusAt: t.at };
    });
  });
}
