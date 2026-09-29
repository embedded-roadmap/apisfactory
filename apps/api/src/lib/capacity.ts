import type { Db } from "../db/pool";

/**
 * Kaynak kapasitesi takvimi (R29: "kaynak kapasitesi, vardiya").
 *
 * Bir iş merkezinin bir gündeki kapasitesi (dakika):
 *  - İş merkezine o gün geçerli vardiya ataması varsa: haftanın o gününü kapsayan her vardiya için
 *    (süre − mola) × paralel istasyon sayısı toplamı. Gece yarısını geçen vardiya başladığı güne sayılır.
 *  - Hiç vardiya ataması yoksa (geriye dönük uyum): hafta içi `work_centers.daily_minutes`, hafta sonu 0.
 *  - Şirket tatili: 0 (vardiya olsa da).
 *  - Kapasite istisnaları (fazla mesai +, bakım/arıza −) gün toplamına eklenir; sonuç 0'ın altına inmez.
 * Termin ve senaryo hesabı ile kaynak yükü görünümü bu takvimi ortak kullanır.
 */

export type ShiftRow = { minutes: number; weekdays: number[]; stations: number; validFrom: string; validTo: string | null };

export type CapacityCalendar = {
  /** İş merkezi kodu ve gün (YYYY-AA-GG) için dakika. */
  on(wcCode: string, day: string): number;
  /** Takvimin kaynağı: vardiya tanımı mı, varsayılan günlük dakika mı. */
  source(wcCode: string): "shifts" | "default";
  known(wcCode: string): boolean;
};

