import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { nextCode, recordEvent } from "../lib/records";
import { parse, tenant } from "../http/context";
import { RD_ACTIVITIES, RD_COST_CATEGORIES, computeRdCost, doubleCountedInvoice, writeRdCostReport } from "../lib/rd-cost";

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
    `select a.id, a.amount, a.currency, a.category, a.description, a.source_ref as "sourceRef", a.reason,
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

  const budgetVersions = (await db.query(
    `select b.version_no as "versionNo", b.amount, b.currency, b.reason, u.name as "approvedBy", b.created_at as "createdAt"
       from rd_project_budgets b left join users u on u.id = b.approved_by where b.project_id = $1 order by b.version_no desc`,
    [id],
  )).rows;

  const budgetStatus = p.budgetAmount
    ? (() => {
        const own = spendByCurrency.find((c) => c.currency === p.currency);
        const spent = own ? Number(own.total) : 0;
        return { currency: p.currency, budgetAmount: p.budgetAmount, spent: spent.toFixed(2), remaining: (Number(p.budgetAmount) - spent).toFixed(2) };
      })()
    : null;

  return { ...p, purchaseRequests: requests, spendByCurrency, allocations, budgetStatus, budgetVersions };
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
      if (input.budgetAmount) {
        // Açılışta verilen bütçe onaylı baz bütçenin sürüm 1'idir (bütçe sapması buna göre ölçülür).
        await db.query(
          `insert into rd_project_budgets (company_id, project_id, version_no, amount, currency, reason, approved_by)
           values (app_company_id(), $1, 1, $2, $3, 'Proje açılış bütçesi', $4)`,
          [id, input.budgetAmount, input.currency!.toUpperCase(), actor.userId],
        );
      }
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
        category: z.enum(RD_COST_CATEGORIES).optional(),
      }),
      req.body,
    );
    return tenant(req, "cost.manage", async (db, actor) => {
      const p = (await db.query(`select code, status from rd_projects where id = $1`, [id])).rows[0];
      if (!p) throw notFound("Ar-Ge projesi");
      if (p.status !== "open") throw conflict("project_closed", `Proje "${p.code}" kapalı`);
      if (input.sourceRef) {
        const dup = await doubleCountedInvoice(db, id, input.sourceRef);
        if (dup) throw conflict("double_count", `Tedarikçi faturası ${dup} bu projenin sipariş satırlarıyla zaten Ar-Ge maliyetine giriyor; ayrıca bölüştürülemez`);
      }
      const r = await db.query(
        `insert into project_cost_allocations (company_id, project_id, amount, currency, description, source_ref, reason, allocated_by, category)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [id, input.amount, input.currency.toUpperCase(), input.description, input.sourceRef ?? null, input.reason, actor.userId, input.category ?? "other"],
      );
      const allocId = r.rows[0].id as string;
      await recordEvent(db, actor, { entityType: "rd_project", entityId: id, eventType: "cost_allocated", after: { allocationId: allocId, ...input } });
      return { id: allocId };
    });
  });

  /** Onaylı baz bütçe revizyonu: yeni sürüm (öncekiler korunur); proje kartındaki güncel bütçe de güncellenir. */
  app.post("/api/rd-projects/:id/budget", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/), currency: z.string().regex(/^[A-Za-z]{3}$/), reason: z.string().min(3).max(500) }),
      req.body,
    );
    return tenant(req, "cost.manage", async (db, actor) => {
      const p = (await db.query(`select code, status, budget_amount, currency from rd_projects where id = $1 for update`, [id])).rows[0];
      if (!p) throw notFound("Ar-Ge projesi");
      if (p.status !== "open") throw conflict("project_closed", `Proje "${p.code}" kapalı`);
      const n = (await db.query(`select coalesce(max(version_no), 0) + 1 as n from rd_project_budgets where project_id = $1`, [id])).rows[0].n;
      const currency = input.currency.toUpperCase();
      await db.query(
        `insert into rd_project_budgets (company_id, project_id, version_no, amount, currency, reason, approved_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6)`,
        [id, n, input.amount, currency, input.reason, actor.userId],
      );
      await db.query(`update rd_projects set budget_amount = $2, currency = $3 where id = $1`, [id, input.amount, currency]);
      await recordEvent(db, actor, {
        entityType: "rd_project", entityId: id, eventType: "budget.revised",
        before: { amount: p.budget_amount, currency: p.currency }, after: { versionNo: n, amount: input.amount, currency }, reason: input.reason,
      });
      return { versionNo: n };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // R05 — Ar-Ge saat ücreti, mühendislik zaman kaydı ve devir maliyet raporu.

  app.get("/api/rd-labor-rates", async (req) =>
    tenant(req, "rd.project.view", async (db) =>
      (await db.query(
        `select r.version_no as "versionNo", r.rate_per_hour as "ratePerHour", r.currency, r.effective_from as "effectiveFrom", r.note,
                u.name as "createdBy", r.created_at as "createdAt"
           from rd_labor_rates r left join users u on u.id = r.created_by order by r.effective_from desc`,
      )).rows,
    ),
  );

  /** Yeni ücret sürümü; geçmiş tarihli zaman kayıtları kendi tarihindeki ücretle kalır. */
  app.post("/api/rd-labor-rates", async (req) => {
    const input = parse(
      z.object({
        ratePerHour: z.string().regex(/^\d+(\.\d{1,4})?$/),
        currency: z.string().regex(/^[A-Za-z]{3}$/),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().min(3).max(500),
      }),
      req.body,
    );
    return tenant(req, "cost.manage", async (db, actor) => {
      await db.query(`select pg_advisory_xact_lock(hashtext('rd_labor_rate:' || app_company_id()::text))`);
      const dup = await db.query(`select 1 from rd_labor_rates where effective_from = $1`, [input.effectiveFrom]);
      if (dup.rowCount) throw conflict("duplicate", "Bu tarihten geçerli bir ücret zaten var; farklı bir başlangıç tarihi seçin");
      const n = (await db.query(`select coalesce(max(version_no), 0) + 1 as n from rd_labor_rates`)).rows[0].n;
      await db.query(
        `insert into rd_labor_rates (company_id, version_no, rate_per_hour, currency, effective_from, note, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6)`,
        [n, input.ratePerHour, input.currency.toUpperCase(), input.effectiveFrom, input.note, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "rd_labor_rate", entityId: actor.companyId, eventType: "published", after: { versionNo: n, ...input }, reason: input.note });
      return { versionNo: n };
    });
  });

  app.get("/api/rd-projects/:id/time-entries", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "rd.project.view", async (db) =>
      (await db.query(
        `select t.id, t.work_date as "workDate", t.hours, t.activity, t.note, t.reason, u.name as "userName",
                t.reverses_entry_id as "reversesEntryId", exists (select 1 from rd_time_entries x where x.reverses_entry_id = t.id) as reversed,
                c.name as "createdBy", t.created_at as "createdAt"
           from rd_time_entries t join users u on u.id = t.user_id left join users c on c.id = t.created_by
          where t.project_id = $1 order by t.work_date desc, t.created_at desc`,
        [id],
      )).rows,
    );
  });

  app.post("/api/rd-projects/:id/time-entries", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        userId: z.string().uuid().optional(),
        workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        hours: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/),
        activity: z.enum(RD_ACTIVITIES),
        note: z.string().max(500).optional(),
      }),
      req.body,
    );
    const h = Number(input.hours);
    if (!(h > 0 && h <= 24)) throw badRequest("Saat 0'dan büyük ve en çok 24 olmalı");
    if (input.workDate > new Date().toISOString().slice(0, 10)) throw badRequest("İleri tarihli zaman kaydı girilemez");
    return tenant(req, "rd.project.manage", async (db, actor) => {
      const p = (await db.query(`select code, status from rd_projects where id = $1`, [id])).rows[0];
      if (!p) throw notFound("Ar-Ge projesi");
      if (p.status !== "open") throw conflict("project_closed", `Proje "${p.code}" kapalı`);
      const userId = input.userId ?? actor.userId;
      if (!userId) throw badRequest("Kullanıcı belirtilmeli");
      const u = await db.query(`select 1 from users u join memberships m on m.user_id = u.id where u.id = $1 and m.company_id = app_company_id()`, [userId]);
      if (!u.rowCount) throw notFound("Kullanıcı");
      const r = await db.query(
        `insert into rd_time_entries (company_id, project_id, user_id, work_date, hours, activity, note, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [id, userId, input.workDate, input.hours, input.activity, input.note ?? null, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "rd_project", entityId: id, eventType: "time_logged", after: { entryId: r.rows[0].id, userId, ...input } });
      return { id: r.rows[0].id as string };
    });
  });

  /** Düzeltme: kayıt silinmez; aynı tarih ve saatle ters kayıt yazılır. Doğrusu gerekiyorsa yeni kayıt girilir. */
  app.post("/api/rd-time-entries/:id/reverse", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "rd.project.manage", async (db, actor) => {
      // Tablo değişmez (UPDATE yetkisi yok) — satır kilidi yerine kayıt başına danışma kilidi; eşzamanlı ikinci ters
      // kaydı ayrıca `reverses_entry_id` tekilliği de engeller.
      await db.query(`select pg_advisory_xact_lock(hashtext('rd_time_reverse:' || $1::text))`, [id]);
      const t = (await db.query(`select * from rd_time_entries where id = $1`, [id])).rows[0];
      if (!t) throw notFound("Zaman kaydı");
      if (t.reverses_entry_id) throw conflict("is_reversal", "Ters kayıt yeniden ters çevrilemez");
      const done = await db.query(`select 1 from rd_time_entries where reverses_entry_id = $1`, [id]);
      if (done.rowCount) throw conflict("already_reversed", "Bu kayıt zaten ters çevrilmiş");
      const r = await db.query(
        `insert into rd_time_entries (company_id, project_id, user_id, work_date, hours, activity, note, reverses_entry_id, reason, created_by)
         values (app_company_id(), $1, $2, $3, -$4::numeric, $5, $6, $7, $8, $9) returning id`,
        [t.project_id, t.user_id, t.work_date, t.hours, t.activity, t.note, id, input.reason, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "rd_project", entityId: t.project_id, eventType: "time_reversed", before: { entryId: id, hours: t.hours }, after: { reversalId: r.rows[0].id }, reason: input.reason });
      return { id: r.rows[0].id as string };
    });
  });

  /** Canlı önizleme (kaydedilmez): projenin şu anki Ar-Ge maliyeti. */
  app.get("/api/rd-projects/:id/cost", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "rd.project.view", async (db) => {
      const r = await computeRdCost(db, id);
      if (!r) throw notFound("Ar-Ge projesi");
      return r;
    });
  });

  /** Revizyonu Ar-Ge projesine bağlar/ayırır; devir onayından (yayından) sonra değişmez. */
  app.put("/api/revisions/:id/rd-project", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ projectId: z.string().uuid().nullable(), reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "rd.project.manage", async (db, actor) => {
      const rev = (await db.query(`select status, rd_project_id from product_revisions where id = $1 for update`, [id])).rows[0];
      if (!rev) throw notFound("Revizyon");
      if (rev.status === "released") throw conflict("revision_locked", "Yayımlanmış revizyonun proje bağı değiştirilemez");
      if (input.projectId) {
        const p = await db.query(`select 1 from rd_projects where id = $1`, [input.projectId]);
        if (!p.rowCount) throw notFound("Ar-Ge projesi");
      }
      await db.query(`update product_revisions set rd_project_id = $2 where id = $1`, [id, input.projectId]);
      await recordEvent(db, actor, { entityType: "product_revision", entityId: id, eventType: "rd_project.linked", before: { projectId: rev.rd_project_id }, after: { projectId: input.projectId }, reason: input.reason });
      return { id, projectId: input.projectId };
    });
  });

  app.get("/api/revisions/:id/rd-cost-reports", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "rd.project.view", async (db) =>
      (await db.query(
        `select r.id, r.version_no as "versionNo", r.status, r.trigger, r.report, r.reason, u.name as "createdBy", r.created_at as "createdAt"
           from rd_cost_reports r left join users u on u.id = r.created_by where r.revision_id = $1 order by r.version_no desc`,
        [id],
      )).rows,
    );
  });

  /** Tarihçeli düzeltme: devirden sonra gelen fatura/gider/zaman için yeni rapor sürümü (öncekiler korunur). */
  app.post("/api/revisions/:id/rd-cost-reports/recalculate", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "cost.manage", async (db, actor) => {
      const rev = (await db.query(`select status, rd_project_id from product_revisions where id = $1`, [id])).rows[0];
      if (!rev) throw notFound("Revizyon");
      if (rev.status !== "released") throw conflict("not_released", "Maliyet raporu devir onayıyla oluşur; revizyon henüz yayımlanmadı");
      const first = (await db.query(`select project_id from rd_cost_reports where revision_id = $1 order by version_no limit 1`, [id])).rows[0];
      const projectId = first?.project_id ?? rev.rd_project_id;
      if (!projectId) throw conflict("no_project", "Revizyon bir Ar-Ge projesine bağlı değil");
      return writeRdCostReport(db, actor, id, projectId, "recalculation", input.reason);
    });
  });
}
