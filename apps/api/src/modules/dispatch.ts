import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { parse, tenant } from "../http/context";

/**
 * W36 — e-fatura/e-arşiv ve kargo bağlayıcıları. GERÇEK ENTEGRASYON YOK.
 *  - Sağlayıcı seçimi (entegratör, kargo firması) şirketin ticari kararıdır; burada yaygın seçenekler taslak listelenir,
 *    varsayılan BAĞLANMADI. Yalnız TEST modu var: sentetik ETTN/takip no üretir, hiçbir dış sisteme gönderilmez.
 *  - E-belge: kesilmiş (issued) müşteri faturası için, tür (e-Fatura / e-Arşiv) elle seçilir — mükellef sorgusu yok.
 *    Belge modu "test" olur ve sabitlenir (yeniden gönderilemez); iptal edilen fatura yeniden faturalanır (W24 kuralı).
 *  - Kargo: paketlenmiş sevkiyat için sentetik etiket/takip no üretir; mevcut "sevk et" adımı bunu taşıyıcı olarak kullanır.
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

export async function dispatchRoutes(app: FastifyInstance) {
  // ---- e-fatura/e-arşiv bağlayıcıları ----
  app.get("/api/einvoice-connectors", async (req) =>
    tenant(req, "receivable.view", async (db) => {
      await ensureEinvoiceCargoConnectors(db);
      return (
        await db.query(
          `select id, key, name, mode, note, updated_at as "updatedAt" from einvoice_connectors order by key`,
        )
      ).rows;
    }),
  );

  app.post("/api/einvoice-connectors/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(modeSchema, req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const before = (await db.query(`select mode, note from einvoice_connectors where id = $1 for update`, [id])).rows[0];
      if (!before) throw notFound("Bağlayıcı");
      await db.query(`update einvoice_connectors set mode = $2, note = $3, updated_by = $4, updated_at = now() where id = $1`, [id, input.mode, input.note ?? null, actor.userId]);
      await recordEvent(db, actor, { entityType: "einvoice_connector", entityId: id, eventType: "updated", before, after: { mode: input.mode, note: input.note }, reason: input.reason });
      return { id, mode: input.mode, note: input.note ?? null };
    });
  });

  /** Kesilmiş müşteri faturası için sentetik e-belge (TEST — GİB'e iletilmez). Bir kez gönderilir. */
  app.post("/api/customer-invoices/:id/send-einvoice", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ connectorId: z.string().uuid(), kind: z.enum(["e_fatura", "e_arsiv"]) }), req.body);
    return tenant(req, "receivable.manage", async (db, actor) => {
      const inv = (await db.query(`select status, code, einvoice_sent_at from customer_invoices where id = $1 for update`, [id])).rows[0];
      if (!inv) throw notFound("Müşteri faturası");
      if (inv.status !== "issued") throw conflict("not_issued", "Yalnız kesilmiş fatura e-belge olarak gönderilir");
      if (inv.einvoice_sent_at) throw conflict("already_sent", "Bu fatura için e-belge zaten gönderildi");
      const c = (await db.query(`select key, name, mode from einvoice_connectors where id = $1`, [input.connectorId])).rows[0];
      if (!c) throw notFound("Bağlayıcı");
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
