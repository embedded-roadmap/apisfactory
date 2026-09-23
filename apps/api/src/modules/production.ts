import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../lib/errors";
import { closeTasks, idempotent, nextCode, openTask, recordEvent, type Actor } from "../lib/records";
import { fromMicro, min, mul, toMicro } from "../lib/decimal";
import { idempotencyKey, parse, tenant } from "../http/context";

/** Varsayılan rota. Yayımda iş emrine kopyalanır; sonradan rota değişikliği açık işi etkilemez. */
const DEFAULT_ROUTE: { wc: string; name: string; gate?: boolean }[] = [
  { wc: "HAZ", name: "Malzeme hazırlama" },
  { wc: "SMT", name: "Dizgi (SMT)" },
  { wc: "LEH", name: "Lehim / THT" },
  { wc: "PRG", name: "Programlama" },
  { wc: "TST", name: "Fonksiyon testi", gate: true },
  { wc: "MON", name: "Mekanik montaj" },
];

type WoRow = { id: string; code: string; status: string; qty: string; bom_version_id: string; product_revision_id: string; production_need_id: string | null };

async function lockWo(db: Db, id: string): Promise<WoRow> {
  const r = await db.query(`select * from work_orders where id = $1 for update`, [id]);
  if (!r.rows[0]) throw notFound("İş emri");
  return r.rows[0];
}

/** İş emrinin malzeme ihtiyacı (DNP hariç) ve çıkılan miktar. */
async function materialStatus(db: Db, wo: WoRow) {
  const r = await db.query(
    `select bl.item_id, i.code, i.name, i.mpn, sum(bl.qty_per) as qty_per,
            coalesce((select sum(mi.qty) from material_issues mi where mi.work_order_id = $2 and mi.item_id = bl.item_id), 0) as issued
       from bom_lines bl join items i on i.id = bl.item_id
      where bl.bom_version_id = $1 and not bl.dnp
      group by bl.item_id, i.code, i.name, i.mpn order by i.code`,
    [wo.bom_version_id, wo.id],
  );
  const qty = toMicro(wo.qty);
  return r.rows.map((m) => {
    const required = mul(qty, toMicro(m.qty_per));
    const issued = toMicro(m.issued);
    return {
      itemId: m.item_id as string,
      itemCode: m.code as string,
      itemName: m.name as string,
      mpn: m.mpn as string | null,
      required: fromMicro(required),
      issued: fromMicro(issued),
      remaining: fromMicro(required - issued > 0n ? required - issued : 0n),
      complete: issued >= required,
    };
  });
}

async function deviceStats(db: Db, woId: string) {
  const r = await db.query(
    `select
       count(*)::int as total,
       count(*) filter (where status = 'in_process')::int as in_process,
       count(*) filter (where status = 'test_failed')::int as test_failed,
       count(*) filter (where status = 'rework')::int as rework,
       count(*) filter (where status = 'passed')::int as passed,
       count(*) filter (where status = 'scrapped')::int as scrapped,
       count(*) filter (where status in ('released', 'shipped'))::int as released,
       count(*) filter (where exists (select 1 from test_runs t where t.device_id = d.id and t.run_no = 1))::int as first_tested,
       count(*) filter (where exists (select 1 from test_runs t where t.device_id = d.id and t.run_no = 1 and t.result = 'pass'))::int as first_passed,
       count(*) filter (where exists (select 1 from nonconformances n where n.device_id = d.id and n.decision = 'rework'))::int as reworked
     from devices d where d.work_order_id = $1`,
    [woId],
  );
  const x = r.rows[0];
  return {
    ...x,
    // İlk testte başarı: ilk testinde geçen / ilk test uygulanmış benzersiz cihaz. Tekrar test oranı yükseltmez (T09).
    firstPassYield: x.first_tested > 0 ? Number((x.first_passed / x.first_tested).toFixed(4)) : null,
  };
}

