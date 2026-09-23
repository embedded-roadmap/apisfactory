import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { USABLE_LOCATION_TYPES } from "@apisfactory/shared";
import type { Db } from "../db/pool";
import { conflict, forbidden, notFound } from "../lib/errors";
import { openTask, closeTasks, recordEvent } from "../lib/records";
import { can, ctxOf, parse, tenant } from "../http/context";

/**
 * W29 — Onaylı alternatif parça.
 *  - Öneri: Ar-Ge (product.create) veya satın alma (supplier.manage); gerekçe zorunlu, kanıt: pin uyumu, footprint, elektriksel eşdeğerlik.
 *  - Aday bulma: KURAL TABANLI (ad/değer/kılıf belirteçleri örtüşmesi) — yapay zekâ değildir; aday yalnızca öneri, onaysız kullanılamaz.
 *  - Onay: Ar-Ge ve üretim ayrı ayrı; öneren kendi önerisini onaylayamaz; kanıt eksikse onay notu (≥ 20 karakter) zorunlu.
 *  - Onaylı alternatif, iş emrinde birincil parça yerine çıkılabilir (ürün kapsamı dahil); geri alınınca yeni çıkış engellenir.
 */

const AREA_PERM = { rd: "product.approve.rd", production: "product.approve.production" } as const;

const tokens = (s: string) =>
  new Set(
    s.toLowerCase().replace(/µ/g, "u").replace(/[(),;/]/g, " ").split(/\s+/)
      .filter((t) => t.length >= 2 && !["demo", "ve", "the", "and"].includes(t)),
  );

