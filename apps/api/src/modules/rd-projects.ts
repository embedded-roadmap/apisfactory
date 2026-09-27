import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { conflict, notFound } from "../lib/errors";
import { nextCode, recordEvent } from "../lib/records";
import { parse, tenant } from "../http/context";

/**
 * R04 — Alımın Ar-Ge projesi ve muhasebeyle bağlantısı (ana talimat §3).
 *  - Ar-Ge projesi: kod, ad, maliyet merkezi, opsiyonel bütçe (+para birimi).
 *  - Malzeme talebi projeye bağlanınca (workflow.ts POST /api/purchase-requests, projectId ile)
 *    maliyet merkezi projeninkinden miras alınır ve önce mevcut stoktan karşılama değerlendirilir.
 *  - Muhasebe her giderin hangi projeye ait olduğunu görebilsin: proje detayında satın alma
 *    talepleri → satın alma siparişi satırları zincirinden gerçek harcama (para birimine göre
 *    gruplu, dönüştürülmez) + elle bölüştürülmüş ortak giderler bir arada gösterilir.
 *  - "Ortak alım ve giderler paylaştırılsın": paylaşılan bir gideri (ör. ortak sarf, kargo)
 *    birden çok projeye otomatik/tahmini olarak BÖLMEYİZ — muhasebe gerekçeyle elle, değişmez bir
 *    kayıt olarak (`project_cost_allocations`) bölüştürür.
 */

async function loadProject(db: Db, id: string) {
  const p = (await db.query(
    `select p.id, p.code, p.name, p.cost_center as "costCenter", p.budget_amount as "budgetAmount", p.currency,
            p.status, p.owner_user_id as "ownerUserId", u.name as "ownerName", p.note, p.created_at as "createdAt",
            p.closed_at as "closedAt", p.closed_reason as "closedReason"
       from rd_projects p left join users u on u.id = p.owner_user_id where p.id = $1`,
    [id],
  )).rows[0];
  if (!p) throw notFound("Ar-Ge projesi");

  const requests = (await db.query(
    `select pr.id, pr.code, i.code as "itemCode", pr.qty, pr.status, pr.cost_center as "costCenter",
            pr.need_date as "needDate", pr.estimated_amount as "estimatedAmount", pr.currency, pr.created_at as "createdAt"
       from purchase_requests pr join items i on i.id = pr.item_id
      where pr.project_id = $1 order by pr.created_at desc`,
    [id],
  )).rows;

  // Gerçek harcama: bu projenin taleplerinden doğan satın alma siparişi satırları (para birimine göre
  // gruplu — dönüştürülmez, mevcut alacak/borç yaşlandırma raporlarıyla aynı desen).
  const poSpend = (await db.query(
    `select pol.currency, sum(pol.qty_ordered * pol.unit_price) as ordered, sum(pol.qty_received * pol.unit_price) as received
       from purchase_order_lines pol join purchase_requests pr on pr.id = pol.purchase_request_id
      where pr.project_id = $1 and pol.unit_price is not null
      group by pol.currency`,
    [id],
  )).rows;

  const allocations = (await db.query(
    `select a.id, a.amount, a.currency, a.description, a.source_ref as "sourceRef", a.reason,
            u.name as "allocatedBy", a.allocated_at as "allocatedAt"
       from project_cost_allocations a left join users u on u.id = a.allocated_by
      where a.project_id = $1 order by a.allocated_at desc`,
    [id],
  )).rows;

  const byCurrency = new Map<string, { currency: string; orderedAmount: string; receivedAmount: string; allocatedAmount: string }>();
  for (const r of poSpend) {
    byCurrency.set(r.currency, { currency: r.currency, orderedAmount: Number(r.ordered ?? 0).toFixed(2), receivedAmount: Number(r.received ?? 0).toFixed(2), allocatedAmount: "0.00" });
  }
  for (const a of allocations) {
    const cur = byCurrency.get(a.currency) ?? { currency: a.currency, orderedAmount: "0.00", receivedAmount: "0.00", allocatedAmount: "0.00" };
    cur.allocatedAmount = (Number(cur.allocatedAmount) + Number(a.amount)).toFixed(2);
    byCurrency.set(a.currency, cur);
  }
  const spendByCurrency = [...byCurrency.values()].map((c) => ({ ...c, total: (Number(c.orderedAmount) + Number(c.allocatedAmount)).toFixed(2) }));

  const budgetStatus = p.budgetAmount
    ? (() => {
        const own = spendByCurrency.find((c) => c.currency === p.currency);
        const spent = own ? Number(own.total) : 0;
        return { currency: p.currency, budgetAmount: p.budgetAmount, spent: spent.toFixed(2), remaining: (Number(p.budgetAmount) - spent).toFixed(2) };
      })()
    : null;

  return { ...p, purchaseRequests: requests, spendByCurrency, allocations, budgetStatus };
}