export async function loadWorkOrder(db: Db, id: string) {
  const w = await db.query(
    `select w.id, w.code, w.status, w.qty, w.due_date as "dueDate", w.bom_version_id as "bomVersionId", w.product_revision_id as "productRevisionId",
            w.production_need_id as "productionNeedId", w.released_at as "releasedAt", w.completed_at as "completedAt",
            p.code as "productCode", p.name as "productName", pr.rev, b.version_no as "bomVersionNo",
            so.code as "salesOrderCode"
       from work_orders w join product_revisions pr on pr.id = w.product_revision_id join products p on p.id = pr.product_id
       join bom_versions b on b.id = w.bom_version_id
       left join production_needs pn on pn.id = w.production_need_id
       left join sales_order_lines sol on sol.id = pn.sales_order_line_id
       left join sales_orders so on so.id = sol.order_id
      where w.id = $1`,
    [id],
  );
  if (!w.rows[0]) throw notFound("İş emri");
  const ops = await db.query(
    `select o.id, o.seq, o.name, o.status, o.is_quality_gate as "isQualityGate", o.started_at as "startedAt", o.finished_at as "finishedAt",
            o.worked_seconds as "workedSeconds", wc.code as "workCenter"
       from work_order_operations o left join work_centers wc on wc.id = o.work_center_id
      where o.work_order_id = $1 order by o.seq`,
    [id],
  );
  const devices = await db.query(
    `select d.serial, d.status,
            (select json_agg(json_build_object('runNo', t.run_no, 'result', t.result, 'at', t.created_at) order by t.run_no) from test_runs t where t.device_id = d.id) as runs
       from devices d where d.work_order_id = $1 order by d.serial`,
    [id],
  );
  const wo = (await db.query(`select * from work_orders where id = $1`, [id])).rows[0] as WoRow;
  return { ...w.rows[0], operations: ops.rows, materials: await materialStatus(db, wo), devices: devices.rows, stats: await deviceStats(db, id) };
}

async function setWoStatus(db: Db, actor: Actor, wo: WoRow, to: string, reason?: string) {
  await db.query(
    `update work_orders set status = $2,
            released_at = case when $2 = 'released' then now() else released_at end,
            completed_at = case when $2 = 'completed' then now() else completed_at end
      where id = $1`,
    [wo.id, to],
  );
  await recordEvent(db, actor, { entityType: "work_order", entityId: wo.id, eventType: `status.${to}`, before: { status: wo.status }, after: { status: to }, reason });
}

async function locationId(db: Db, type: string) {
  const r = await db.query(`select id from locations where type = $1 order by code limit 1`, [type]);
  if (!r.rows[0]) throw conflict("location_missing", `"${type}" tipinde konum tanımlı değil`);
  return r.rows[0].id as string;
}

