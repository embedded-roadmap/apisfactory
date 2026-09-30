import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { closeTasks, nextCode, openTask, recordEvent } from "../lib/records";
import { can, ctxOf, parse, tenant } from "../http/context";
import { storageFor } from "../lib/storage";

const KIND = ["pcb", "dizgi", "mekanik", "kablo", "montaj", "dis_test"] as const;
const KIND_TR: Record<string, string> = { pcb: "PCB", dizgi: "Dizgi", mekanik: "Mekanik", kablo: "Kablo", montaj: "Montaj", dis_test: "Dış test" };
const PROGRESS_ORDER = ["accepted", "prep", "in_production", "testing", "ready_to_ship"] as const;
const FILE_KINDS = ["photo", "video", "test_report", "delivery_doc"] as const;
// video/mp4 ve video/webm burada YALNIZCA ön-yüklenmiş (staged) referansla kabul edilir — doğrudan
// base64 gövdeyle değil: önceki sürümde video/mp4 tipi burada listelide olsa da genel 8 MB gövde
// sınırı gerçekte kullanılabilir bir videoyu asla geçirmezdi (oturum 37'de keşfedilen, gerçek bir
// video yüklemesinin hiç doğrulanmamış olduğu önceden var olan bir boşluk — devam notunda işaretlendi).
const CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf", "text/plain", "text/csv"] as const;
const MAX_FILE_BYTES = 20_000_000;
const InlineFileInput = z.object({ kind: z.enum(FILE_KINDS), fileName: z.string().min(1).max(200), contentType: z.enum(CONTENT_TYPES), contentBase64: z.string().min(1) });
const StagedFileInput = z.object({ kind: z.enum(FILE_KINDS), stagedUploadId: z.string().uuid() });
const JobFileInput = z.union([InlineFileInput, StagedFileInput]);

async function locationOf(db: Db, type: string): Promise<string> {
  const r = await db.query(`select id from locations where type = $1 order by code limit 1`, [type]);
  if (!r.rows[0]) throw conflict("location_missing", `"${type}" tipinde konum tanımlı değil`);
  return r.rows[0].id;
}

const SELECT = `
  select j.id, j.code, j.kind, j.status, j.scope, j.qty, j.promised_date as "promisedDate", j.price, j.currency,
         j.company_supplies as "companySupplies", j.subcontractor_supplies as "subcontractorSupplies", j.tech_package_note as "techPackageNote",
         j.counter_price as "counterPrice", j.counter_promised_date as "counterPromisedDate", j.counter_note as "counterNote",
         j.declared_good_qty as "declaredGoodQty", j.declared_scrap_qty as "declaredScrapQty", j.declared_unused_qty as "declaredUnusedQty",
         j.declared_note as "declaredNote", j.declared_at as "declaredAt", j.accepted_good_qty as "acceptedGoodQty", j.accepted_at as "acceptedAt",
         j.subcontractor_user_id as "subcontractorUserId", u.name as "subcontractorName", u.email as "subcontractorEmail",
         p.code as "productCode", pr.rev, j.created_at as "createdAt", j.decided_at as "decidedAt",
         j.work_order_id as "workOrderId", wo.code as "workOrderCode", j.review_reason as "reviewReason"
    from subcontract_jobs j
    join users u on u.id = j.subcontractor_user_id
    left join product_revisions pr on pr.id = j.product_revision_id
    left join products p on p.id = pr.product_id
    left join work_orders wo on wo.id = j.work_order_id`;

async function loadJob(db: Db, id: string) {
  const r = await db.query(`${SELECT} where j.id = $1`, [id]);
  if (!r.rows[0]) throw notFound("Fason iş");
  return r.rows[0];
}

/** İç personel subcontract.manage ile her işi görür/yönetir; dış kullanıcı yalnız kendisine atanan işi. */
async function authorize(req: any, db: Db, id: string) {
  const job = await loadJob(db, id);
  const c = ctxOf(req);
  if (can(req, "subcontract.manage")) return job;
  if (c.isExternal && job.subcontractorUserId === c.userId) return job;
  throw forbidden("subcontract.manage");
}

