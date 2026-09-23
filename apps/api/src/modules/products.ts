import type { FastifyInstance } from "fastify";
import {
  CreateItemInput,
  CreateProductInput,
  CreateRevisionInput,
  HANDOVER_AREAS,
  HandoverDecisionInput,
  REVISION_TRANSITIONS,
  canTransition,
  type HandoverArea,
  type RevisionDetail,
  type RevisionState,
} from "@apisfactory/shared";
import { z } from "zod";
import type { Db } from "../db/pool";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { RuleRejection, withRejectionLog } from "../lib/rejection";
import { handoverReadiness } from "../lib/handover";
import { closeTasks, openTask, recordEvent, type Actor } from "../lib/records";
import { can, parse, tenant } from "../http/context";

const AREA_ROLE: Record<HandoverArea, string> = { rd: "rd", production: "production", quality: "quality" };
const AREA_PERMISSION = { rd: "product.approve.rd", production: "product.approve.production", quality: "product.approve.quality" } as const;

export async function loadRevision(db: Db, id: string): Promise<RevisionDetail> {
  const r = await db.query(
    `select pr.id, pr.product_id as "productId", pr.rev, pr.status, pr.bom_version_id as "bomVersionId",
            pr.released_at as "releasedAt", pr.firmware_version as "firmwareVersion", pr.firmware_sha256 as "firmwareSha256",
            coalesce(h.current_round, 0) as round, pr.handover_checklist as "handoverChecklist"
       from product_revisions pr left join handover_rounds h on h.revision_id = pr.id
      where pr.id = $1`,
    [id],
  );
  const rev = r.rows[0];
  if (!rev) throw notFound("Revizyon");
  const a = await db.query(
    `select a.area, a.decision, u.name as by, a.decided_at as at, a.note
       from handover_approvals a join users u on u.id = a.decided_by
      where a.revision_id = $1 and a.round = $2 order by a.decided_at`,
    [id, rev.round],
  );
  const approved = new Set(a.rows.filter((x) => x.decision === "approve").map((x) => x.area));
  const { round: _round, ...rest } = rev;
  return {
    ...rest,
    readiness: await handoverReadiness(db, id),
    handoverChecklist: rev.handoverChecklist ?? null,
    approvals: a.rows,
    missingApprovals: rev.status === "handover_review" ? HANDOVER_AREAS.filter((x) => !approved.has(x)) : [],
  };
}

async function setRevisionStatus(db: Db, actor: Actor, id: string, from: RevisionState, to: RevisionState, reason?: string) {
  await db.query(`update product_revisions set status = $2, released_at = case when $2 = 'released' then now() else released_at end where id = $1`, [id, to]);
  await recordEvent(db, actor, { entityType: "product_revision", entityId: id, eventType: `status.${to}`, before: { status: from }, after: { status: to }, reason });
}