export async function rdProjectsRoutes(app: FastifyInstance) {
  app.get("/api/rd-projects", async (req) => {
    const q = req.query as { status?: string };
    return tenant(req, "rd.project.view", async (db) => {
      const r = await db.query(
        `select p.id, p.code, p.name, p.cost_center as "costCenter", p.budget_amount as "budgetAmount", p.currency,
                p.status, u.name as "ownerName", p.created_at as "createdAt"
           from rd_projects p left join users u on u.id = p.owner_user_id
          where ($1::text is null or p.status = $1) order by p.created_at desc`,
        [q.status ?? null],
      );
      return r.rows;
    });
  });

  app.get("/api/rd-projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "rd.project.view", (db) => loadProject(db, id));
  });

  app.post("/api/rd-projects", async (req) => {
    const input = parse(
      z.object({
        name: z.string().min(2).max(200),
        costCenter: z.string().min(1).max(120).optional(),
        budgetAmount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
        currency: z.string().length(3).optional(),
        ownerUserId: z.string().uuid().optional(),
        note: z.string().max(2000).optional(),
      }).refine((v) => (v.budgetAmount == null) === (v.currency == null), { message: "Bütçe verildiyse para birimi de verilmeli" }),
      req.body,
    );
    return tenant(req, "rd.project.manage", async (db, actor) => {
      const code = await nextCode(db, actor.companyId, "rd_project", "PRJ");
      const r = await db.query(
        `insert into rd_projects (company_id, code, name, cost_center, budget_amount, currency, owner_user_id, note, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [code, input.name, input.costCenter ?? null, input.budgetAmount ?? null, input.currency?.toUpperCase() ?? null, input.ownerUserId ?? null, input.note ?? null, actor.userId],
      );
      const id = r.rows[0].id as string;
      await recordEvent(db, actor, { entityType: "rd_project", entityId: id, eventType: "created", after: { code, ...input } });
      return { id, code };
    });
  });

  app.post("/api/rd-projects/:id/close", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "rd.project.manage", async (db, actor) => {
      const p = (await db.query(`select code, status from rd_projects where id = $1 for update`, [id])).rows[0];
      if (!p) throw notFound("Ar-Ge projesi");
      if (p.status === "closed") throw conflict("already_closed", `Proje "${p.code}" zaten kapalı`);
      await db.query(`update rd_projects set status = 'closed', closed_at = now(), closed_by = $2, closed_reason = $3 where id = $1`, [id, actor.userId, input.reason]);
      await recordEvent(db, actor, { entityType: "rd_project", entityId: id, eventType: "closed", before: { status: p.status }, after: { status: "closed" }, reason: input.reason });
      return { id, status: "closed" };
    });
  });

  /** Ortak alım/gider paylaştırma: muhasebe, gerekçeyle, elle — otomatik/tahmini bölüştürme yok. */
  app.post("/api/rd-projects/:id/cost-allocations", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        amount: z.string().regex(/^\d+(\.\d+)?$/),
        currency: z.string().length(3),
        description: z.string().min(3).max(500),
        sourceRef: z.string().max(200).optional(),
        reason: z.string().min(3).max(500),
      }),
      req.body,
    );
    return tenant(req, "cost.manage", async (db, actor) => {
      const p = (await db.query(`select code, status from rd_projects where id = $1`, [id])).rows[0];
      if (!p) throw notFound("Ar-Ge projesi");
      if (p.status !== "open") throw conflict("project_closed", `Proje "${p.code}" kapalı`);
      const r = await db.query(
        `insert into project_cost_allocations (company_id, project_id, amount, currency, description, source_ref, reason, allocated_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [id, input.amount, input.currency.toUpperCase(), input.description, input.sourceRef ?? null, input.reason, actor.userId],
      );
      const allocId = r.rows[0].id as string;
      await recordEvent(db, actor, { entityType: "rd_project", entityId: id, eventType: "cost_allocated", after: { allocationId: allocId, ...input } });
      return { id: allocId };
    });
  });
}