const parse = (s: string) => new Date(`${s}T00:00:00Z`);
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(s: string, n: number) {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
/** ISO hafta günü: 1 = Pazartesi … 7 = Pazar. */
export const isoWeekday = (s: string) => ((parse(s).getUTCDay() + 6) % 7) + 1;

/** "HH:MM[:SS]" başlangıç/bitiş ve mola → net dakika (gece yarısını geçen vardiya desteklenir). */
export function shiftMinutes(start: string, end: string, breakMinutes: number) {
  const m = (t: string) => {
    const [h = 0, mi = 0] = t.split(":").map(Number);
    return h * 60 + mi;
  };
  let span = m(end) - m(start);
  if (span <= 0) span += 24 * 60;
  return Math.max(0, span - breakMinutes);
}

export async function loadCapacityCalendar(db: Db): Promise<CapacityCalendar> {
  const wcs = (await db.query(`select id, code, daily_minutes from work_centers`)).rows as { id: string; code: string; daily_minutes: number }[];
  const holidays = new Set<string>((await db.query(`select day::text as day from holidays`)).rows.map((r) => r.day));
  const shifts = (await db.query(
    `select wc.code, sp.start_time::text as start, sp.end_time::text as "end", sp.break_minutes as brk, sp.weekdays,
            a.stations, a.valid_from::text as "validFrom", a.valid_to::text as "validTo"
       from work_center_shifts a join shift_patterns sp on sp.id = a.shift_pattern_id join work_centers wc on wc.id = a.work_center_id`,
  )).rows;
  const exceptions = (await db.query(
    `select wc.code, e.day::text as day, sum(e.minutes_delta)::int as delta
       from capacity_exceptions e left join work_centers wc on wc.id = e.work_center_id
      group by wc.code, e.day`,
  )).rows as { code: string | null; day: string; delta: number }[];

  const byWc = new Map<string, ShiftRow[]>();
  for (const s of shifts) {
    const list = byWc.get(s.code) ?? [];
    list.push({ minutes: shiftMinutes(s.start, s.end, s.brk), weekdays: s.weekdays, stations: s.stations, validFrom: s.validFrom, validTo: s.validTo });
    byWc.set(s.code, list);
  }
  const exc = new Map<string, number>(); // "kod|gün" ve "*|gün" (tüm merkezler)
  for (const e of exceptions) exc.set(`${e.code ?? "*"}|${e.day}`, (exc.get(`${e.code ?? "*"}|${e.day}`) ?? 0) + e.delta);
  const daily = new Map(wcs.map((w) => [w.code, Number(w.daily_minutes)]));

  return {
    known: (code) => daily.has(code),
    source: (code) => (byWc.has(code) ? "shifts" : "default"),
    on(code, day) {
      if (!daily.has(code) || holidays.has(day)) return 0;
      const wd = isoWeekday(day);
      let base: number;
      const list = byWc.get(code);
      if (list) {
        base = 0;
        for (const s of list) {
          if (s.validFrom > day || (s.validTo !== null && s.validTo < day)) continue;
          if (s.weekdays.includes(wd)) base += s.minutes * s.stations;
        }
      } else base = wd <= 5 ? daily.get(code)! : 0;
      return Math.max(0, base + (exc.get(`${code}|${day}`) ?? 0) + (exc.get(`*|${day}`) ?? 0));
    },
  };
}

/** Takvimde en fazla bu kadar gün ileri bakılır (kapasitesiz merkezde sonsuz döngüyü önler). */
export const HORIZON_DAYS = 730;

/**
 * `startDay`dan itibaren kapasiteli günlerde `minutes` tüketilir; biten günü ve kullanılan kapasiteli gün sayısını döner.
 * `minDays`: iş en az bu kadar kapasiteli gün sürer (sıfır dakikalık işte 1 gün). Ufuk içinde bitmezse null.
 */
export function consume(cal: CapacityCalendar, wcCode: string, startDay: string, minutes: number, minDays = 1, extraPerDay = 0) {
  let day = startDay;
  let left = minutes;
  let used = 0;
  for (let i = 0; i < HORIZON_DAYS; i++, day = addDays(day, 1)) {
    const base = cal.on(wcCode, day);
    if (base <= 0) continue;
    const cap = base + extraPerDay;
    used++;
    left -= cap;
    if (left <= 0 && used >= minDays) return { finish: day, days: used };
  }
  return null;
}

/**
 * Sıralı operasyonlar (iş merkezi başına toplam kendi dakikası) + darboğaz kuyruğu.
 * Vardiya tanımı olmayan merkezlerde sonuç eski formülle aynıdır: her merkez ceil(dakika / günlük) iş günü sürer,
 * merkezler art arda; en geç tarih, en büyük kuyruk gününün eklenmesiyle bulunur.
 */
export function scheduleOnCalendar(
  cal: CapacityCalendar,
  start: string,
  own: { code: string; minutes: number }[],
  queue: Map<string, number>,
  extraPerDay = 0,
) {
  const reasons: string[] = [];
  let cursor = start;
  let earliest: string | null = null;
  let productionDays = 0;
  let bottleneck: string | null = null;
  let queueDays = 0;
  for (const o of own) {
    const r = consume(cal, o.code, cursor, o.minutes, 1, extraPerDay);
    if (!r) {
      reasons.push(`${o.code}: ${HORIZON_DAYS} gün içinde kapasite yok (vardiya/istisna tanımını kontrol edin)`);
      return { earliest: null, latest: null, productionDays, queueDays, bottleneck, reasons };
    }
    productionDays += r.days;
    earliest = r.finish;
    cursor = addDays(r.finish, 1);
    const q = queue.get(o.code) ?? 0;
    if (q > 0) {
      const qr = consume(cal, o.code, start, q, 0, extraPerDay);
      const qd = qr ? qr.days : HORIZON_DAYS;
      if (qd > queueDays) {
        queueDays = qd;
        bottleneck = o.code;
      }
    }
  }
  if (earliest === null) return { earliest: start, latest: start, productionDays, queueDays, bottleneck, reasons };
  let latest = earliest;
  if (queueDays > 0 && bottleneck) {
    // Darboğazın kuyruğu kadar (o merkezin takviminde) ek gün.
    let d = earliest;
    let n = 0;
    for (let i = 0; i < HORIZON_DAYS && n < queueDays; i++) {
      d = addDays(d, 1);
      if (cal.on(bottleneck, d) > 0) n++;
    }
    latest = d;
  }
  return { earliest, latest, productionDays, queueDays, bottleneck, reasons };
}
