import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conflict, notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { REQUIREMENTS, currentHandoverPolicy, handoverReadiness } from "../lib/handover";
import { parse, tenant } from "../http/context";

/**
 * Devir politikası (şirket ayarı): devre gönderme ve son devir onayında test planı, firmware (+ SHA-256)
 * ve yayımlanmış rota zorunluluğu. Sürümlü; muafiyet revizyon bazında, gerekçeli ve değişmez.
 */
export async function handoverRoutes(app: FastifyInstance) {
  app.get("/api/handover/policy", async (req) =>
    tenant(req, "task.view", async (db) => {
      const history = await db.query(
        `select p.version_no as "versionNo", p.require_test_plan as "requireTestPlan", p.require_firmware as "requireFirmware",
                p.require_firmware_sha as "requireFirmwareSha", p.require_routing as "requireRouting", p.note, p.created_at as "createdAt", u.name as "createdBy"
           from handover_policies p left join users u on u.id = p.created_by order by p.version_no desc`,
      );
      const waivers = await db.query(
        `select w.requirement, w.reason, w.created_at as "createdAt", u.name as "grantedBy", p.code as "productCode", pr.rev, pr.id as "revisionId", pr.status
           from handover_waivers w join product_revisions pr on pr.id = w.revision_id join products p on p.id = pr.product_id
           left join users u on u.id = w.granted_by order by w.created_at desc limit 100`,
      );
      return { current: await currentHandoverPolicy(db), history: history.rows, waivers: waivers.rows, defaults: "Politika yoksa yalnızca yayımlanmış BOM zorunludur." };
    }),
  );

  app.post("/api/handover/policy", async (req) => {
    const input = parse(
      z.object({
        requireTestPlan: z.boolean(), requireFirmware: z.boolean(), requireFirmwareSha: z.boolean(), requireRouting: z.boolean(),
        note: z.string().min(3).max(500),
      }),
      req.body,
    );
    return tenant(req, "workflow.manage", async (db, actor) => {
      if (input.requireFirmwareSha && !input.requireFirmware) throw conflict("invalid_policy", "SHA-256 zorunluluğu firmware zorunluluğu olmadan seçilemez");
      await db.query(`select pg_advisory_xact_lock(hashtext('handover_policy:' || app_company_id()::text))`);
      const n = (await db.query(`select coalesce(max(version_no), 0) + 1 as n from handover_policies`)).rows[0].n;
      const before = await currentHandoverPolicy(db);
      const r = await db.query(
        `insert into handover_policies (company_id, version_no, require_test_plan, require_firmware, require_firmware_sha, require_routing, note, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [n, input.requireTestPlan, input.requireFirmware, input.requireFirmwareSha, input.requireRouting, input.note, actor.userId],
      );
      // Devir incelemesindeki revizyonlar yeni politikaya göre son onayda kontrol edilir; etkilenenler bildirilir.
      const inReview = await db.query(`select pr.id, p.code, pr.rev from product_revisions pr join products p on p.id = pr.product_id where pr.status = 'handover_review'`);
      const affected = [];
      for (const x of inReview.rows) {
        const rd = await handoverReadiness(db, x.id);
        if (rd && !rd.ready) affected.push({ revisionId: x.id, product: `${x.code} Rev.${x.rev}`, missing: rd.missing });
      }
      await recordEvent(db, actor, { entityType: "handover_policy", entityId: r.rows[0].id, eventType: "published", before, after: { versionNo: n, ...input, affectedInReview: affected.length }, reason: input.note });
      return { versionNo: n, ...input, affectedInReview: affected };
    });
  });

  app.get("/api/revisions/:id/readiness", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "product.view", async (db) => {
      const r = await handoverReadiness(db, id);
      if (!r) throw notFound("Revizyon");
      return r;
    });
  });

  /** Muafiyet: yalnızca zorunlu ve eksik madde için, gerekçeli; yayımlanmış revizyona verilmez. */
  app.post("/api/revisions/:id/waivers", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ requirement: z.enum(REQUIREMENTS), reason: z.string().min(10).max(500) }), req.body);
    return tenant(req, "workflow.manage", async (db, actor) => {
      const rev = await db.query(`select status from product_revisions where id = $1`, [id]);
      if (!rev.rows[0]) throw notFound("Revizyon");
      if (rev.rows[0].status === "released") throw conflict("revision_locked", "Yayımlanmış revizyona muafiyet verilmez");
      const rd = (await handoverReadiness(db, id))!;
      const item = rd.items.find((i) => i.key === input.requirement)!;
      if (!item.required) throw conflict("not_required", "Bu madde mevcut politikada zorunlu değil");
      if (item.ok) throw conflict("already_met", "Madde zaten karşılanmış; muafiyet gerekmez");
      const r = await db.query(
        `insert into handover_waivers (company_id, revision_id, requirement, reason, granted_by) values (app_company_id(), $1, $2, $3, $4)
         on conflict (revision_id, requirement) do nothing returning id`,
        [id, input.requirement, input.reason, actor.userId],
      );
      if (!r.rowCount) throw conflict("duplicate", "Bu madde için muafiyet zaten var");
      await recordEvent(db, actor, { entityType: "product_revision", entityId: id, eventType: "handover.waiver", after: { requirement: input.requirement, policyVersion: rd.policyVersion }, reason: input.reason });
      return handoverReadiness(db, id);
    });
  });
}