export async function loadAlternate(db: Db, id: string) {
  const r = await db.query(
    `select a.id, a.status, a.origin, a.reason, a.pin_compatible as "pinCompatible", a.footprint_same as "footprintSame", a.electrical_equivalent as "electricalEquivalent",
            a.evidence, a.proposed_at as "proposedAt", pu.name as "proposedBy", a.proposed_by as "proposedById", a.decided_at as "decidedAt", a.revoked_at as "revokedAt", a.revoke_reason as "revokeReason",
            a.item_id as "itemId", i.code as "itemCode", i.mpn as "itemMpn", i.name as "itemName",
            a.alternate_item_id as "alternateItemId", x.code as "alternateCode", x.mpn as "alternateMpn", x.name as "alternateName", x.manufacturer as "alternateManufacturer",
            a.product_id as "productId", p.code as "productCode",
            coalesce((select json_agg(json_build_object('area', ap.area, 'decision', ap.decision, 'note', ap.note, 'by', u.name, 'at', ap.decided_at) order by ap.decided_at)
                        from alternate_approvals ap join users u on u.id = ap.decided_by where ap.alternate_id = a.id), '[]') as approvals,
            (select count(*) from material_issues mi where mi.alternate_id = a.id)::int as "usedIssues"
       from item_alternates a join items i on i.id = a.item_id join items x on x.id = a.alternate_item_id
       left join products p on p.id = a.product_id left join users pu on pu.id = a.proposed_by
      where a.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw notFound("Alternatif");
  const a = r.rows[0];
  const done = new Set((a.approvals as { area: string; decision: string }[]).filter((x) => x.decision === "approve").map((x) => x.area));
  return { ...a, missingApprovals: a.status === "proposed" ? (["rd", "production"] as const).filter((x) => !done.has(x)) : [] };
}

/** İş emrinde birincil kalem yerine kullanılabilecek onaylı alternatif (ürün kapsamı veya genel). */
export async function approvedAlternate(db: Db, primaryItemId: string, alternateItemId: string, productId: string) {
  const r = await db.query(
    `select id from item_alternates where item_id = $1 and alternate_item_id = $2 and status = 'approved' and (product_id is null or product_id = $3)
      order by (product_id is not null) desc limit 1`,
    [primaryItemId, alternateItemId, productId],
  );
  return (r.rows[0]?.id as string | undefined) ?? null;
}

async function stockOf(db: Db, itemId: string) {
  const r = await db.query(
    `select coalesce((select sum(b.qty) from stock_balances b join locations l on l.id = b.location_id where b.item_id = $1 and l.type = any($2)), 0)::float8 as stock,
            coalesce((select sum(qty) from reservations where item_id = $1 and status = 'active'), 0)::float8 as reserved`,
    [itemId, USABLE_LOCATION_TYPES],
  );
  return Math.max(0, r.rows[0].stock - r.rows[0].reserved);
}

export async function alternateRoutes(app: FastifyInstance) {
  app.get("/api/alternates", async (req) => {
    const q = z.object({ status: z.enum(["proposed", "approved", "rejected", "revoked"]).optional(), itemId: z.string().uuid().optional() }).parse(req.query);
    return tenant(req, "bom.view", async (db) => {
      const ids = await db.query(
        `select id from item_alternates where ($1::text is null or status = $1) and ($2::uuid is null or item_id = $2 or alternate_item_id = $2)
          order by (status = 'proposed') desc, proposed_at desc limit 200`,
        [q.status ?? null, q.itemId ?? null],
      );
      const out = [];
      for (const r of ids.rows) {
        const a = await loadAlternate(db, r.id);
        out.push({ ...a, alternateFreeStock: await stockOf(db, a.alternateItemId) });
      }
      return out;
    });
  });

  app.get("/api/alternates/:id", async (req) => tenant(req, "bom.view", (db) => loadAlternate(db, (req.params as { id: string }).id)));

  /** Kural tabanlı aday bulma (yapay zekâ değil): aynı türde, ad/değer/kılıf belirteçleri örtüşen kalemler. */
  app.get("/api/items/:id/alternate-candidates", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "bom.view", async (db) => {
      const it = (await db.query(`select id, code, name, kind, mpn, manufacturer from items where id = $1`, [id])).rows[0];
      if (!it) throw notFound("Kalem");
      const base = tokens(`${it.name}`);
      const others = (await db.query(`select id, code, name, mpn, manufacturer, lifecycle from items where kind = $1 and id <> $2 limit 2000`, [it.kind, id])).rows;
      const existing = new Set((await db.query(`select alternate_item_id from item_alternates where item_id = $1 and status in ('proposed', 'approved')`, [id])).rows.map((r) => r.alternate_item_id));
      const scored = others
        .map((o) => {
          const t = tokens(`${o.name}`);
          const shared = [...base].filter((x) => t.has(x));
          return { ...o, shared, score: base.size ? Math.round((shared.length / base.size) * 100) : 0 };
        })
        .filter((o) => o.score >= 50 && !existing.has(o.id))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      const out = [];
      for (const s of scored) out.push({ itemId: s.id, code: s.code, name: s.name, mpn: s.mpn, manufacturer: s.manufacturer, lifecycle: s.lifecycle, score: s.score, matched: s.shared, freeStock: await stockOf(db, s.id) });
      return { item: it, method: "Kural tabanlı eşleşme (ad/değer/kılıf belirteçleri) — yapay zekâ değildir; teknik doğrulama ve onay gerekir.", candidates: out };
    });
  });

  app.post("/api/alternates", async (req) => {
    const input = parse(
      z.object({
        itemId: z.string().uuid(), alternateItemId: z.string().uuid(), productId: z.string().uuid().optional(),
        reason: z.string().min(10).max(1000), origin: z.enum(["manual", "rule_candidate"]).default("manual"),
        pinCompatible: z.boolean().optional(), footprintSame: z.boolean().optional(), electricalEquivalent: z.boolean().optional(), evidence: z.string().max(4000).optional(),
      }),
      req.body,
    );
    if (!can(req, "product.create") && !can(req, "supplier.manage")) throw forbidden("product.create");
    return tenant(req, null, async (db, actor) => {
      if (input.itemId === input.alternateItemId) throw conflict("same_item", "Parça kendisinin alternatifi olamaz");
      const its = (await db.query(`select id, kind from items where id = any($1)`, [[input.itemId, input.alternateItemId]])).rows;
      if (its.length !== 2) throw notFound("Kalem");
      if (its[0].kind !== its[1].kind) throw conflict("kind_mismatch", "Alternatif aynı türde kalem olmalı");
      const r = await db.query(
        `insert into item_alternates (company_id, item_id, alternate_item_id, product_id, origin, reason, pin_compatible, footprint_same, electrical_equivalent, evidence, proposed_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [input.itemId, input.alternateItemId, input.productId ?? null, input.origin, input.reason, input.pinCompatible ?? null, input.footprintSame ?? null, input.electricalEquivalent ?? null, input.evidence ?? null, actor.userId],
      ).catch((e) => { if (e.code === "23505") throw conflict("alternate_exists", "Bu alternatif için açık öneri veya onay zaten var"); throw e; });
      const id = r.rows[0].id as string;
      for (const area of ["rd", "production"] as const) {
        await openTask(db, actor.companyId, { kind: "alternate_approval", title: `Alternatif parça onayı (${area === "rd" ? "Ar-Ge" : "üretim"})`, entityType: "item_alternate", entityId: id, assigneeRole: area });
      }
      await recordEvent(db, actor, { entityType: "item_alternate", entityId: id, eventType: "proposed", after: input, reason: input.reason });
      return loadAlternate(db, id);
    });
  });

  app.post("/api/alternates/:id/decision", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ area: z.enum(["rd", "production"]), decision: z.enum(["approve", "reject"]), note: z.string().max(2000).optional() }), req.body);
    if (!can(req, AREA_PERM[input.area])) throw forbidden(AREA_PERM[input.area]);
    const c = ctxOf(req);
    return tenant(req, null, async (db, actor) => {
      const a = (await db.query(`select * from item_alternates where id = $1 for update`, [id])).rows[0];
      if (!a) throw notFound("Alternatif");
      if (a.status !== "proposed") throw conflict("invalid_transition", "Yalnızca önerilmiş alternatif için karar verilir");
      if (a.proposed_by === c.userId) throw conflict("self_approval", "Öneriyi yapan kişi teknik onay veremez");
      const note = input.note?.trim() ?? "";
      if (input.decision === "reject" && note.length < 3) throw conflict("reason_required", "Ret gerekçesi zorunlu");
      const evidenceComplete = a.pin_compatible && a.footprint_same && a.electrical_equivalent;
      if (input.decision === "approve" && !evidenceComplete && note.length < 20) {
        throw conflict("evidence_incomplete", "Kanıt eksik (pin / footprint / elektriksel eşdeğerlik); onay için en az 20 karakterlik teknik değerlendirme notu gerekli");
      }
      await db.query(`insert into alternate_approvals (company_id, alternate_id, area, decision, note, decided_by) values (app_company_id(), $1, $2, $3, $4, $5)`, [id, input.area, input.decision, note || null, actor.userId])
        .catch((e) => { if (e.code === "23505") throw conflict("already_decided", "Bu birim kararını verdi"); throw e; });
      await closeTasks(db, actor.companyId, "alternate_approval", id, input.area);
      let status = "proposed";
      if (input.decision === "reject") {
        status = "rejected";
        await closeTasks(db, actor.companyId, "alternate_approval", id);
      } else {
        const n = (await db.query(`select count(*)::int as n from alternate_approvals where alternate_id = $1 and decision = 'approve'`, [id])).rows[0].n;
        if (n === 2) status = "approved";
      }
      if (status !== "proposed") await db.query(`update item_alternates set status = $2, decided_at = now() where id = $1`, [id, status]);
      await recordEvent(db, actor, { entityType: "item_alternate", entityId: id, eventType: `decision.${input.area}.${input.decision}`, after: { status }, reason: note || undefined });
      return loadAlternate(db, id);
    });
  });

  /** Geri alma: yeni çıkışlar engellenir; daha önce yapılmış çıkışlar kayıtta kalır. */
  app.post("/api/alternates/:id/revoke", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(5).max(1000) }), req.body);
    if (!can(req, "product.approve.rd") && !can(req, "product.approve.production") && !can(req, "product.approve.quality")) throw forbidden("product.approve.rd");
    return tenant(req, null, async (db, actor) => {
      const a = (await db.query(`select status from item_alternates where id = $1 for update`, [id])).rows[0];
      if (!a) throw notFound("Alternatif");
      if (!["approved", "proposed"].includes(a.status)) throw conflict("invalid_transition", "Yalnızca açık veya onaylı alternatif geri alınır");
      await db.query(`update item_alternates set status = 'revoked', revoked_by = $2, revoked_at = now(), revoke_reason = $3 where id = $1`, [id, actor.userId, input.reason]);
      await closeTasks(db, actor.companyId, "alternate_approval", id);
      await recordEvent(db, actor, { entityType: "item_alternate", entityId: id, eventType: "revoked", reason: input.reason });
      return loadAlternate(db, id);
    });
  });
}
