import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conflict, notFound } from "../lib/errors";
import { recordEvent } from "../lib/records";
import { parse, tenant } from "../http/context";
import { addDays, HORIZON_DAYS, loadCapacityCalendar, shiftMinutes } from "../lib/capacity";

/**
 * R29 — kaynak kapasitesi ve vardiya (oturum 41, kalan işler 7c).
 *  - Vardiya şablonu: saat aralığı, mola, haftanın günleri (gece yarısını geçebilir).
 *  - İş merkezine tarih aralıklı atama (paralel istasyon sayısıyla); atama silinmez, bitiş tarihiyle sonlanır.
 *  - Kapasite istisnası: tarihli fazla mesai (+) / bakım-arıza (−), gerekçeli ve değişmez.
 *  - Kaynak yükü: açık iş emri operasyonlarının kalan süresi, bugünden itibaren kapasite takvimine sonlu yükleme
 *    (teslim tarihi → oluşturma → operasyon sırası). Gerçekleşen geçmiş yük gösterilmez.
 * Termin ve senaryo hesapları aynı takvimi kullanır (lib/capacity.ts).
 */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function capacityRoutes(app: FastifyInstance) {
  app.get("/api/shift-patterns", async (req) =>
    tenant(req, "production.view", async (db) =>
      (await db.query(
        `select id, code, name, to_char(start_time, 'HH24:MI') as "startTime", to_char(end_time, 'HH24:MI') as "endTime",
                break_minutes as "breakMinutes", weekdays from shift_patterns order by code`,
      )).rows.map((s) => ({ ...s, netMinutes: shiftMinutes(s.startTime, s.endTime, s.breakMinutes) })),
    ),
  );

  app.post("/api/shift-patterns", async (req) => {
    const input = parse(
      z.object({
        code: z.string().regex(/^[A-Z0-9-]{1,20}$/),
        name: z.string().min(2).max(100),
        startTime: z.string().regex(TIME),
        endTime: z.string().regex(TIME),
        breakMinutes: z.number().int().min(0).max(600).default(0),
        weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
      }),
      req.body,
    );
    const net = shiftMinutes(input.startTime, input.endTime, input.breakMinutes);
    if (net <= 0) throw conflict("invalid_shift", "Mola vardiya süresinden uzun olamaz");
    return tenant(req, "capacity.manage", async (db, actor) => {
      const weekdays = [...new Set(input.weekdays)].sort();
      const r = await db.query(
        `insert into shift_patterns (company_id, code, name, start_time, end_time, break_minutes, weekdays, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [input.code, input.name, input.startTime, input.endTime, input.breakMinutes, weekdays, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "shift_pattern", entityId: r.rows[0].id, eventType: "created", after: { ...input, weekdays, netMinutes: net } });
      return { id: r.rows[0].id as string, netMinutes: net };
    });
  });

  app.get("/api/work-center-shifts", async (req) =>
    tenant(req, "production.view", async (db) =>
      (await db.query(
        `select a.id, wc.code as "workCenterCode", sp.code as "shiftCode", sp.name as "shiftName", a.stations,
                a.valid_from::text as "validFrom", a.valid_to::text as "validTo", a.reason, u.name as "createdBy", a.created_at as "createdAt"
           from work_center_shifts a join work_centers wc on wc.id = a.work_center_id join shift_patterns sp on sp.id = a.shift_pattern_id
           left join users u on u.id = a.created_by
          order by wc.code, a.valid_from desc`,
      )).rows,
    ),
  );

  /** Atama: aynı merkez + vardiya için çakışan açık atama olamaz (kapasite iki kez sayılmasın). */
  app.post("/api/work-center-shifts", async (req) => {
    const input = parse(
      z.object({
        workCenterCode: z.string().min(1),
        shiftPatternId: z.string().uuid(),
        stations: z.number().int().min(1).max(100).default(1),
        validFrom: z.string().regex(DATE),
        reason: z.string().min(3).max(500),
      }),
      req.body,
    );
    return tenant(req, "capacity.manage", async (db, actor) => {
      const wc = (await db.query(`select id from work_centers where code = $1 for update`, [input.workCenterCode])).rows[0];
      if (!wc) throw notFound("İş merkezi");
      const sp = await db.query(`select 1 from shift_patterns where id = $1`, [input.shiftPatternId]);
      if (!sp.rowCount) throw notFound("Vardiya");
      const overlap = await db.query(
        `select 1 from work_center_shifts where work_center_id = $1 and shift_pattern_id = $2 and (valid_to is null or valid_to >= $3)`,
        [wc.id, input.shiftPatternId, input.validFrom],
      );
      if (overlap.rowCount) throw conflict("overlapping_shift", "Bu vardiya bu iş merkezinde o tarihte zaten atanmış; önce mevcut atamayı sonlandırın");
      const r = await db.query(
        `insert into work_center_shifts (company_id, work_center_id, shift_pattern_id, stations, valid_from, reason, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6) returning id`,
        [wc.id, input.shiftPatternId, input.stations, input.validFrom, input.reason, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "work_center", entityId: wc.id, eventType: "shift.assigned", after: input, reason: input.reason });
      return { id: r.rows[0].id as string };
    });
  });

  app.post("/api/work-center-shifts/:id/end", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ validTo: z.string().regex(DATE), reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "capacity.manage", async (db, actor) => {
      const a = (await db.query(`select work_center_id, valid_from::text as "validFrom", valid_to from work_center_shifts where id = $1 for update`, [id])).rows[0];
      if (!a) throw notFound("Vardiya ataması");
      if (a.valid_to) throw conflict("already_ended", "Atama zaten sonlandırılmış");
      if (input.validTo < a.validFrom) throw conflict("invalid_range", "Bitiş, başlangıçtan önce olamaz");
      await db.query(`update work_center_shifts set valid_to = $2, ended_by = $3 where id = $1`, [id, input.validTo, actor.userId]);
      await recordEvent(db, actor, { entityType: "work_center", entityId: a.work_center_id, eventType: "shift.ended", after: { assignmentId: id, validTo: input.validTo }, reason: input.reason });
      return { id, validTo: input.validTo };
    });
  });

  app.get("/api/capacity-exceptions", async (req) => {
    const q = z.object({ from: z.string().regex(DATE).optional() }).parse(req.query);
    return tenant(req, "production.view", async (db) =>
      (await db.query(
        `select e.id, wc.code as "workCenterCode", e.day::text as day, e.minutes_delta as "minutesDelta", e.reason, u.name as "createdBy", e.created_at as "createdAt"
           from capacity_exceptions e left join work_centers wc on wc.id = e.work_center_id left join users u on u.id = e.created_by
          where e.day >= coalesce($1::date, current_date - 30) order by e.day, wc.code nulls first`,
        [q.from ?? null],
      )).rows,
    );
  });

  app.post("/api/capacity-exceptions", async (req) => {
    const input = parse(
      z.object({
        workCenterCode: z.string().min(1).optional(),
        day: z.string().regex(DATE),
        minutesDelta: z.number().int().min(-14400).max(14400).refine((v) => v !== 0, "Sıfır olamaz"),
        reason: z.string().min(3).max(500),
      }),
      req.body,
    );
    return tenant(req, "capacity.manage", async (db, actor) => {
      let wcId: string | null = null;
      if (input.workCenterCode) {
        const wc = (await db.query(`select id from work_centers where code = $1`, [input.workCenterCode])).rows[0];
        if (!wc) throw notFound("İş merkezi");
        wcId = wc.id;
      }
      const r = await db.query(
        `insert into capacity_exceptions (company_id, work_center_id, day, minutes_delta, reason, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5) returning id`,
        [wcId, input.day, input.minutesDelta, input.reason, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "capacity_exception", entityId: r.rows[0].id, eventType: "created", after: input, reason: input.reason });
      return { id: r.rows[0].id as string };
    });
  });

  /**
   * Kaynak yükü: bugünden başlayarak açık operasyonların kalan dakikası kapasite takvimine sıralı yüklenir; istenen
   * aralıktaki günler döner. Aşım: aralık sonuna kadar yüklenemeyen dakika (kapasite yetersiz).
   */
  app.get("/api/capacity/load", async (req) => {
    const q = z.object({ from: z.string().regex(DATE), to: z.string().regex(DATE) }).parse(req.query);
    return tenant(req, "production.view", async (db) => {
      const today = new Date().toISOString().slice(0, 10);
      const span = Math.round((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000) + 1;
      if (span < 1 || span > 120) throw conflict("invalid_range", "Aralık 1–120 gün olmalı");
      const cal = await loadCapacityCalendar(db);
      const wcs = (await db.query(`select code, name from work_centers order by code`)).rows;
      const ops = (await db.query(
        `select wc.code as wc, w.code as "woCode", w.id as "woId", w.due_date::text as "dueDate", op.seq, op.name,
                greatest(0, coalesce(op.planned_setup_minutes, wc.setup_minutes) + w.qty * coalesce(op.planned_minutes_per_unit, wc.minutes_per_unit)
                            - coalesce(op.worked_seconds, 0) / 60.0)::float8 as minutes
           from work_order_operations op join work_orders w on w.id = op.work_order_id join work_centers wc on wc.id = op.work_center_id
          where op.status <> 'done' and w.status in ('planned', 'released', 'in_progress', 'on_hold')
          order by w.due_date nulls last, w.created_at, op.seq`,
      )).rows;

      const days = Array.from({ length: span }, (_, i) => addDays(q.from, i));
      const loadEnd = q.to > today ? q.to : today;
      const out = [];
      for (const wc of wcs) {
        const list = ops.filter((o) => o.wc === wc.code && o.minutes > 0);
        const loaded = new Map<string, { minutes: number; items: { woCode: string; woId: string; op: string; minutes: number }[] }>();
        let day = today;
        let left = cal.on(wc.code, day);
        let overflow = 0;
        let lateOps = 0;
        for (const o of list) {
          let rem = o.minutes;
          let finish: string | null = null;
          for (let guard = 0; rem > 0.0001 && guard < HORIZON_DAYS; guard++) {
            if (day > loadEnd) break;
            if (left <= 0) {
              day = addDays(day, 1);
              left = cal.on(wc.code, day);
              continue;
            }
            const take = Math.min(left, rem);
            const slot = loaded.get(day) ?? { minutes: 0, items: [] };
            slot.minutes += take;
            slot.items.push({ woCode: o.woCode, woId: o.woId, op: `${o.seq}. ${o.name}`, minutes: Math.round(take) });
            loaded.set(day, slot);
            left -= take;
            rem -= take;
            finish = day;
          }
          if (rem > 0.0001) overflow += rem;
          if (o.dueDate && (finish === null || finish > o.dueDate)) lateOps++;
        }
        const row = days.map((d) => {
          const available = cal.on(wc.code, d);
          const l = loaded.get(d);
          return { day: d, available, load: Math.round(l?.minutes ?? 0), items: l?.items ?? [] };
        });
        const available = row.reduce((a, r) => a + r.available, 0);
        const load = row.reduce((a, r) => a + r.load, 0);
        out.push({
          code: wc.code, name: wc.name, source: cal.source(wc.code),
          openMinutes: Math.round(list.reduce((a, o) => a + o.minutes, 0)),
          available, load, utilization: available > 0 ? Number((load / available).toFixed(4)) : null,
          overflowMinutes: Math.round(overflow), lateOperations: lateOps, days: row,
        });
      }
      return {
        from: q.from, to: q.to, today, workCenters: out,
        notes: [
          "Yük, bugünden itibaren açık iş emri operasyonlarının kalan süresidir (planlı süre − kaydedilen çalışma); teslim tarihine göre sıralı, sonlu kapasiteyle yüklenir.",
          "Kapasite: vardiya ataması varsa vardiyalar × istasyon; yoksa hafta içi günlük dakika. Tatil 0; istisnalar eklenir/düşülür.",
          "Aşım: aralık sonuna kadar yüklenemeyen dakika. Geçmiş günlerde gerçekleşen yük gösterilmez.",
        ],
      };
    });
  });
}