export async function productRoutes(app: FastifyInstance) {
  app.get("/api/items", async (req) => {
    const q = z.object({ q: z.string().optional(), kind: z.string().optional() }).parse(req.query);
    return tenant(req, "product.view", async (db) => {
      const r = await db.query(
        `select id, code, name, kind, manufacturer, mpn, unit,
                msl_level as "mslLevel", floor_life_hours as "floorLifeHours", shelf_life_days as "shelfLifeDays",
                storage_condition as "storageCondition", issue_policy as "issuePolicy"
           from items
          where ($1::text is null or code ilike '%'||$1||'%' or name ilike '%'||$1||'%' or mpn ilike '%'||$1||'%')
            and ($2::text is null or kind = $2)
          order by code limit 200`,
        [q.q ?? null, q.kind ?? null],
      );
      return r.rows;
    });
  });

  app.post("/api/items", async (req) => {
    const input = parse(CreateItemInput, req.body);
    return tenant(req, "product.create", async (db, actor) => {
      const r = await db.query(
        `insert into items (company_id, code, name, kind, manufacturer, mpn, unit) values (app_company_id(),$1,$2,$3,$4,$5,$6)
         returning id, code, name, kind, manufacturer, mpn, unit`,
        [input.code, input.name, input.kind, input.manufacturer ?? null, input.mpn ?? null, input.unit],
      );
      await recordEvent(db, actor, { entityType: "item", entityId: r.rows[0].id, eventType: "created", after: r.rows[0] });
      return r.rows[0];
    });
  });

  app.get("/api/products", async (req) =>
    tenant(req, "product.view", async (db) => {
      const r = await db.query(
        `select p.id, p.code, p.name, p.item_id as "itemId",
                coalesce(json_agg(json_build_object('id', pr.id, 'rev', pr.rev, 'status', pr.status, 'bomVersionId', pr.bom_version_id) order by pr.created_at)
                  filter (where pr.id is not null), '[]') as revisions
           from products p left join product_revisions pr on pr.product_id = p.id
          group by p.id order by p.code`,
      );
      return r.rows;
    }),
  );

  app.post("/api/products", async (req) => {
    const input = parse(CreateProductInput, req.body);
    return tenant(req, "product.create", async (db, actor) => {
      const item = await db.query(
        `insert into items (company_id, code, name, kind) values (app_company_id(), $1, $2, 'product') returning id`,
        [input.code, input.name],
      );
      const p = await db.query(
        `insert into products (company_id, code, name, item_id) values (app_company_id(), $1, $2, $3)
         returning id, code, name, item_id as "itemId"`,
        [input.code, input.name, item.rows[0].id],
      );
      await recordEvent(db, actor, { entityType: "product", entityId: p.rows[0].id, eventType: "created", after: p.rows[0] });
      return { ...p.rows[0], revisions: [] };
    });
  });

  app.get("/api/products/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "product.view", async (db) => {
      const p = await db.query(`select id, code, name, item_id as "itemId" from products where id = $1`, [id]);
      if (!p.rows[0]) throw notFound("Ürün");
      const revs = await db.query(`select id from product_revisions where product_id = $1 order by created_at`, [id]);
      const boms = await db.query(
        `select b.id, b.version_no as "versionNo", b.status, b.created_at as "createdAt", b.published_at as "publishedAt",
                (select count(*) from bom_lines l where l.bom_version_id = b.id)::int as "lineCount"
           from bom_versions b where b.product_id = $1 order by b.version_no`,
        [id],
      );
      const revisions = [];
      for (const r of revs.rows) revisions.push(await loadRevision(db, r.id));
      return { ...p.rows[0], revisions, boms: boms.rows };
    });
  });

  app.post("/api/products/:id/revisions", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(CreateRevisionInput, req.body);
    return tenant(req, "product.create", async (db, actor) => {
      if (input.bomVersionId) await assertBomUsable(db, id, input.bomVersionId);
      const r = await db.query(
        `insert into product_revisions (company_id, product_id, rev, status, bom_version_id)
         values (app_company_id(), $1, $2, 'development', $3) returning id`,
        [id, input.rev, input.bomVersionId ?? null],
      );
      await db.query(`insert into handover_rounds (company_id, revision_id) values (app_company_id(), $1)`, [r.rows[0].id]);
      await recordEvent(db, actor, { entityType: "product_revision", entityId: r.rows[0].id, eventType: "created", after: { rev: input.rev, productId: id } });
      return loadRevision(db, r.rows[0].id);
    });
  });

  app.get("/api/revisions/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "product.view", (db) => loadRevision(db, id));
  });

  app.post("/api/revisions/:id/bom", async (req) => {
    const { id } = req.params as { id: string };
    const { bomVersionId } = parse(z.object({ bomVersionId: z.string().uuid() }), req.body);
    return tenant(req, "product.create", async (db, actor) => {
      const rev = await lockRevision(db, id);
      if (!["draft", "development", "pilot", "rejected"].includes(rev.status)) {
        throw conflict("revision_locked", "Devir incelemesindeki veya yayımlanmış revizyonun BOM'u değiştirilemez; yeni revizyon açın");
      }
      await assertBomUsable(db, rev.product_id, bomVersionId);
      await db.query(`update product_revisions set bom_version_id = $2 where id = $1`, [id, bomVersionId]);
      await recordEvent(db, actor, { entityType: "product_revision", entityId: id, eventType: "bom.linked", before: { bomVersionId: rev.bom_version_id }, after: { bomVersionId } });
      return loadRevision(db, id);
    });
  });

  app.post("/api/revisions/:id/transition", async (req) => {
    const { id } = req.params as { id: string };
    const { action } = parse(z.object({ action: z.enum(["start_development", "start_pilot", "submit_handover"]) }), req.body);
    return withRejectionLog(req, () => tenant(req, "product.create", async (db, actor) => {
      const rev = await lockRevision(db, id);
      const t = REVISION_TRANSITIONS[action];
      if (!canTransition(t, rev.status as RevisionState)) {
        throw conflict("invalid_transition", `"${rev.status}" durumundan "${t.to}" durumuna geçilemez`);
      }
      if (action === "submit_handover") {
        if (!rev.bom_version_id) throw conflict("handover_incomplete", "Devir için yayımlanmış bir BOM sürümü bağlanmalı");
        const b = await db.query(`select status from bom_versions where id = $1`, [rev.bom_version_id]);
        if (b.rows[0]?.status !== "published") throw conflict("handover_incomplete", "Bağlı BOM sürümü yayımlanmamış");
        await assertHandoverReady(db, id);
        await db.query(`update handover_rounds set current_round = current_round + 1 where revision_id = $1`, [id]);
        for (const area of HANDOVER_AREAS) {
          await openTask(db, actor.companyId, {
            kind: "handover_approval",
            title: `Devir onayı (${area}) — ${rev.product_code} Rev.${rev.rev}`,
            entityType: "product_revision",
            entityId: id,
            assigneeRole: AREA_ROLE[area],
          });
        }
      }
      await setRevisionStatus(db, actor, id, rev.status, t.to);
      return loadRevision(db, id);
    }));
  });

  /** Devir kararı: her birim kendi izniyle karar verir. Üç onay tamamlanınca revizyon yayımlanır (prompt §8). */
  app.post("/api/revisions/:id/handover", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(HandoverDecisionInput, req.body);
    if (!can(req, AREA_PERMISSION[input.area])) throw forbidden(AREA_PERMISSION[input.area]);
    return withRejectionLog(req, () => tenant(req, null, async (db, actor) => {
      const rev = await lockRevision(db, id);
      if (rev.status !== "handover_review") throw conflict("invalid_transition", "Revizyon devir incelemesinde değil");
      const round = (await db.query(`select current_round from handover_rounds where revision_id = $1`, [id])).rows[0].current_round;
      if (input.decision === "reject" && !input.note) throw conflict("reason_required", "Ret gerekçesi zorunlu");
      if (input.decision === "approve") {
        // Son onay yayımı tetikler: politika inceleme sırasında sıkılaştırılmış olabilir, yayım öncesi yeniden kontrol edilir.
        const others = await db.query(
          `select count(distinct area)::int as n from handover_approvals where revision_id = $1 and round = $2 and decision = 'approve' and area <> $3`,
          [id, round, input.area],
        );
        if (others.rows[0].n === HANDOVER_AREAS.length - 1) await assertHandoverReady(db, id);
      }
      await db.query(
        `insert into handover_approvals (company_id, revision_id, round, area, decision, decided_by, note)
         values (app_company_id(), $1, $2, $3, $4, $5, $6)`,
        [id, round, input.area, input.decision, actor.userId, input.note ?? null],
      );
      await recordEvent(db, actor, { entityType: "product_revision", entityId: id, eventType: `handover.${input.decision}`, after: { area: input.area, round }, reason: input.note });
      await closeTasks(db, actor.companyId, "handover_approval", id, AREA_ROLE[input.area]);

      if (input.decision === "reject") {
        await closeTasks(db, actor.companyId, "handover_approval", id);
        await setRevisionStatus(db, actor, id, rev.status, "rejected", input.note);
        await openTask(db, actor.companyId, {
          kind: "handover_fix",
          title: `Devir reddedildi, düzeltme gerekli — ${rev.product_code} Rev.${rev.rev}`,
          entityType: "product_revision",
          entityId: id,
          assigneeRole: "rd",
        });
      } else {
        const approved = await db.query(
          `select count(distinct area)::int as n from handover_approvals where revision_id = $1 and round = $2 and decision = 'approve'`,
          [id, round],
        );
        if (approved.rows[0].n === HANDOVER_AREAS.length) {
          const checklist = await handoverReadiness(db, id);
          await db.query(`update product_revisions set handover_checklist = $2 where id = $1`, [id, JSON.stringify({ ...checklist, round, at: new Date().toISOString() })]);
          await setRevisionStatus(db, { ...actor, kind: "automation" }, id, rev.status, "released", "Ar-Ge, üretim ve kalite devir onayları tamamlandı");
        }
      }
      return loadRevision(db, id);
    }));
  });
}