export async function subcontractRoutes(app: FastifyInstance) {
  app.post("/api/subcontract-jobs", async (req) => {
    const input = parse(
      z.object({
        subcontractorUserId: z.string().uuid(),
        kind: z.enum(KIND),
        productRevisionId: z.string().uuid().optional(),
        workOrderId: z.string().uuid().optional(),
        scope: z.string().min(5).max(2000),
        qty: z.string().regex(/^\d+(\.\d+)?$/),
        promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        currency: z.string().regex(/^[A-Z]{3}$/).default("TRY"),
        companySupplies: z.string().max(2000).optional(),
        subcontractorSupplies: z.string().max(2000).optional(),
        techPackageNote: z.string().max(2000).optional(),
      }),
      req.body,
    );
    return tenant(req, "subcontract.manage", async (db, actor) => {
      const m = await db.query(
        `select 1 from memberships mem join membership_roles mr on mr.membership_id = mem.id join roles r on r.id = mr.role_id
          where mem.company_id = app_company_id() and mem.user_id = $1 and mem.status = 'active' and r.code = 'subcontractor'`,
        [input.subcontractorUserId],
      );
      if (!m.rows[0]) throw badRequest("Seçilen kullanıcı bu şirkette aktif bir fason (subcontractor) üyeliğine sahip değil");
      if (input.workOrderId) {
        const wo = await db.query(`select 1 from work_orders where id = $1`, [input.workOrderId]);
        if (!wo.rows[0]) throw badRequest("Seçilen iş emri bulunamadı");
      }
      const code = await nextCode(db, actor.companyId, "subcontract_job", "SJ");
      const r = await db.query(
        `insert into subcontract_jobs (company_id, code, subcontractor_user_id, kind, product_revision_id, work_order_id, scope, qty, promised_date, price, currency, company_supplies, subcontractor_supplies, tech_package_note, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [code, input.subcontractorUserId, input.kind, input.productRevisionId ?? null, input.workOrderId ?? null, input.scope, input.qty, input.promisedDate ?? null, input.price ?? null, input.currency, input.companySupplies ?? null, input.subcontractorSupplies ?? null, input.techPackageNote ?? null, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "subcontract_job", entityId: r.rows[0].id, eventType: "proposed", after: { code, kind: input.kind, qty: input.qty } });
      return loadJob(db, r.rows[0].id);
    });
  });

  app.get("/api/subcontract-jobs", async (req) =>
    tenant(req, "subcontract.manage", async (db) => (await db.query(`${SELECT} order by j.created_at desc limit 200`)).rows),
  );

  /** Dış kullanıcının kendi işleri; kendisine atanmamış hiçbir kayıt görünmez. */
  app.get("/api/subcontract-jobs/mine", async (req) =>
    tenant(req, null, async (db, actor) => (await db.query(`${SELECT} where j.subcontractor_user_id = $1 order by j.created_at desc`, [actor.userId])).rows),
  );

  /**
   * Fasoncu performans raporu (W32 devamı): mevcut subcontract_jobs kayıtlarından hesaplanır, yeni tablo yok.
   * Termin karşılaştırması yalnız promised_date + accepted_at (şirketin kesin kabul tarihi) ikisi de doluysa
   * yapılır; biri eksikse o iş "değerlendirilemedi" sayılır — uydurulmaz. Yalnız iç personel görür (ticari veri).
   */
  app.get("/api/subcontract-jobs/performance", async (req) =>
    tenant(req, "subcontract.manage", async (db) => {
      const r = await db.query(`
        select j.subcontractor_user_id as "subcontractorUserId", u.name as "subcontractorName", u.email as "subcontractorEmail",
               count(*) as "jobsTotal",
               count(*) filter (where j.status = 'completed') as "jobsCompleted",
               count(*) filter (where j.status = 'rejected') as "jobsRejected",
               count(*) filter (where j.status not in ('completed', 'rejected', 'cancelled')) as "jobsActive",
               count(*) filter (where j.status = 'completed' and j.promised_date is not null and j.accepted_at is not null and j.accepted_at::date <= j.promised_date) as "onTimeCompleted",
               count(*) filter (where j.status = 'completed' and j.promised_date is not null and j.accepted_at is not null and j.accepted_at::date > j.promised_date) as "lateCompleted",
               count(*) filter (where j.status = 'completed' and (j.promised_date is null or j.accepted_at is null)) as "unevaluatedCompleted",
               coalesce(sum(j.accepted_good_qty) filter (where j.status = 'completed'), 0) as "totalAcceptedGoodQty",
               coalesce(sum(j.declared_good_qty) filter (where j.declared_at is not null), 0) as "totalDeclaredGoodQty",
               coalesce(sum(j.declared_scrap_qty) filter (where j.declared_at is not null), 0) as "totalDeclaredScrapQty",
               coalesce(sum(j.declared_unused_qty) filter (where j.declared_at is not null), 0) as "totalDeclaredUnusedQty",
               max(j.created_at) as "lastJobAt"
          from subcontract_jobs j join users u on u.id = j.subcontractor_user_id
         group by j.subcontractor_user_id, u.name, u.email
         order by u.name`);
      return r.rows.map((row) => {
        const onTimeDenom = Number(row.onTimeCompleted) + Number(row.lateCompleted);
        const declaredDenom = Number(row.totalDeclaredGoodQty) + Number(row.totalDeclaredScrapQty) + Number(row.totalDeclaredUnusedQty);
        return {
          ...row,
          onTimeRate: onTimeDenom > 0 ? Number(row.onTimeCompleted) / onTimeDenom : null,
          scrapRate: declaredDenom > 0 ? Number(row.totalDeclaredScrapQty) / declaredDenom : null,
        };
      });
    }),
  );

  app.get("/api/subcontract-jobs/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, null, (db) => authorize(req, db, id));
  });

  /**
   * Malzeme kullanımı — girdi lotu bazında izlenebilirlik (W32 devamı): yeni tablo yok, işe bağlı
   * (ref_type='subcontract_job') stock_moves kayıtlarından toplanır. Gönderilen − iade edilen − fire = net
   * tüketilen; bu iş için gönderilmemiş bir lot hiç görünmez (uydurulmaz). Kesin kabul edilmiş çıktı lotu
   * ayrıca gösterilir — hangi bileşenden ne kadar geldiği bilgisi bu tabloyla birlikte okunur, ama sunucu
   * bunu tek bir "girdi→çıktı" oranına indirgemez (birden çok bileşen olabilir).
   */
  app.get("/api/subcontract-jobs/:id/material-usage", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, null, async (db) => {
      await authorize(req, db, id);
      const inputs = await db.query(
        `select i.id as "itemId", i.code as "itemCode", i.name as "itemName", l.id as "lotId", l.lot_no as "lotNo",
                coalesce(sum(sm.qty) filter (where sm.move_type = 'transfer'), 0) as "sentQty",
                coalesce(sum(sm.qty) filter (where sm.move_type = 'return'), 0) as "returnedQty",
                coalesce(sum(sm.qty) filter (where sm.move_type = 'scrap'), 0) as "scrappedQty",
                coalesce(sum(sm.qty) filter (where sm.move_type = 'transfer'), 0)
                  - coalesce(sum(sm.qty) filter (where sm.move_type = 'return'), 0)
                  - coalesce(sum(sm.qty) filter (where sm.move_type = 'scrap'), 0) as "netConsumedQty"
           from stock_moves sm
           join items i on i.id = sm.item_id
           join lots l on l.id = sm.lot_id
          where sm.ref_type = 'subcontract_job' and sm.ref_id = $1 and sm.move_type in ('transfer', 'return', 'scrap')
          group by i.id, i.code, i.name, l.id, l.lot_no
          order by i.code, l.lot_no`,
        [id],
      );
      const output = await db.query(
        `select i.id as "itemId", i.code as "itemCode", i.name as "itemName", l.id as "lotId", l.lot_no as "lotNo", sm.qty, sm.created_at as "receivedAt"
           from stock_moves sm
           join items i on i.id = sm.item_id
           join lots l on l.id = sm.lot_id
          where sm.ref_type = 'subcontract_job' and sm.ref_id = $1 and sm.move_type = 'receive'
          order by sm.created_at`,
        [id],
      );
      return { inputLots: inputs.rows, outputLots: output.rows };
    });
  });

  /** Dış firma: kabul, karşı teklif veya ret. */
  app.post("/api/subcontract-jobs/:id/decision", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        decision: z.enum(["accept", "counter", "reject"]),
        counterPrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        counterPromisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        note: z.string().max(2000).optional(),
      }),
      req.body,
    );
    return tenant(req, null, async (db, actor) => {
      const job = await authorize(req, db, id);
      if (!ctxOf(req).isExternal || job.subcontractorUserId !== actor.userId) throw forbidden("subcontract.manage");
      if (job.status !== "proposed") throw conflict("invalid_transition", "Karar yalnızca önerilmiş iş için verilir");
      if (input.decision === "reject" && (!input.note || input.note.trim().length < 3)) throw conflict("reason_required", "Ret gerekçesi zorunlu");
      if (input.decision === "counter" && !input.counterPrice && !input.counterPromisedDate) throw badRequest("Karşı teklif için fiyat veya tarih belirtilmeli");
      const status = input.decision === "accept" ? "accepted" : input.decision === "counter" ? "countered" : "rejected";
      await db.query(
        `update subcontract_jobs set status = $2, counter_price = $3, counter_promised_date = $4, counter_note = $5, decided_at = now() where id = $1`,
        [id, status, input.counterPrice ?? null, input.counterPromisedDate ?? null, input.note ?? null],
      );
      await recordEvent(db, actor, { entityType: "subcontract_job", entityId: id, eventType: `decision.${input.decision}`, after: { status }, reason: input.note });
      return loadJob(db, id);
    });
  });

  /** İç personel: karşı teklifi kabul eder (yeni fiyat/tarih uygulanır) veya reddeder. */
  app.post("/api/subcontract-jobs/:id/counter-decision", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ decision: z.enum(["accept", "reject"]), note: z.string().max(2000).optional() }), req.body);
    return tenant(req, "subcontract.manage", async (db, actor) => {
      const job = await loadJob(db, id);
      if (job.status !== "countered") throw conflict("invalid_transition", "Yalnızca karşı teklif verilmiş iş için karar verilir");
      if (input.decision === "accept") {
        await db.query(
          `update subcontract_jobs set status = 'accepted', price = coalesce(counter_price, price), promised_date = coalesce(counter_promised_date, promised_date), decided_at = now() where id = $1`,
          [id],
        );
      } else {
        await db.query(`update subcontract_jobs set status = 'rejected', decided_at = now() where id = $1`, [id]);
      }
      await recordEvent(db, actor, { entityType: "subcontract_job", entityId: id, eventType: `counter.${input.decision}`, reason: input.note });
      return loadJob(db, id);
    });
  });

  /** Dış firma ilerleme bildirir: yalnız ileri yönde (hazırlık → üretimde → testte → sevke hazır). */
  app.post("/api/subcontract-jobs/:id/progress", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ status: z.enum(["prep", "in_production", "testing", "ready_to_ship"]) }), req.body);
    return tenant(req, null, async (db, actor) => {
      const job = await authorize(req, db, id);
      if (!ctxOf(req).isExternal || job.subcontractorUserId !== actor.userId) throw forbidden("subcontract.manage");
      const curIdx = PROGRESS_ORDER.indexOf(job.status);
      const nextIdx = PROGRESS_ORDER.indexOf(input.status);
      if (curIdx === -1 || nextIdx !== curIdx + 1) throw conflict("invalid_transition", `"${job.status}" durumundan "${input.status}" durumuna geçilemez (yalnız ileri yönde, adım atlanmaz)`);
      await db.query(`update subcontract_jobs set status = $2 where id = $1`, [id, input.status]);
      await recordEvent(db, actor, { entityType: "subcontract_job", entityId: id, eventType: `progress.${input.status}` });
      return loadJob(db, id);
    });
  });

  /** Dış firmanın beyanı: sağlam/fire/kullanılmayan miktar. Şirketin kesin kabulüyle karıştırılmaz (ayrı alan, ayrı adım). */
  app.post("/api/subcontract-jobs/:id/declare", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ goodQty: z.string().regex(/^\d+(\.\d+)?$/), scrapQty: z.string().regex(/^\d+(\.\d+)?$/).default("0"), unusedQty: z.string().regex(/^\d+(\.\d+)?$/).default("0"), note: z.string().max(2000).optional() }), req.body);
    return tenant(req, null, async (db, actor) => {
      const job = await authorize(req, db, id);
      if (!ctxOf(req).isExternal || job.subcontractorUserId !== actor.userId) throw forbidden("subcontract.manage");
      if (job.status !== "ready_to_ship") throw conflict("invalid_transition", "Beyan yalnızca \"sevke hazır\" durumunda yapılır");
      await db.query(
        `update subcontract_jobs set declared_good_qty = $2, declared_scrap_qty = $3, declared_unused_qty = $4, declared_note = $5, declared_at = now() where id = $1`,
        [id, input.goodQty, input.scrapQty, input.unusedQty, input.note ?? null],
      );
      await recordEvent(db, actor, { entityType: "subcontract_job", entityId: id, eventType: "declared", after: input });
      return loadJob(db, id);
    });
  });

  /** İç personel: gönderilen malzemeyi fason konumuna transfer eder (fiziksel stok düşer, sahiplik şirkette kalır). */
  app.post("/api/subcontract-jobs/:id/transfer-material", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ itemId: z.string().uuid(), lotId: z.string().uuid(), qty: z.string().regex(/^\d+(\.\d+)?$/) }), req.body);
    return tenant(req, "subcontract.manage", async (db, actor) => {
      const job = await loadJob(db, id);
      if (!["accepted", "prep", "in_production", "testing"].includes(job.status)) throw conflict("invalid_transition", "Malzeme yalnızca kabul edilmiş/devam eden iş için gönderilir");
      const stockLoc = await locationOf(db, "stock");
      const subLoc = await locationOf(db, "subcontractor");
      await db.query(
        `insert into stock_moves (company_id, item_id, lot_id, from_location_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, 'transfer', 'subcontract_job', $6, $7)`,
        [input.itemId, input.lotId, stockLoc, subLoc, input.qty, id, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "subcontract_job", entityId: id, eventType: "material.sent", after: input });
      return { ok: true };
    });
  });

  /** İç personel: fason konumundan fire (imha) veya kullanılmayan malzeme iadesi. */
  app.post("/api/subcontract-jobs/:id/return-material", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ itemId: z.string().uuid(), lotId: z.string().uuid(), qty: z.string().regex(/^\d+(\.\d+)?$/), kind: z.enum(["scrap", "unused"]) }), req.body);
    return tenant(req, "subcontract.manage", async (db, actor) => {
      await loadJob(db, id); // iş yoksa 404
      const subLoc = await locationOf(db, "subcontractor");
      if (input.kind === "scrap") {
        await db.query(
          `insert into stock_moves (company_id, item_id, lot_id, from_location_id, qty, move_type, ref_type, ref_id, created_by)
           values (app_company_id(), $1, $2, $3, $4, 'scrap', 'subcontract_job', $5, $6)`,
          [input.itemId, input.lotId, subLoc, input.qty, id, actor.userId],
        );
      } else {
        const stockLoc = await locationOf(db, "stock");
        await db.query(
          `insert into stock_moves (company_id, item_id, lot_id, from_location_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
           values (app_company_id(), $1, $2, $3, $4, $5, 'return', 'subcontract_job', $6, $7)`,
          [input.itemId, input.lotId, subLoc, stockLoc, input.qty, id, actor.userId],
        );
      }
      await recordEvent(db, actor, { entityType: "subcontract_job", entityId: id, eventType: `material.${input.kind}`, after: input });
      return { ok: true };
    });
  });

  /**
   * İç personel: fasondan gelen bitmiş çıktı — dış firmanın beyanından ayrı, şirketin kesin kabulüdür.
   * Yeni lot açılır ve giriş kontrolüne girer (herhangi bir mal kabul gibi); iş tamamlanır.
   */
  app.post("/api/subcontract-jobs/:id/accept-output", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ itemId: z.string().uuid(), lotNo: z.string().min(1).max(80), qty: z.string().regex(/^\d+(\.\d+)?$/) }), req.body);
    return tenant(req, "subcontract.manage", async (db, actor) => {
      const job = await loadJob(db, id);
      if (!["testing", "ready_to_ship"].includes(job.status)) throw conflict("invalid_transition", "Kesin kabul yalnızca test/sevke hazır aşamasında yapılır");
      const inspLoc = await locationOf(db, "incoming_inspection");
      // Bitmiş çıktı yeni bir lottur (fason firmada üretildi); mal kabul gibi doğrudan giriş kontrolüne girer.
      const lot = await db.query(
        `insert into lots (company_id, item_id, lot_no, supplier_name, inspection_status) values (app_company_id(), $1, $2, $3, 'pending') returning id`,
        [input.itemId, input.lotNo, `Fason: ${job.code}`],
      ).catch((e) => { if (e.code === "23505") throw conflict("lot_exists", `Bu kalem için lot zaten var: ${input.lotNo}`); throw e; });
      await db.query(
        `insert into stock_moves (company_id, item_id, lot_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
         values (app_company_id(), $1, $2, $3, $4, 'receive', 'subcontract_job', $5, $6)`,
        [input.itemId, lot.rows[0].id, inspLoc, input.qty, id, actor.userId],
      );
      await openTask(db, actor.companyId, { kind: "incoming_inspection", title: `Fason kabul kalite kontrolü — ${job.code} / lot ${input.lotNo}`, entityType: "lot", entityId: lot.rows[0].id, assigneeRole: "quality" });
      await db.query(`update subcontract_jobs set status = 'completed', accepted_good_qty = $2, accepted_at = now() where id = $1`, [id, input.qty]);
      await recordEvent(db, actor, { entityType: "subcontract_job", entityId: id, eventType: "accepted_output", after: { lotNo: input.lotNo, qty: input.qty } });
      return { ok: true, lotId: lot.rows[0].id };
    });
  });

  /**
   * W32 devamı: bağlı iş emrinde bir değişiklik talebi kararı (beklet/yeniden işle/kalanı iptal) bu işi
   * "incelemede" işaretlemişse, iç personel işin ne olacağına (devam/durdur/yeniden işle) burada karar verir.
   * Sunucu dış firmaya hiçbir şey otomatik iletmez/varsaymaz — yalnızca karar kaydedilir ve (durdurulursa) iş iptal edilir.
   */
  app.post("/api/subcontract-jobs/:id/review-decision", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ decision: z.enum(["continue", "stop", "rework"]), note: z.string().min(3).max(2000) }), req.body);
    return tenant(req, "subcontract.manage", async (db, actor) => {
      const job = await loadJob(db, id);
      if (!job.reviewReason) throw conflict("not_under_review", "Bu iş incelemede değil");
      if (input.decision === "stop") {
        if (["completed", "rejected", "cancelled"].includes(job.status)) throw conflict("invalid_transition", `"${job.status}" durumundaki iş durdurulamaz`);
        await db.query(`update subcontract_jobs set status = 'cancelled', review_reason = null where id = $1`, [id]);
      } else {
        await db.query(`update subcontract_jobs set review_reason = null where id = $1`, [id]);
      }
      await recordEvent(db, actor, { entityType: "subcontract_job", entityId: id, eventType: `review.${input.decision}`, reason: input.note });
      await closeTasks(db, actor.companyId, "subcontract_review", id);
      return loadJob(db, id);
    });
  });

  app.get("/api/subcontract-jobs/:id/files", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, null, async (db) => {
      await authorize(req, db, id);
      return (await db.query(
        `select id, kind, file_name as "fileName", content_type as "contentType", size_bytes as "sizeBytes", duration_seconds as "durationSeconds", created_at as "createdAt" from subcontract_job_files where job_id = $1 order by created_at desc`,
        [id],
      )).rows;
    });
  });

  app.post("/api/subcontract-jobs/:id/files", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(JobFileInput, req.body);
    return tenant(req, null, async (db, actor) => {
      await authorize(req, db, id);
      if ("stagedUploadId" in input) {
        // Video gibi büyük dosyalar önce POST /api/attachments/video/stage ile yüklenip doğrulanmıştı;
        // burada yalnızca bu şirkette, bu kullanıcının yaptığı ve henüz kullanılmamış yükleme kabul edilir.
        const staged = (
          await db.query(
            `select file_name as "fileName", content_type as "contentType", size_bytes as "sizeBytes", duration_seconds as "durationSeconds",
                    sha256, object_key as "objectKey", storage_backend as "storageBackend"
               from staged_uploads where id = $1 and uploaded_by = $2 and consumed_at is null`,
            [input.stagedUploadId, actor.userId],
          )
        ).rows[0];
        if (!staged) throw conflict("staged_upload_not_found", "Yüklenmiş video bulunamadı veya zaten kullanılmış");
        const r = await db.query(
          `insert into subcontract_job_files (company_id, job_id, kind, file_name, content_type, size_bytes, sha256, object_key, storage_backend, duration_seconds, uploaded_by)
           values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id, created_at as "createdAt"`,
          [id, input.kind, staged.fileName, staged.contentType, staged.sizeBytes, staged.sha256, staged.objectKey, staged.storageBackend, staged.durationSeconds, actor.userId],
        );
        await db.query(`update staged_uploads set consumed_at = now() where id = $1`, [input.stagedUploadId]);
        await recordEvent(db, actor, { entityType: "subcontract_job", entityId: id, eventType: "file.uploaded", after: { kind: input.kind, fileName: staged.fileName } });
        return { id: r.rows[0].id, kind: input.kind, fileName: staged.fileName, contentType: staged.contentType, sizeBytes: staged.sizeBytes, durationSeconds: staged.durationSeconds, createdAt: r.rows[0].createdAt };
      }
      const buf = Buffer.from(input.contentBase64, "base64");
      if (buf.length === 0 || buf.length > MAX_FILE_BYTES) throw badRequest(`Dosya boyutu 0 ile ${MAX_FILE_BYTES} bayt arasında olmalı`);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const r = await db.query(
        `insert into subcontract_job_files (company_id, job_id, kind, file_name, content_type, size_bytes, sha256, content, uploaded_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id, created_at as "createdAt"`,
        [id, input.kind, input.fileName, input.contentType, buf.length, sha256, buf, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "subcontract_job", entityId: id, eventType: "file.uploaded", after: { kind: input.kind, fileName: input.fileName } });
      return { id: r.rows[0].id, kind: input.kind, fileName: input.fileName, contentType: input.contentType, sizeBytes: buf.length, createdAt: r.rows[0].createdAt };
    });
  });

  app.get("/api/subcontract-jobs/:id/files/:fileId", async (req, reply) => {
    const { id, fileId } = req.params as { id: string; fileId: string };
    return tenant(req, null, async (db) => {
      await authorize(req, db, id);
      const r = await db.query(`select file_name, content_type, content, object_key as "objectKey", storage_backend as "storageBackend" from subcontract_job_files where id = $1 and job_id = $2`, [fileId, id]);
      if (!r.rows[0]) throw notFound("Dosya");
      const body = r.rows[0].objectKey ? await storageFor(r.rows[0].storageBackend).get(r.rows[0].objectKey) : r.rows[0].content;
      reply.header("content-type", r.rows[0].content_type).header("content-disposition", `inline; filename="${r.rows[0].file_name.replace(/"/g, "")}"`);
      return body;
    });
  });
}

export { KIND_TR };