export async function productionRoutes(app: FastifyInstance) {
  app.get("/api/production-needs", async (req) =>
    tenant(req, "production.view", async (db) => {
      const r = await db.query(
        `select pn.id, pn.qty, pn.status, pn.created_at as "createdAt", p.code as "productCode", pr.rev, so.code as "salesOrderCode", so.requested_date as "requestedDate",
                w.id as "workOrderId", w.code as "workOrderCode"
           from production_needs pn join product_revisions pr on pr.id = pn.product_revision_id join products p on p.id = pr.product_id
           join sales_order_lines sol on sol.id = pn.sales_order_line_id join sales_orders so on so.id = sol.order_id
           left join work_orders w on w.production_need_id = pn.id
          order by pn.created_at desc limit 200`,
      );
      return r.rows;
    }),
  );

  app.get("/api/work-orders", async (req) =>
    tenant(req, "production.view", async (db) => {
      const r = await db.query(
        `select w.id, w.code, w.status, w.qty, w.due_date as "dueDate", p.code as "productCode", pr.rev,
                (select count(*) from devices d where d.work_order_id = w.id and d.status in ('released','shipped'))::int as released,
                (select count(*) from devices d where d.work_order_id = w.id and d.status = 'scrapped')::int as scrapped
           from work_orders w join product_revisions pr on pr.id = w.product_revision_id join products p on p.id = pr.product_id
          order by w.created_at desc limit 200`,
      );
      return r.rows;
    }),
  );

  app.get("/api/work-orders/:id", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "production.view", (db) => loadWorkOrder(db, id));
  });

  /** İş emri: yalnızca yayımlanmış revizyon için; BOM sürümü revizyondan sabitlenir. */
  app.post("/api/work-orders", async (req) => {
    const input = parse(
      z.object({ productionNeedId: z.string().uuid().optional(), productRevisionId: z.string().uuid().optional(), qty: z.string().regex(/^\d+$/).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
      req.body,
    );
    return tenant(req, "production.plan", async (db, actor) => {
      let revisionId = input.productRevisionId;
      let qty = input.qty;
      let bomVersionId: string | null = null;
      if (input.productionNeedId) {
        const n = await db.query(`select * from production_needs where id = $1 for update`, [input.productionNeedId]);
        const need = n.rows[0];
        if (!need) throw notFound("Üretim ihtiyacı");
        if (need.status !== "planned") throw conflict("invalid_transition", `Üretim ihtiyacı "${need.status}" durumunda`);
        revisionId = need.product_revision_id;
        bomVersionId = need.bom_version_id;
        qty = String(Math.ceil(Number(need.qty)));
      }
      if (!revisionId || !qty) throw badRequest("Üretim ihtiyacı veya revizyon + miktar gerekli");
      const rev = await db.query(`select status, bom_version_id from product_revisions where id = $1`, [revisionId]);
      if (!rev.rows[0]) throw notFound("Revizyon");
      if (rev.rows[0].status !== "released") throw conflict("product_not_released", "Yayımlanmamış revizyon için seri üretim iş emri açılamaz");
      bomVersionId ??= rev.rows[0].bom_version_id;
      const code = await nextCode(db, actor.companyId, "work_order", "IE");
      const w = await db.query(
        `insert into work_orders (company_id, code, production_need_id, product_revision_id, bom_version_id, qty, due_date, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [code, input.productionNeedId ?? null, revisionId, bomVersionId, qty, input.dueDate ?? null, actor.userId],
      );
      if (input.productionNeedId) {
        await db.query(`update production_needs set status = 'released' where id = $1`, [input.productionNeedId]);
        await closeTasks(db, actor.companyId, "production_planning", input.productionNeedId);
      }
      for (const [i, op] of DEFAULT_ROUTE.entries()) {
        await db.query(
          `insert into work_order_operations (company_id, work_order_id, seq, name, work_center_id, is_quality_gate)
           values (app_company_id(), $1, $2, $3, (select id from work_centers where code = $4), $5)`,
          [w.rows[0].id, (i + 1) * 10, op.name, op.wc, !!op.gate],
        );
      }
      await recordEvent(db, actor, { entityType: "work_order", entityId: w.rows[0].id, eventType: "created", after: { code, qty, revisionId, bomVersionId } });
      return loadWorkOrder(db, w.rows[0].id);
    });
  });

  /** Yayım: seri numaraları üretilir, depoya malzeme hazırlama ve teknisyene iş görevleri açılır. */
  app.post("/api/work-orders/:id/release", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "production.plan", async (db, actor) => {
      const wo = await lockWo(db, id);
      if (wo.status !== "planned") throw conflict("invalid_transition", "Yalnızca planlanmış iş emri yayımlanabilir");
      const n = Number(wo.qty);
      if (n > 10000) throw badRequest("Tek iş emrinde en fazla 10.000 seri üretilebilir");
      await db.query(
        `insert into devices (company_id, serial, work_order_id, product_revision_id)
         select app_company_id(), $2 || '-' || lpad(g::text, 5, '0'), $1, $3 from generate_series(1, $4::int) g`,
        [id, wo.code, wo.product_revision_id, n],
      );
      await setWoStatus(db, actor, wo, "released");
      await openTask(db, actor.companyId, { kind: "material_issue", title: `Malzeme hazırla — ${wo.code}`, entityType: "work_order", entityId: id, assigneeRole: "warehouse" });
      await openTask(db, actor.companyId, { kind: "work_order_execution", title: `Üretim — ${wo.code} × ${n}`, entityType: "work_order", entityId: id, assigneeRole: "technician" });
      return loadWorkOrder(db, id);
    });
  });

  /**
   * Malzeme çıkışı: yalnızca iş emrinin sabitlenmiş BOM'undaki kalem, yalnızca kullanılabilir konumdaki lot,
   * ihtiyaç kadar. Karantina / giriş kontrolündeki malzeme çıkılamaz (prompt §4). Yanlış parça yakalanır (T12).
   */
  app.post("/api/work-orders/:id/issue", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ lotId: z.string().uuid(), qty: z.string().regex(/^\d+(\.\d+)?$/) }), req.body);
    return tenant(req, "inventory.issue", (db, actor) =>
      idempotent(db, actor.companyId, "wo_issue", idempotencyKey(req), async () => {
        const wo = await lockWo(db, id);
        if (!["released", "in_progress"].includes(wo.status)) throw conflict("invalid_transition", "Malzeme yalnızca yayımlanmış veya işlemdeki iş emrine çıkılır");
        const lot = await db.query(`select l.id, l.item_id, l.lot_no, i.code from lots l join items i on i.id = l.item_id where l.id = $1 for update of l`, [input.lotId]);
        if (!lot.rows[0]) throw notFound("Lot");
        const itemId = lot.rows[0].item_id as string;
        const mats = await materialStatus(db, wo);
        const need = mats.find((m) => m.itemId === itemId);
        if (!need) throw conflict("wrong_part", `${lot.rows[0].code} bu iş emrinin BOM sürümünde yok; yanlış parça`, { lotNo: lot.rows[0].lot_no });
        const qty = toMicro(input.qty);
        if (qty > toMicro(need.remaining)) throw conflict("over_issue", `Kalan ihtiyaç ${need.remaining}; fazla çıkış yapılamaz`);
        const src = await db.query(
          `select b.location_id, b.qty from stock_balances b join locations loc on loc.id = b.location_id
            where b.lot_id = $1 and loc.type = 'stock' order by b.qty desc limit 1`,
          [input.lotId],
        );
        if (!src.rows[0] || toMicro(src.rows[0].qty) < qty) {
          throw conflict("lot_not_usable", "Lot kullanılabilir stokta yeterli değil (giriş kontrolü veya karantinadaki malzeme üretime çıkılamaz)");
        }
        // Başka işe ayrılmış miktar bu işe çıkılamaz: kullanılabilir stok − diğer taleplerin aktif rezervasyonu.
        await db.query(`select id from items where id = $1 for update`, [itemId]);
        const free = await db.query(
          `select coalesce((select sum(b.qty) from stock_balances b join locations loc on loc.id = b.location_id where b.item_id = $1 and loc.type = 'stock'), 0) as usable,
                  coalesce((select sum(qty) from reservations where item_id = $1 and status = 'active'
                              and not (demand_type = 'production_need' and demand_id is not distinct from $2::uuid)), 0) as others`,
          [itemId, wo.production_need_id],
        );
        const freeForThis = toMicro(free.rows[0].usable) - toMicro(free.rows[0].others);
        if (qty > freeForThis) {
          throw conflict("reserved_for_other", `Bu kalemden bu işe çıkılabilecek serbest miktar ${fromMicro(freeForThis > 0n ? freeForThis : 0n)}; kalanı başka işlere ayrılmış`);
        }
        const prodLoc = await locationId(db, "production");
        await db.query(
          `insert into stock_moves (company_id, item_id, lot_id, from_location_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
           values (app_company_id(), $1, $2, $3, $4, $5, 'issue', 'work_order', $6, $7)`,
          [itemId, input.lotId, src.rows[0].location_id, prodLoc, fromMicro(qty), id, actor.userId],
        );
        await db.query(`insert into material_issues (company_id, work_order_id, item_id, lot_id, qty, issued_by) values (app_company_id(), $1, $2, $3, $4, $5)`, [
          id,
          itemId,
          input.lotId,
          fromMicro(qty),
          actor.userId,
        ]);
        // Bu iş için ayrılmış rezervasyon tüketilir (aynı miktar iki kez sayılmaz).
        if (wo.production_need_id) {
          let rest = qty;
          const res = await db.query(
            `select id, qty from reservations where demand_type = 'production_need' and demand_id = $1 and item_id = $2 and status = 'active' order by created_at for update`,
            [wo.production_need_id, itemId],
          );
          for (const r of res.rows) {
            if (rest <= 0n) break;
            const take = min(rest, toMicro(r.qty));
            const left = toMicro(r.qty) - take;
            if (left === 0n) await db.query(`update reservations set status = 'consumed' where id = $1`, [r.id]);
            else await db.query(`update reservations set qty = $2 where id = $1`, [r.id, fromMicro(left)]);
            rest -= take;
          }
        }
        await recordEvent(db, actor, { entityType: "work_order", entityId: id, eventType: "material.issued", after: { itemId, lotId: input.lotId, lotNo: lot.rows[0].lot_no, qty: fromMicro(qty) } });
        const after = await materialStatus(db, wo);
        if (after.every((m) => m.complete)) await closeTasks(db, actor.companyId, "material_issue", id);
        return { workOrderId: id, materials: after };
      }),
    );
  });

  /** Operasyon eylemleri. Sıra atlanamaz; malzeme uzlaşması ve kalite kapısı tamamlanmadan ilerlenemez. */
  app.post("/api/work-orders/:id/operations/:opId/:action", async (req) => {
    const { id, opId, action } = req.params as { id: string; opId: string; action: string };
    if (!["start", "pause", "complete"].includes(action)) throw badRequest("Geçersiz eylem");
    const body = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    return tenant(req, "production.execute", async (db, actor) => {
      const wo = await lockWo(db, id);
      if (!["released", "in_progress"].includes(wo.status)) throw conflict("invalid_transition", `İş emri "${wo.status}" durumunda`);
      const r = await db.query(`select * from work_order_operations where id = $1 and work_order_id = $2 for update`, [opId, id]);
      const op = r.rows[0];
      if (!op) throw notFound("Operasyon");
      const prev = await db.query(`select count(*)::int as n from work_order_operations where work_order_id = $1 and seq < $2 and status <> 'done'`, [id, op.seq]);

      if (action === "start") {
        if (prev.rows[0].n > 0) throw conflict("sequence", "Önceki operasyonlar tamamlanmadan bu operasyon başlatılamaz");
        if (!["pending", "paused"].includes(op.status)) throw conflict("invalid_transition", `Operasyon "${op.status}" durumunda`);
        await db.query(`update work_order_operations set status = 'in_progress', started_at = coalesce(started_at, now()), last_started_at = now() where id = $1`, [opId]);
        if (wo.status === "released") await setWoStatus(db, actor, wo, "in_progress");
      } else if (action === "pause") {
        if (op.status !== "in_progress") throw conflict("invalid_transition", "Yalnızca işlemdeki operasyon duraklatılır");
        if (!body.reason) throw conflict("reason_required", "Duraklatma nedeni zorunlu (malzeme, ekipman, kalite, personel, dış bağımlılık)");
        await db.query(
          `update work_order_operations set status = 'paused', worked_seconds = worked_seconds + extract(epoch from now() - last_started_at)::int, last_started_at = null where id = $1`,
          [opId],
        );
      } else {
        if (op.status !== "in_progress") throw conflict("invalid_transition", "Yalnızca işlemdeki operasyon tamamlanır");
        if (op.seq === 10) {
          const mats = await materialStatus(db, wo);
          const missing = mats.filter((m) => !m.complete);
          if (missing.length) throw conflict("materials_incomplete", "Malzeme çıkışı tamamlanmadan hazırlık kapatılamaz", { missing: missing.map((m) => ({ item: m.itemCode, remaining: m.remaining })) });
        }
        if (op.is_quality_gate) {
          const open = await db.query(
            `select count(*)::int as n from devices where work_order_id = $1 and status in ('in_process', 'test_failed', 'rework')`,
            [id],
          );
          if (open.rows[0].n > 0) throw conflict("quality_gate", `${open.rows[0].n} cihazın testi veya kalite kararı tamamlanmadı; kalite kapısı atlanamaz`);
        }
        await db.query(
          `update work_order_operations set status = 'done', finished_at = now(), worked_seconds = worked_seconds + extract(epoch from now() - last_started_at)::int, last_started_at = null where id = $1`,
          [opId],
        );
      }
      await recordEvent(db, actor, { entityType: "work_order", entityId: id, eventType: `operation.${action}`, after: { seq: op.seq, name: op.name }, reason: body.reason });
      return loadWorkOrder(db, id);
    });
  });

  /**
   * Test sonucu: test operasyonu işlemdeyken kaydedilir. Ölçüm değerleri saklanır, istasyon çalışma kimliğiyle tekrarlar ayıklanır.
   * Başarısız test uygunsuzluk açar; ilk test sonucu hiçbir zaman değişmez (T09).
   */
  app.post("/api/devices/:serial/test", async (req) => {
    const { serial } = req.params as { serial: string };
    const input = parse(
      z.object({
        result: z.enum(["pass", "fail"]),
        measurements: z.array(z.object({ name: z.string(), value: z.number(), unit: z.string().optional(), low: z.number().optional(), high: z.number().optional() })).default([]),
        station: z.string().max(80).optional(),
        firmwareVersion: z.string().max(80).optional(),
        externalRunId: z.string().max(120).optional(),
      }),
      req.body,
    );
    return tenant(req, "production.test.record", async (db, actor) => {
      const d = await db.query(`select * from devices where serial = $1 for update`, [serial]);
      const dev = d.rows[0];
      if (!dev) throw notFound("Cihaz");
      if (input.externalRunId) {
        const dup = await db.query(`select id, run_no, result from test_runs where external_run_id = $1`, [input.externalRunId]);
        if (dup.rows[0]) return { serial, duplicate: true, runNo: dup.rows[0].run_no, result: dup.rows[0].result, status: dev.status };
      }
      if (!["in_process", "rework"].includes(dev.status)) throw conflict("invalid_transition", `Cihaz "${dev.status}" durumunda; test kaydı alınamaz`);
      const gate = await db.query(
        `select status from work_order_operations where work_order_id = $1 and is_quality_gate order by seq limit 1`,
        [dev.work_order_id],
      );
      if (gate.rows[0]?.status !== "in_progress") throw conflict("sequence", "Test operasyonu işlemde değil");
      // Ölçüm limit dışıysa "geçti" kabul edilmez: kayıt çelişkiliyse reddedilir.
      const outOfLimit = input.measurements.filter((m) => (m.low !== undefined && m.value < m.low) || (m.high !== undefined && m.value > m.high));
      if (input.result === "pass" && outOfLimit.length) throw conflict("measurement_out_of_limit", "Limit dışı ölçümle geçti sonucu kaydedilemez", { measurements: outOfLimit.map((m) => m.name) });
      const runNo = (await db.query(`select coalesce(max(run_no), 0) + 1 as n from test_runs where device_id = $1`, [dev.id])).rows[0].n;
      const tr = await db.query(
        `insert into test_runs (company_id, device_id, run_no, external_run_id, result, measurements, station, firmware_version, operator_id)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [dev.id, runNo, input.externalRunId ?? null, input.result, JSON.stringify(input.measurements), input.station ?? null, input.firmwareVersion ?? null, actor.userId],
      );
      const next = input.result === "pass" ? "passed" : "test_failed";
      await db.query(`update devices set status = $2 where id = $1`, [dev.id, next]);
      if (input.result === "fail") {
        await db.query(`insert into nonconformances (company_id, device_id, test_run_id) values (app_company_id(), $1, $2)`, [dev.id, tr.rows[0].id]);
        await openTask(db, actor.companyId, { kind: "device_disposition", title: `Test başarısız — ${serial}: yeniden işleme / hurda kararı`, entityType: "device", entityId: dev.id, assigneeRole: "quality" });
      }
      await recordEvent(db, actor, { entityType: "device", entityId: dev.id, eventType: `test.${input.result}`, after: { serial, runNo, station: input.station, measurements: input.measurements } });
      return { serial, duplicate: false, runNo, result: input.result, status: next };
    });
  });

  /** Başarısız cihaz için kalite kararı: yeniden işleme (tekrar test gerekir) veya hurda. Gerekçe zorunlu. */
  app.post("/api/devices/:serial/disposition", async (req) => {
    const { serial } = req.params as { serial: string };
    const input = parse(z.object({ decision: z.enum(["rework", "scrap"]), note: z.string().min(3).max(1000) }), req.body);
    return tenant(req, "quality.final.release", async (db, actor) => {
      const d = await db.query(`select * from devices where serial = $1 for update`, [serial]);
      const dev = d.rows[0];
      if (!dev) throw notFound("Cihaz");
      if (dev.status !== "test_failed") throw conflict("invalid_transition", "Karar yalnızca testi başarısız cihaz için verilir");
      await db.query(
        `update nonconformances set decision = $2, note = $3, decided_by = $4, decided_at = now()
          where id = (select id from nonconformances where device_id = $1 and decision is null order by created_at desc limit 1)`,
        [dev.id, input.decision, input.note, actor.userId],
      );
      const next = input.decision === "rework" ? "rework" : "scrapped";
      await db.query(`update devices set status = $2 where id = $1`, [dev.id, next]);
      await closeTasks(db, actor.companyId, "device_disposition", dev.id);
      await recordEvent(db, actor, { entityType: "device", entityId: dev.id, eventType: `disposition.${input.decision}`, after: { serial }, reason: input.note });
      return { serial, status: next };
    });
  });

  /**
   * Son kalite serbest bırakma: testi geçen cihazlar bitmiş ürün lotuna girer (revizyonla).
   * İş emri bir satış satırından geliyorsa serbest bırakılan miktar o satıra rezerve edilir.
   */
  app.post("/api/work-orders/:id/release-to-stock", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "quality.final.release", async (db, actor) => {
      const wo = await lockWo(db, id);
      if (!["in_progress"].includes(wo.status)) throw conflict("invalid_transition", "Yalnızca işlemdeki iş emri için serbest bırakma yapılır");
      const gate = await db.query(`select status from work_order_operations where work_order_id = $1 and is_quality_gate order by seq limit 1`, [id]);
      if (gate.rows[0]?.status !== "done") throw conflict("quality_gate", "Fonksiyon testi kalite kapısı tamamlanmadan serbest bırakma yapılamaz");
      const passed = await db.query(`select id from devices where work_order_id = $1 and status = 'passed' for update`, [id]);
      if (passed.rowCount === 0) throw conflict("nothing_to_release", "Serbest bırakılacak testten geçmiş cihaz yok");
      const item = await db.query(`select p.item_id from product_revisions pr join products p on p.id = pr.product_id where pr.id = $1`, [wo.product_revision_id]);
      const lot = await db.query(
        `insert into lots (company_id, item_id, lot_no, product_revision_id) values (app_company_id(), $1, $2, $3)
         on conflict (company_id, item_id, lot_no) do update set lot_no = excluded.lot_no returning id`,
        [item.rows[0].item_id, wo.code, wo.product_revision_id],
      );
      const count = String(passed.rowCount);
      const finished = await locationId(db, "finished");
      await db.query(
        `insert into stock_moves (company_id, item_id, lot_id, to_location_id, qty, move_type, ref_type, ref_id, created_by)
         values (app_company_id(), $1, $2, $3, $4, 'produce', 'work_order', $5, $6)`,
        [item.rows[0].item_id, lot.rows[0].id, finished, count, id, actor.userId],
      );
      await db.query(`update devices set status = 'released', finished_lot_id = $2 where work_order_id = $1 and status = 'passed'`, [id, lot.rows[0].id]);
      if (wo.production_need_id) {
        const line = await db.query(`select sales_order_line_id from production_needs where id = $1`, [wo.production_need_id]);
        await db.query(
          `insert into reservations (company_id, item_id, lot_id, qty, demand_type, demand_id) values (app_company_id(), $1, $2, $3, 'sales_order_line', $4)`,
          [item.rows[0].item_id, lot.rows[0].id, count, line.rows[0].sales_order_line_id],
        );
      }
      await recordEvent(db, actor, { entityType: "work_order", entityId: id, eventType: "released_to_stock", after: { qty: count, lotNo: wo.code } });
      return loadWorkOrder(db, id);
    });
  });

  /** Kapanış: bütün operasyonlar ve cihazlar uzlaşmadan kapanmaz. Çıkılan malzeme tüketim hareketiyle düşülür. */
  app.post("/api/work-orders/:id/complete", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "production.plan", async (db, actor) => {
      const wo = await lockWo(db, id);
      if (wo.status !== "in_progress") throw conflict("invalid_transition", "Yalnızca işlemdeki iş emri kapatılır");
      const ops = await db.query(`select count(*)::int as n from work_order_operations where work_order_id = $1 and status <> 'done'`, [id]);
      if (ops.rows[0].n) throw conflict("operations_open", `${ops.rows[0].n} operasyon tamamlanmadı`);
      const open = await db.query(`select count(*)::int as n from devices where work_order_id = $1 and status not in ('released', 'shipped', 'scrapped')`, [id]);
      if (open.rows[0].n) throw conflict("devices_open", `${open.rows[0].n} cihaz serbest bırakılmadı veya hurdaya ayrılmadı`);
      const prodLoc = await locationId(db, "production");
      const issued = await db.query(`select item_id, lot_id, sum(qty) as qty from material_issues where work_order_id = $1 group by item_id, lot_id`, [id]);
      for (const m of issued.rows) {
        await db.query(
          `insert into stock_moves (company_id, item_id, lot_id, from_location_id, qty, move_type, ref_type, ref_id, created_by)
           values (app_company_id(), $1, $2, $3, $4, 'consume', 'work_order', $5, $6)`,
          [m.item_id, m.lot_id, prodLoc, m.qty, id, actor.userId],
        );
      }
      await setWoStatus(db, actor, wo, "completed");
      if (wo.production_need_id) await db.query(`update production_needs set status = 'done' where id = $1`, [wo.production_need_id]);
      await closeTasks(db, actor.companyId, "work_order_execution", id);
      return loadWorkOrder(db, id);
    });
  });

  /** Cihaz geçmişi: seri → revizyon, BOM sürümü, gerçek lotlar, testler, sevkiyat (prompt §22). */
  app.get("/api/devices/:serial", async (req) => {
    const { serial } = req.params as { serial: string };
    return tenant(req, "production.view", async (db) => {
      const d = await db.query(
        `select d.id, d.serial, d.status, w.code as "workOrderCode", w.id as "workOrderId", pr.rev, p.code as "productCode", b.version_no as "bomVersionNo", fl.lot_no as "finishedLotNo"
           from devices d join work_orders w on w.id = d.work_order_id join product_revisions pr on pr.id = d.product_revision_id
           join products p on p.id = pr.product_id join bom_versions b on b.id = w.bom_version_id left join lots fl on fl.id = d.finished_lot_id
          where d.serial = $1`,
        [serial],
      );
      if (!d.rows[0]) throw notFound("Cihaz");
      const runs = await db.query(
        `select t.run_no as "runNo", t.result, t.measurements, t.station, t.firmware_version as "firmwareVersion", u.name as operator, t.created_at as "createdAt"
           from test_runs t left join users u on u.id = t.operator_id where t.device_id = $1 order by t.run_no`,
        [d.rows[0].id],
      );
      const lots = await db.query(
        `select i.code as "itemCode", i.mpn, l.lot_no as "lotNo", sum(mi.qty) as qty
           from material_issues mi join items i on i.id = mi.item_id join lots l on l.id = mi.lot_id
          where mi.work_order_id = $1 group by i.code, i.mpn, l.lot_no order by i.code`,
        [d.rows[0].workOrderId],
      );
      return { ...d.rows[0], testRuns: runs.rows, materialLots: lots.rows };
    });
  });
}