/** Devir politikası kontrolü: eksik zorunlu madde (muafiyetsiz) varsa reddedilir; ret olay defterine yazılır. */
async function assertHandoverReady(db: Db, id: string) {
  const r = await handoverReadiness(db, id);
  if (r && !r.ready) {
    const labels = r.items.filter((i) => r.missing.includes(i.key)).map((i) => i.label);
    throw new RuleRejection(
      new AppError(409, "handover_requirements", `Devir politikası (v${r.policyVersion}) karşılanmadı: ${labels.join(", ")}`, { missing: r.missing, policyVersion: r.policyVersion }),
      { entityType: "product_revision", entityId: id, eventType: "handover.blocked", after: { missing: r.missing, policyVersion: r.policyVersion } },
    );
  }
}

async function lockRevision(db: Db, id: string) {
  const r = await db.query(
    `select pr.*, p.code as product_code from product_revisions pr join products p on p.id = pr.product_id where pr.id = $1 for update of pr`,
    [id],
  );
  if (!r.rows[0]) throw notFound("Revizyon");
  return r.rows[0] as { id: string; status: RevisionState; product_id: string; bom_version_id: string | null; rev: string; product_code: string };
}

async function assertBomUsable(db: Db, productId: string, bomVersionId: string) {
  const b = await db.query(`select product_id, status from bom_versions where id = $1`, [bomVersionId]);
  if (!b.rows[0]) throw notFound("BOM sürümü");
  if (b.rows[0].product_id !== productId) throw conflict("bom_mismatch", "BOM sürümü bu ürüne ait değil");
}
