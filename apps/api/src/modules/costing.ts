import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/pool";
import { conflict, forbidden, notFound } from "../lib/errors";
import { recordEvent, type Actor } from "../lib/records";
import { fromMicro, toMicro } from "../lib/decimal";
import { can, parse, tenant } from "../http/context";
import { convertMicro, describeRate, findRate } from "../lib/fx";
import { computeRdCost } from "../lib/rd-cost";

const dateOf = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const Money = z.string().regex(/^\d+(\.\d{1,6})?$/);
const Currency = z.string().regex(/^[A-Z]{3}$/);

/** Sabit nokta çarpım/bölme: 6 ondalık, yarıya yuvarlama. */
const SCALE = 1_000_000n;
const mulM = (a: bigint, b: bigint) => (a * b + SCALE / 2n) / SCALE;
const divM = (a: bigint, b: bigint) => (a * SCALE + b / 2n) / b;
const money = (v: bigint) => fromMicro(v);

export async function currentLotCost(db: Db, lotId: string) {
  const r = await db.query(
    `select unit_cost, currency, source, reference, id, created_at from lot_costs where lot_id = $1 order by id desc limit 1`,
    [lotId],
  );
  return r.rows[0] as { unit_cost: string; currency: string; source: string; reference: string | null; id: string; created_at: string } | undefined;
}

export async function recordLotCost(db: Db, actor: Actor, lotId: string, e: { unitCost: string; currency: string; source: string; reference?: string | null }) {
  const cur = await currentLotCost(db, lotId);
  if (cur && toMicro(cur.unit_cost) === toMicro(e.unitCost) && cur.currency === e.currency && cur.source === e.source) return false;
  await db.query(
    `insert into lot_costs (company_id, lot_id, unit_cost, currency, source, reference, recorded_by) values (app_company_id(), $1, $2, $3, $4, $5, $6)`,
    [lotId, e.unitCost, e.currency, e.source, e.reference ?? null, actor.userId],
  );
  await recordEvent(db, actor, { entityType: "lot", entityId: lotId, eventType: "cost.recorded", before: cur ? { unitCost: cur.unit_cost, currency: cur.currency, source: cur.source } : undefined, after: e });
  return true;
}

async function activePolicy(db: Db, onDate: string) {
  const r = await db.query(
    `select id, version_no as "versionNo", valid_from::text as "validFrom", currency, labor_rate_per_hour as "laborRatePerHour",
            overhead_per_labor_hour as "overheadPerLaborHour", overhead_pct_of_material as "overheadPctOfMaterial", valuation, scrap_treatment as "scrapTreatment", note,
            fx_max_age_days as "fxMaxAgeDays", include_rd_share as "includeRdShare"
       from cost_policies where valid_from <= $1 order by valid_from desc, version_no desc limit 1`,
    [onDate],
  );
  return r.rows[0] as
    | { id: string; versionNo: number; validFrom: string; currency: string; laborRatePerHour: string; overheadPerLaborHour: string; overheadPctOfMaterial: string; valuation: string; scrapTreatment: string; fxMaxAgeDays: number; includeRdShare: boolean }
    | undefined;
}

/**
 * İş emri maliyeti (prompt §18): gerçek malzeme tüketimi (lot birim maliyeti) + işçilik (operasyon süresi × saat ücreti)
 * + genel gider (saat başı + malzemenin yüzdesi) + dış hizmet. Birim maliyet = toplam / kabul edilen sağlam adet.
 * Sıfır sağlam adette birim maliyet hesaplanmaz; toplam kayıp gösterilir. Eksik veri "tamamlanmadı" olarak işaretlenir.
 * Sonuç girdilerden deterministik üretilir; hesap zamanı parmak izine girmez.
 */
export async function computeWorkOrderCost(db: Db, woId: string, today = new Date().toISOString().slice(0, 10)) {
  const w = await db.query(
    `select w.id, w.code, w.status, w.qty, w.product_revision_id, w.migrated, p.code as product_code, p.item_id, pr.rev
       from work_orders w join product_revisions pr on pr.id = w.product_revision_id join products p on p.id = pr.product_id where w.id = $1`,
    [woId],
  );
  const wo = w.rows[0];
  if (!wo) throw notFound("İş emri");
  const policy = await activePolicy(db, today);
  const gaps: string[] = [];
  if (!policy) gaps.push("Geçerli maliyet politikası yok: işçilik ve genel gider hesaplanamadı");
  const currency = policy?.currency ?? null;

  const issues = await db.query(
    `select mi.item_id, i.code as item_code, mi.lot_id, lo.lot_no, sum(mi.qty) as qty
       from material_issues mi join items i on i.id = mi.item_id join lots lo on lo.id = mi.lot_id
      where mi.work_order_id = $1 group by mi.item_id, i.code, mi.lot_id, lo.lot_no order by i.code, lo.lot_no`,
    [woId],
  );
  let material = 0n;
  const materials = [];
  for (const m of issues.rows) {
    const c = await currentLotCost(db, m.lot_id);
    const qty = toMicro(m.qty);
    let cost: bigint | null = null;
    let note: string | null = null;
    let fx: string | null = null;
    if (!c) note = "lot maliyeti yok";
    else if (currency && c.currency !== currency) {
      // Kur: lot maliyetinin kaydedildiği tarih (maliyetin oluştuğu gün), politikadaki azami yaşla.
      const q = await findRate(db, c.currency, currency, dateOf(c.created_at), policy!.fxMaxAgeDays);
      if ("error" in q) note = `${q.error}: dönüştürülemedi`;
      else {
        cost = convertMicro(mulM(qty, toMicro(c.unit_cost)), q);
        fx = describeRate(q);
      }
    } else cost = mulM(qty, toMicro(c.unit_cost));
    if (cost === null) gaps.push(`${m.item_code} / lot ${m.lot_no}: ${note}`);
    else material += cost;
    materials.push({
      itemCode: m.item_code, lotNo: m.lot_no, qty: money(qty), unitCost: c ? money(toMicro(c.unit_cost)) : null, currency: c?.currency ?? null,
      costSource: c?.source ?? null, costReference: c?.reference ?? null, costEntryId: c ? String(c.id) : null, cost: cost === null ? null : money(cost), fx, note,
    });
  }
  if (!issues.rows.length) gaps.push("Malzeme çıkışı yok");

  const ops = await db.query(
    `select o.seq, o.name, o.status, wc.code as work_center, o.worked_seconds,
            coalesce(o.planned_setup_minutes, 0) + coalesce(o.planned_minutes_per_unit, 0) * $2::numeric as planned_minutes
       from work_order_operations o left join work_centers wc on wc.id = o.work_center_id where o.work_order_id = $1 order by o.seq`,
    [woId, wo.qty],
  );
  const seconds = ops.rows.reduce((a, o) => a + Number(o.worked_seconds), 0);
  const hours = toMicro((seconds / 3600).toFixed(6));
  const labor = policy ? mulM(hours, toMicro(policy.laborRatePerHour)) : 0n;
  const overhead = policy ? mulM(hours, toMicro(policy.overheadPerLaborHour)) + mulM(material, divM(toMicro(policy.overheadPctOfMaterial), toMicro("100"))) : 0n;
  const doneOps = ops.rows.filter((o) => o.status === "done").length;
  if (policy && doneOps > 0 && seconds === 0) gaps.push("Tamamlanan operasyonlarda süre kaydı yok: işçilik 0 olarak gösterildi, doğrulanmalı");

  const subJobs = await db.query(
    `select code, status, price, currency from subcontract_jobs where work_order_id = $1 order by created_at`,
    [woId],
  );
  let external = 0n;
  const externals = [];
  for (const s of subJobs.rows) {
    if (s.status !== "completed") {
      gaps.push(`Fason iş ${s.code}: durumu "${s.status}" (henüz tamamlanmadı) — maliyete henüz sayılmadı`);
      externals.push({ jobCode: s.code, status: s.status, price: s.price === null ? null : money(toMicro(s.price)), currency: s.currency, cost: null, fx: null, note: "tamamlanmadı" });
      continue;
    }
    if (s.price === null) {
      gaps.push(`Fason iş ${s.code}: anlaşılan fiyat girilmemiş`);
      externals.push({ jobCode: s.code, status: s.status, price: null, currency: s.currency, cost: null, fx: null, note: "fiyat yok" });
      continue;
    }
    if (currency && s.currency !== currency) {
      // Kur: hesap tarihi (fason işin tamamlanma tarihi ayrıca tutulmuyor).
      const q = await findRate(db, s.currency, currency, today, policy!.fxMaxAgeDays);
      if ("error" in q) {
        gaps.push(`Fason iş ${s.code}: ${q.error}`);
        externals.push({ jobCode: s.code, status: s.status, price: money(toMicro(s.price)), currency: s.currency, cost: null, fx: null, note: "kur yok" });
        continue;
      }
      const cost = convertMicro(toMicro(s.price), q);
      external += cost;
      externals.push({ jobCode: s.code, status: s.status, price: money(toMicro(s.price)), currency: s.currency, cost: money(cost), fx: describeRate(q), note: null });
      continue;
    }
    const cost = toMicro(s.price);
    external += cost;
    externals.push({ jobCode: s.code, status: s.status, price: money(cost), currency: s.currency, cost: money(cost), fx: null, note: null });
  }
  let total = material + labor + overhead + external;

  const d = await db.query(
    `select count(*)::int as started,
            count(*) filter (where finished_lot_id is not null)::int as good,
            count(*) filter (where status = 'scrapped' and finished_lot_id is null)::int as scrapped,
            count(*) filter (where finished_lot_id is null and status <> 'scrapped')::int as open
       from devices where work_order_id = $1`,
    [woId],
  );
  const dev = d.rows[0];
  // Ar-Ge payı (politika açıksa): plan birim payı × sağlam adet; aynı revizyonun diğer iş emirlerinin SON hesaplarında
  // aktarılan pay düşülür, toplam aktarım plan tutarını aşmaz (aynı gider iki kez sayılmaz).
  let rdShare = 0n;
  let rdShareNote: string | null = null;
  if (policy?.includeRdShare && !wo.migrated) {
    const plan = (await db.query(
      `select version_no, amount, currency, planned_units from rd_amortization_plans where revision_id = $1 order by version_no desc limit 1`,
      [wo.product_revision_id],
    )).rows[0];
    if (!plan) rdShareNote = "Ar-Ge payı politikada açık ama bu revizyon için amortisman planı yok (pay eklenmedi)";
    else if (plan.currency !== currency) gaps.push(`Ar-Ge amortisman planı ${plan.currency}, politika ${currency}: pay hesaplanamadı`);
    else {
      const perUnit = divM(toMicro(plan.amount), toMicro(String(plan.planned_units)));
      const want = mulM(perUnit, toMicro(String(dev.good)));
      const absorbed = toMicro((await db.query(
        `select coalesce(sum((x.result->'totals'->>'rdShare')::numeric), 0)::text as s
           from (select distinct on (cr.ref_id) cr.result from cost_runs cr join work_orders w2 on w2.id = cr.ref_id
                  where cr.scope = 'work_order' and w2.product_revision_id = $1 and w2.id <> $2
                  order by cr.ref_id, cr.version_no desc) x`,
        [wo.product_revision_id, woId],
      )).rows[0].s);
      const remaining = toMicro(plan.amount) - absorbed > 0n ? toMicro(plan.amount) - absorbed : 0n;
      rdShare = want < remaining ? want : remaining;
      total += rdShare;
      rdShareNote = `Plan v${plan.version_no}: birim ${money(perUnit)} × ${dev.good} sağlam = ${money(want)}; diğer iş emirlerinde aktarılan ${money(absorbed)}, kalan ${money(remaining)}${rdShare < want ? " — plan tutarı doldu, fazlası aktarılmadı" : ""}`;
    }
  }
  if (wo.status !== "completed") gaps.push(`İş emri "${wo.status}": ara maliyet (henüz tamamlanmadı)`);
  // Tarihsel geçişle eklenen iş emrinde malzeme/işçilik/genel gider bu motorla ayrıştırılmadı (bkz. imports.ts) —
  // bu motorun sıfır girdilerden ürettiği bir birim maliyet, gerçek maliyetin sıfır olduğu anlamına gelmez;
  // bu yüzden burada asla hesaplanmaz (uydurulmaz). Verilen birim maliyet varsa doğrudan lota kaydedilmiştir.
  if (wo.migrated) gaps.push("Bu iş emri tarihsel geçişle (W39 devamı) eklendi; malzeme/işçilik/genel gider bu motorla ayrıştırılmadı — birim maliyet, verilmişse doğrudan bitmiş ürün lotuna kaydedilmiştir (lot maliyet geçmişine bakın), bu motorla hesaplanmaz");
  const unitCost = !wo.migrated && dev.good > 0 ? divM(total, toMicro(String(dev.good))) : null;
  const result = {
    workOrder: { id: wo.id, code: wo.code, status: wo.status, product: `${wo.product_code} Rev.${wo.rev}`, qty: fromMicro(toMicro(wo.qty)) },
    policy: policy ? { id: policy.id, versionNo: policy.versionNo, validFrom: policy.validFrom, currency: policy.currency, laborRatePerHour: fromMicro(toMicro(policy.laborRatePerHour)), overheadPerLaborHour: fromMicro(toMicro(policy.overheadPerLaborHour)), overheadPctOfMaterial: fromMicro(toMicro(policy.overheadPctOfMaterial)) } : null,
    currency,
    materials,
    operations: ops.rows.map((o) => ({ seq: o.seq, name: o.name, workCenter: o.work_center, status: o.status, hours: (Number(o.worked_seconds) / 3600).toFixed(6).replace(/\.?0+$/, ""), plannedHours: (Number(o.planned_minutes) / 60).toFixed(2) })),
    laborHours: money(hours),
    plannedLaborHours: (ops.rows.reduce((a, o) => a + Number(o.planned_minutes), 0) / 60).toFixed(2),
    totals: { material: money(material), labor: money(labor), overhead: money(overhead), external: money(external), ...(policy?.includeRdShare ? { rdShare: money(rdShare) } : {}), total: money(total) },
    ...(policy?.includeRdShare ? { rdShareNote } : {}),
    externals,
    externalNote: subJobs.rows.length ? null : "Bu iş emrine bağlı fason iş yok",
    devices: dev,
    unitCost: unitCost === null ? null : money(unitCost),
    unitCostNote: wo.migrated
      ? "Tarihsel geçiş: bu motorla hesaplanmaz (yukarıdaki eksikler bölümüne bakın)"
      : unitCost === null
        ? `Sağlam adet 0: birim maliyet hesaplanamaz; toplam kayıp ${money(total)}${currency ? ` ${currency}` : ""}`
        : `Hurda maliyeti sağlam adetlere yüklenir (${dev.scrapped} hurda)`,
    gaps,
    complete: gaps.length === 0,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  return { result, fingerprint, policyId: policy?.id ?? null, finishedItemId: wo.item_id as string, woCode: wo.code as string };
}

/**
 * İade maliyeti (§18 "yeniden işleme … muhasebe politikasıyla"): tamir işçiliği (deneme saati × deneme tarihindeki
 * politika ücreti + saat başı genel gider) + tamirde kullanılan parçalar + hurdaya ayrılan iade ürünü + değişim ürünü.
 * Tutarlar hesap tarihindeki politikanın para birimindedir; farklı para birimi hareket tarihindeki kurla çevrilir.
 * Lot maliyeti veya kur yoksa kalem hesaplanmaz, eksik olarak gösterilir. Bu maliyet brüt kârdan düşülmez, ayrı sunulur.
 */
export async function computeRmaCost(db: Db, rmaId: string, today = new Date().toISOString().slice(0, 10)) {
  const rma = (await db.query(
    `select r.id, r.code, r.status, r.disposition, r.qty, r.lot_id, r.replacement_lot_id, r.replacement_device_id, r.decided_at,
            i.code as item_code, lo.lot_no
       from rmas r join items i on i.id = r.item_id join lots lo on lo.id = r.lot_id where r.id = $1`,
    [rmaId],
  )).rows[0];
  if (!rma) throw notFound("İade");
  const policy = await activePolicy(db, today);
  const gaps: string[] = [];
  if (!policy) gaps.push("Geçerli maliyet politikası yok: iade maliyeti hesaplanamadı");
  const currency = policy?.currency ?? null;

  /** Lot maliyetini politika para birimine, verilen tarihteki kurla çevirir. */
  async function lotValue(lotId: string, qty: bigint, onDate: string, label: string) {
    const c = await currentLotCost(db, lotId);
    if (!c) {
      gaps.push(`${label}: lot maliyeti yok`);
      return { unitCost: null, currency: null, cost: null, fx: null };
    }
    const raw = mulM(qty, toMicro(c.unit_cost));
    if (!currency || c.currency === currency) return { unitCost: money(toMicro(c.unit_cost)), currency: c.currency, cost: currency ? raw : null, fx: null };
    const q = await findRate(db, c.currency, currency, onDate, policy!.fxMaxAgeDays);
    if ("error" in q) {
      gaps.push(`${label}: ${q.error}`);
      return { unitCost: money(toMicro(c.unit_cost)), currency: c.currency, cost: null, fx: null };
    }
    return { unitCost: money(toMicro(c.unit_cost)), currency: c.currency, cost: convertMicro(raw, q), fx: describeRate(q) };
  }

  let repairTotal = 0n;
  const attempts = [];
  const rows = (await db.query(
    `select id, attempt_no, labor_hours, retest_passed, created_at from rma_repair_attempts where rma_id = $1 order by attempt_no`,
    [rmaId],
  )).rows;
  for (const a of rows) {
    const onDate = dateOf(a.created_at);
    const p = policy ? await activePolicy(db, onDate) : undefined;
    const hours = toMicro(a.labor_hours);
    let labor = 0n;
    let overhead = 0n;
    if (hours > 0n && policy) {
      if (!p) gaps.push(`Tamir denemesi ${a.attempt_no}: ${onDate} tarihinde geçerli politika yok, işçilik hesaplanamadı`);
      else if (p.currency !== currency) gaps.push(`Tamir denemesi ${a.attempt_no}: politika para birimi değişmiş (${p.currency} → ${currency}), işçilik hesaplanamadı`);
      else {
        labor = mulM(hours, toMicro(p.laborRatePerHour));
        overhead = mulM(hours, toMicro(p.overheadPerLaborHour));
      }
    }
    const parts = [];
    let partsCost = 0n;
    const moves = (await db.query(
      `select m.item_id, i.code as item_code, m.lot_id, lo.lot_no, m.qty, m.created_at
         from stock_moves m join items i on i.id = m.item_id join lots lo on lo.id = m.lot_id
        where m.ref_type = 'rma_repair' and m.ref_id = $1 order by i.code`,
      [a.id],
    )).rows;
    for (const m of moves) {
      const v = await lotValue(m.lot_id, toMicro(m.qty), dateOf(m.created_at), `Tamir parçası ${m.item_code} / lot ${m.lot_no}`);
      if (v.cost !== null) partsCost += v.cost;
      parts.push({ itemCode: m.item_code, lotNo: m.lot_no, qty: money(toMicro(m.qty)), unitCost: v.unitCost, currency: v.currency, cost: v.cost === null ? null : money(v.cost), fx: v.fx });
    }
    const total = labor + overhead + partsCost;
    repairTotal += total;
    attempts.push({ attemptNo: a.attempt_no, date: onDate, laborHours: money(hours), labor: money(labor), overhead: money(overhead), parts, partsCost: money(partsCost), total: money(total), retestPassed: a.retest_passed });
  }

  let scrap = null as null | { qty: string; unitCost: string | null; cost: string | null; fx: string | null };
  let scrapCost = 0n;
  const sm = (await db.query(
    `select coalesce(sum(qty), 0) as qty, max(created_at) as at from stock_moves where move_type = 'scrap' and ref_type = 'rma' and ref_id = $1`,
    [rmaId],
  )).rows[0];
  if (toMicro(sm.qty) > 0n) {
    const v = await lotValue(rma.lot_id, toMicro(sm.qty), dateOf(sm.at), `Hurdaya ayrılan iade ürünü ${rma.item_code} / lot ${rma.lot_no}`);
    if (v.cost !== null) scrapCost = v.cost;
    scrap = { qty: money(toMicro(sm.qty)), unitCost: v.unitCost, cost: v.cost === null ? null : money(v.cost), fx: v.fx };
  }

  let replacement = null as null | { qty: string; unitCost: string | null; cost: string | null; fx: string | null };
  let replacementCost = 0n;
  if (rma.disposition === "replace" && rma.replacement_lot_id) {
    const qty = rma.replacement_device_id ? toMicro("1") : toMicro(rma.qty);
    const v = await lotValue(rma.replacement_lot_id, qty, dateOf(rma.decided_at ?? today), "Değişim ürünü");
    if (v.cost !== null) replacementCost = v.cost;
    replacement = { qty: money(qty), unitCost: v.unitCost, cost: v.cost === null ? null : money(v.cost), fx: v.fx };
  }
  if (rma.status !== "closed" && rma.status !== "cancelled") gaps.push(`İade "${rma.status}": ara maliyet (henüz kapanmadı)`);

  return {
    rma: { id: rma.id as string, code: rma.code as string, status: rma.status as string, disposition: rma.disposition as string | null },
    currency,
    policy: policy ? { versionNo: policy.versionNo, laborRatePerHour: fromMicro(toMicro(policy.laborRatePerHour)), overheadPerLaborHour: fromMicro(toMicro(policy.overheadPerLaborHour)) } : null,
    repair: { attempts, total: money(repairTotal) },
    scrap,
    replacement,
    totals: { repair: money(repairTotal), scrap: money(scrapCost), replacement: money(replacementCost), total: money(repairTotal + scrapCost + replacementCost) },
    gaps,
    complete: gaps.length === 0,
  };
}

/** Metrik sözlüğü (sürüm 1). Tanım, pay, payda ve kapsam her yanıtta görünür (prompt §18). */
export const METRICS = [
  { key: "scrap_rate", name: "Ürün hurda oranı", definition: "Üretimde hurdaya ayrılan benzersiz cihaz / kapsamda üretime alınan (seri üretilen) cihaz", unit: "%" },
  { key: "first_pass_yield", name: "İlk testte başarı", definition: "İlk testinde geçen cihaz / ilk test uygulanmış benzersiz cihaz. Tekrar testler oranı yükseltmez.", unit: "%" },
  { key: "rework_rate", name: "Yeniden işleme oranı", definition: "Yeniden işleme kararı verilmiş benzersiz cihaz / kapsamda üretime alınan cihaz", unit: "%" },
  { key: "component_scrap", name: "Komponent firesi", definition: "Komponent hurda hareket miktarı / üretime çıkış miktarı (payda: iş emrine malzeme çıkışı)", unit: "%" },
  { key: "on_time_delivery", name: "Zamanında teslim", definition: "Taahhüt tarihi dönem içinde olan sipariş satırlarından taahhüt tarihine kadar tamamı sevk edilenler / taahhüt tarihi geçmiş veya tamamı sevk edilmiş satırlar. Taahhütsüz satırlar kapsam dışıdır.", unit: "%" },
  { key: "return_rate", name: "İade oranı", definition: "Dönemde açılan (iptal hariç) iade adedi / dönemde sevk edilen adet", unit: "%" },
  { key: "budget_variance", name: "Bütçe sapması", definition: "Açık Ar-Ge projelerinde (gerçekleşen Ar-Ge maliyeti − onaylı baz bütçe) / onaylı baz bütçe. Proje bazında tutarlar kaynak satırlarında; farklı para birimleri dönem sonu kuruyla bütçe para birimine çevrilir.", unit: "%" },
] as const;

type MetricKey = (typeof METRICS)[number]["key"];

export async function metricData(db: Db, key: MetricKey, from: string, to: string, productId: string | null, stage: string | null = null) {
  const woScope = `w.created_at >= $1::date and w.created_at < ($2::date + 1) and ($3::uuid is null or p.id = $3) and ($4::text is null or w.production_stage = $4)`;
  const woJoin = `from devices d join work_orders w on w.id = d.work_order_id join product_revisions pr on pr.id = w.product_revision_id join products p on p.id = pr.product_id`;
  const args = [from, to, productId];
  const woArgs = [from, to, productId, stage];
  switch (key) {
    case "scrap_rate":
    case "rework_rate":
    case "first_pass_yield": {
      const rows = (await db.query(
        `select d.serial, d.status, w.code as "workOrderCode", p.code as "productCode",
                exists (select 1 from test_runs t where t.device_id = d.id and t.run_no = 1) as "firstTested",
                exists (select 1 from test_runs t where t.device_id = d.id and t.run_no = 1 and t.result = 'pass') as "firstPassed",
                exists (select 1 from nonconformances n where n.device_id = d.id and n.decision = 'rework') as reworked,
                (d.status = 'scrapped' and d.finished_lot_id is null) as "scrappedInProduction"
           ${woJoin} where ${woScope} order by d.serial`,
        woArgs,
      )).rows;
      if (key === "scrap_rate") return { numerator: rows.filter((r) => r.scrappedInProduction).length, denominator: rows.length, rows };
      if (key === "rework_rate") return { numerator: rows.filter((r) => r.reworked).length, denominator: rows.length, rows };
      const tested = rows.filter((r) => r.firstTested);
      return { numerator: tested.filter((r) => r.firstPassed).length, denominator: tested.length, rows: tested };
    }
    case "component_scrap": {
      const scrap = await db.query(
        `select i.code as "itemCode", lo.lot_no as "lotNo", m.qty, m.created_at as "at", 'hurda' as kind
           from stock_moves m join items i on i.id = m.item_id join lots lo on lo.id = m.lot_id
          where m.move_type = 'scrap' and i.kind = 'component' and m.created_at >= $1::date and m.created_at < ($2::date + 1)`,
        [from, to],
      );
      const issued = await db.query(
        `select coalesce(sum(m.qty), 0) as q from stock_moves m join items i on i.id = m.item_id
          where m.move_type = 'issue' and i.kind = 'component' and m.created_at >= $1::date and m.created_at < ($2::date + 1)`,
        [from, to],
      );
      const num = scrap.rows.reduce((a, r) => a + toMicro(r.qty), 0n);
      return { numerator: Number(fromMicro(num)), denominator: Number(fromMicro(toMicro(issued.rows[0].q))), rows: scrap.rows, note: productId ? "Ürün filtresi komponent firesine uygulanmaz" : undefined };
    }
    case "on_time_delivery": {
      const rows = (await db.query(
        `select so.code as "orderCode", c.name as "customerName", l.line_no as "lineNo", so.promised_date::text as "promisedDate", l.qty as ordered,
                coalesce((select sum(sl.qty) from shipment_lines sl join shipments s on s.id = sl.shipment_id
                           where sl.sales_order_line_id = l.id and s.status in ('shipped', 'delivered', 'problem')), 0) as shipped,
                coalesce((select sum(sl.qty) from shipment_lines sl join shipments s on s.id = sl.shipment_id
                           where sl.sales_order_line_id = l.id and s.status in ('shipped', 'delivered', 'problem') and s.shipped_at < (so.promised_date + 1)), 0) as "shippedOnTime"
           from sales_order_lines l join sales_orders so on so.id = l.order_id join customers c on c.id = so.customer_id
           join product_revisions pr on pr.id = l.product_revision_id join products p on p.id = pr.product_id
          where so.promised_date is not null and so.status <> 'cancelled' and so.promised_date between $1::date and $2::date and ($3::uuid is null or p.id = $3)
          order by so.promised_date`,
        args,
      )).rows.map((r) => {
        const full = toMicro(r.shipped) >= toMicro(r.ordered);
        const onTime = toMicro(r.shippedOnTime) >= toMicro(r.ordered);
        const due = r.promisedDate < new Date().toISOString().slice(0, 10);
        return { ...r, ordered: fromMicro(toMicro(r.ordered)), shipped: fromMicro(toMicro(r.shipped)), onTime, counted: full || due };
      });
      const counted = rows.filter((r) => r.counted);
      return { numerator: counted.filter((r) => r.onTime).length, denominator: counted.length, rows, note: `${rows.length - counted.length} satır henüz vadesi gelmemiş ve sevk edilmemiş: kapsam dışı` };
    }
    case "return_rate": {
      const rmas = (await db.query(
        `select r.code, r.kind, r.qty, c.name as "customerName", d.serial, lo.lot_no as "lotNo", r.cause, r.created_at as "createdAt"
           from rmas r join customers c on c.id = r.customer_id join lots lo on lo.id = r.lot_id left join devices d on d.id = r.device_id join products p on p.item_id = r.item_id
          where r.status <> 'cancelled' and r.created_at >= $1::date and r.created_at < ($2::date + 1) and ($3::uuid is null or p.id = $3) order by r.created_at`,
        args,
      )).rows;
      const shipped = await db.query(
        `select coalesce(sum(sl.qty), 0) as q from shipment_lines sl join shipments s on s.id = sl.shipment_id
           join sales_order_lines l on l.id = sl.sales_order_line_id join product_revisions pr on pr.id = l.product_revision_id join products p on p.id = pr.product_id
          where s.status in ('shipped', 'delivered', 'problem') and s.shipped_at >= $1::date and s.shipped_at < ($2::date + 1) and ($3::uuid is null or p.id = $3)`,
        args,
      );
      const num = rmas.reduce((a, r) => a + toMicro(r.qty), 0n);
      return { numerator: Number(fromMicro(num)), denominator: Number(fromMicro(toMicro(shipped.rows[0].q))), rows: rmas.map((r) => ({ ...r, qty: fromMicro(toMicro(r.qty)) })), note: "İade, sevk dönemine göre değil açılış dönemine göre sayılır" };
    }
    case "budget_variance": {
      // Kapsam: açık ve onaylı baz bütçesi olan Ar-Ge projeleri (dönem filtresi uygulanmaz — bütçe proje ömrü boyuncadır).
      const projects = (await db.query(
        `select p.id, p.code, p.name, b.version_no as "versionNo", b.amount, b.currency
           from rd_projects p
           join lateral (select version_no, amount, currency from rd_project_budgets where project_id = p.id order by version_no desc limit 1) b on true
          where p.status = 'open' order by p.code`,
      )).rows;
      const maxAge = (await activePolicy(db, to))?.fxMaxAgeDays ?? 7;
      const rows = [];
      const sums = new Map<string, { actual: bigint; baseline: bigint }>();
      let incomplete = 0;
      for (const p of projects) {
        const cost = (await computeRdCost(db, p.id))!;
        let actual = 0n;
        const gaps: string[] = [];
        const fx: string[] = [];
        for (const c of cost.byCurrency) {
          const q = await findRate(db, c.currency, p.currency, to, maxAge);
          if ("error" in q) gaps.push(q.error);
          else {
            actual += convertMicro(toMicro(c.total), q);
            if (c.currency !== p.currency) fx.push(describeRate(q));
          }
        }
        const baseline = toMicro(p.amount);
        const ok = gaps.length === 0;
        if (ok) {
          const s = sums.get(p.currency) ?? { actual: 0n, baseline: 0n };
          s.actual += actual;
          s.baseline += baseline;
          sums.set(p.currency, s);
        } else incomplete++;
        rows.push({
          projectCode: p.code, projectName: p.name, budgetVersion: p.versionNo, currency: p.currency, baseline: money(baseline),
          actual: ok ? money(actual) : null, variance: ok ? money(actual - baseline) : null,
          costStatus: cost.status, fx, note: ok ? (cost.status === "provisional" ? "Ar-Ge maliyeti geçici" : null) : gaps.join("; "),
        });
      }
      if (!projects.length) return { numerator: null, denominator: null, rows, note: "Onaylı baz bütçesi olan açık Ar-Ge projesi yok" };
      if (sums.size !== 1) return { numerator: null, denominator: null, rows, note: sums.size === 0 ? "Hiçbir projede gerçekleşen tutar hesaplanamadı (kur eksik)" : "Bütçeler farklı para birimlerinde: toplu oran hesaplanmaz, proje satırlarına bakın" };
      const [cur, s] = [...sums.entries()][0]!;
      return {
        numerator: Number(fromMicro(s.actual - s.baseline)), denominator: Number(fromMicro(s.baseline)), rows,
        note: `${cur} bazında${incomplete ? `; ${incomplete} proje kur eksikliği nedeniyle dışarıda` : ""}`,
      };
    }
  }
}

export function ratio(n: number | null, d: number | null) {
  if (n === null || d === null) return null;
  if (d === 0) return null;
  return Number((n / d).toFixed(4));
}

export type MetricKeyPublic = MetricKey;

export async function costingRoutes(app: FastifyInstance) {
  // ---- Lot maliyeti -----------------------------------------------------------------
  app.get("/api/lots/:id/costs", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "field.cost.view", async (db) => {
      const r = await db.query(
        `select lc.id, lc.unit_cost as "unitCost", lc.currency, lc.source, lc.reference, lc.created_at as "createdAt", u.name as "recordedBy"
           from lot_costs lc left join users u on u.id = lc.recorded_by where lc.lot_id = $1 order by lc.id desc`,
        [id],
      );
      return r.rows.map((x) => ({ ...x, id: String(x.id), unitCost: fromMicro(toMicro(x.unitCost)) }));
    });
  });

  /** Fatura veya elle maliyet girişi. Geçmiş kayıt değişmez; yeni kayıt güncel değer olur. */
  app.post("/api/lots/:id/cost", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ unitCost: Money, currency: Currency, source: z.enum(["invoice", "manual"]), reference: z.string().min(2).max(120) }), req.body);
    return tenant(req, "lot.cost.record", async (db, actor) => {
      const lot = await db.query(`select id from lots where id = $1 for update`, [id]);
      if (!lot.rows[0]) throw notFound("Lot");
      const changed = await recordLotCost(db, actor, id, input);
      return { lotId: id, changed, current: await currentLotCost(db, id).then((c) => c && { unitCost: fromMicro(toMicro(c.unit_cost)), currency: c.currency, source: c.source }) };
    });
  });

  // ---- Politika --------------------------------------------------------------------
  app.get("/api/cost-policies", async (req) =>
    tenant(req, "field.cost.view", async (db) => {
      const r = await db.query(
        `select cp.id, cp.version_no as "versionNo", cp.valid_from::text as "validFrom", cp.currency, cp.labor_rate_per_hour as "laborRatePerHour",
                cp.overhead_per_labor_hour as "overheadPerLaborHour", cp.overhead_pct_of_material as "overheadPctOfMaterial", cp.valuation,
                cp.scrap_treatment as "scrapTreatment", cp.fx_max_age_days as "fxMaxAgeDays", cp.include_rd_share as "includeRdShare", cp.note, cp.created_at as "createdAt", u.name as "createdBy"
           from cost_policies cp left join users u on u.id = cp.created_by order by cp.version_no desc`,
      );
      return r.rows;
    }),
  );

  app.post("/api/cost-policies", async (req) => {
    const input = parse(
      z.object({
        validFrom: z.string().regex(DATE), currency: Currency, laborRatePerHour: Money, overheadPerLaborHour: Money.default("0"),
        overheadPctOfMaterial: Money.default("0"), fxMaxAgeDays: z.number().int().min(0).max(31).default(7), includeRdShare: z.boolean().default(false), note: z.string().min(3).max(1000),
      }),
      req.body,
    );
    return tenant(req, "cost.manage", async (db, actor) => {
      await db.query(`select pg_advisory_xact_lock(hashtext('cost_policy:' || app_company_id()::text))`);
      const n = (await db.query(`select coalesce(max(version_no), 0) + 1 as n from cost_policies`)).rows[0].n;
      const r = await db.query(
        `insert into cost_policies (company_id, version_no, valid_from, currency, labor_rate_per_hour, overhead_per_labor_hour, overhead_pct_of_material, note, created_by, fx_max_age_days, include_rd_share)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [n, input.validFrom, input.currency, input.laborRatePerHour, input.overheadPerLaborHour, input.overheadPctOfMaterial, input.note, actor.userId, input.fxMaxAgeDays, input.includeRdShare],
      );
      await recordEvent(db, actor, { entityType: "cost_policy", entityId: r.rows[0].id, eventType: "created", after: { versionNo: n, ...input } });
      return { id: r.rows[0].id, versionNo: n, ...input };
    });
  });

  // ---- Kur ---------------------------------------------------------------------------
  app.get("/api/exchange-rates", async (req) => {
    const q = z.object({ currency: Currency.optional() }).parse(req.query);
    return tenant(req, "field.cost.view", async (db) =>
      (await db.query(
        `select x.id, x.base_currency as "baseCurrency", x.quote_currency as "quoteCurrency", x.rate::text as rate, x.rate_date::text as "rateDate",
                x.source, x.note, u.name as "createdBy", x.created_at as "createdAt"
           from exchange_rates x left join users u on u.id = x.created_by
          where ($1::text is null or x.base_currency = $1 or x.quote_currency = $1)
          order by x.rate_date desc, x.created_at desc limit 200`,
        [q.currency ?? null],
      )).rows,
    );
  });

  /** Kur kaydı değişmez; aynı çift ve tarih için yeni kayıt öncekinin yerine geçer (düzeltme izi kalır). */
  app.post("/api/exchange-rates", async (req) => {
    const input = parse(
      z.object({
        baseCurrency: Currency, quoteCurrency: Currency, rate: z.string().regex(/^\d{1,10}(\.\d{1,10})?$/),
        rateDate: z.string().regex(DATE), source: z.string().min(2).max(120), note: z.string().max(500).optional(),
      }).refine((v) => v.baseCurrency !== v.quoteCurrency, { message: "Aynı para birimi için kur girilmez" })
        .refine((v) => Number(v.rate) > 0, { message: "Kur sıfırdan büyük olmalı" }),
      req.body,
    );
    if (input.rateDate > new Date().toISOString().slice(0, 10)) throw conflict("future_rate", "İleri tarihli kur girilemez");
    return tenant(req, "cost.manage", async (db, actor) => {
      const prev = (await db.query(
        `select rate::text as rate, source from exchange_rates where base_currency = $1 and quote_currency = $2 and rate_date = $3 order by created_at desc limit 1`,
        [input.baseCurrency, input.quoteCurrency, input.rateDate],
      )).rows[0];
      const r = await db.query(
        `insert into exchange_rates (company_id, base_currency, quote_currency, rate, rate_date, source, note, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [input.baseCurrency, input.quoteCurrency, input.rate, input.rateDate, input.source, input.note ?? null, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "exchange_rate", entityId: r.rows[0].id, eventType: prev ? "corrected" : "created", before: prev, after: input });
      return { id: r.rows[0].id as string, corrected: !!prev };
    });
  });

  // ---- Ar-Ge payı amortisman planı ---------------------------------------------------
  app.get("/api/revisions/:id/rd-amortization", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "field.cost.view", async (db) =>
      (await db.query(
        `select p.version_no as "versionNo", p.amount, p.currency, p.planned_units as "plannedUnits", round(p.amount / p.planned_units, 6)::text as "perUnit",
                p.basis, p.reason, u.name as "createdBy", p.created_at as "createdAt"
           from rd_amortization_plans p left join users u on u.id = p.created_by where p.revision_id = $1 order by p.version_no desc`,
        [id],
      )).rows,
    );
  });

  /** Plan: en son devir maliyet raporu toplamı (politika para birimine bugünkü kurla) ÷ planlanan adet. Değişmez, sürümlü. */
  app.post("/api/revisions/:id/rd-amortization", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ plannedUnits: z.number().int().min(1).max(10_000_000), reason: z.string().min(3).max(500) }), req.body);
    return tenant(req, "cost.manage", async (db, actor) => {
      const today = new Date().toISOString().slice(0, 10);
      const report = (await db.query(
        `select id, version_no, status, report from rd_cost_reports where revision_id = $1 order by version_no desc limit 1`,
        [id],
      )).rows[0];
      if (!report) throw conflict("no_rd_report", "Bu revizyon için devir Ar-Ge maliyet raporu yok");
      const policy = await activePolicy(db, today);
      if (!policy) throw conflict("no_policy", "Geçerli maliyet politikası yok");
      let amount = 0n;
      const fx: string[] = [];
      for (const c of report.report.byCurrency as { currency: string; total: string }[]) {
        const q = await findRate(db, c.currency, policy.currency, today, policy.fxMaxAgeDays);
        if ("error" in q) throw conflict("fx_missing", q.error);
        amount += convertMicro(toMicro(c.total), q);
        if (c.currency !== policy.currency) fx.push(describeRate(q));
      }
      const cents = (amount + 5000n) / 10000n; // 2 ondalık
      const amountStr = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
      await db.query(`select pg_advisory_xact_lock(hashtext('rd_amort:' || $1::text))`, [id]);
      const n = (await db.query(`select coalesce(max(version_no), 0) + 1 as n from rd_amortization_plans where revision_id = $1`, [id])).rows[0].n;
      const basis = { reportVersion: report.version_no, reportStatus: report.status, totals: report.report.byCurrency.map((c: { currency: string; total: string }) => ({ currency: c.currency, total: c.total })), fx };
      await db.query(
        `insert into rd_amortization_plans (company_id, revision_id, version_no, report_id, amount, currency, planned_units, basis, reason, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, n, report.id, amountStr, policy.currency, input.plannedUnits, JSON.stringify(basis), input.reason, actor.userId],
      );
      await recordEvent(db, actor, { entityType: "product_revision", entityId: id, eventType: "rd_amortization.planned", after: { versionNo: n, amount: amountStr, currency: policy.currency, plannedUnits: input.plannedUnits, basis }, reason: input.reason });
      return { versionNo: n, amount: amountStr, currency: policy.currency, plannedUnits: input.plannedUnits, reportStatus: report.status, basis };
    });
  });

  // ---- İş emri maliyeti --------------------------------------------------------------
  app.get("/api/work-orders/:id/costs", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "field.cost.view", async (db) => {
      const r = await db.query(
        `select cr.id, cr.version_no as "versionNo", cr.complete, cr.result, cr.fingerprint, cr.created_at as "createdAt", u.name as "createdBy"
           from cost_runs cr left join users u on u.id = cr.created_by where cr.scope = 'work_order' and cr.ref_id = $1 order by cr.version_no desc`,
        [id],
      );
      return r.rows;
    });
  });

  /** Yeniden hesap: girdiler değişmediyse yeni sürüm açılmaz (aynı gider iki kez sayılmaz). */
  app.post("/api/work-orders/:id/costs", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "cost.manage", async (db, actor) => {
      await db.query(`select id from work_orders where id = $1 for update`, [id]);
      const c = await computeWorkOrderCost(db, id);
      const last = (await db.query(`select id, version_no, fingerprint from cost_runs where scope = 'work_order' and ref_id = $1 order by version_no desc limit 1`, [id])).rows[0];
      if (last && last.fingerprint === c.fingerprint) return { unchanged: true, versionNo: last.version_no, ...c.result };
      const versionNo = (last?.version_no ?? 0) + 1;
      const r = await db.query(
        `insert into cost_runs (company_id, scope, ref_id, version_no, policy_id, fingerprint, complete, result, created_by)
         values (app_company_id(), 'work_order', $1, $2, $3, $4, $5, $6, $7) returning id`,
        [id, versionNo, c.policyId, c.fingerprint, c.result.complete, JSON.stringify(c.result), actor.userId],
      );
      await recordEvent(db, actor, { entityType: "work_order", entityId: id, eventType: "cost.computed", after: { versionNo, total: c.result.totals.total, unitCost: c.result.unitCost, complete: c.result.complete } });
      // Bitmiş ürün lotunun maliyeti yalnızca eksiksiz hesaptan beslenir (satılan malın maliyeti için); ara/eksik hesap lota yazılmaz.
      if (c.result.complete && c.result.unitCost !== null && c.result.currency) {
        const lot = (await db.query(`select id from lots where item_id = $1 and lot_no = $2`, [c.finishedItemId, c.woCode])).rows[0];
        if (lot) await recordLotCost(db, actor, lot.id, { unitCost: c.result.unitCost, currency: c.result.currency, source: "production", reference: `${c.woCode} maliyet v${versionNo}` });
      }
      return { unchanged: false, versionNo, runId: r.rows[0].id, ...c.result };
    });
  });

  // ---- İade maliyeti -----------------------------------------------------------------
  app.get("/api/rmas/:id/cost", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "field.cost.view", (db) => computeRmaCost(db, id));
  });

  // ---- Satış kârlılığı --------------------------------------------------------------
  /**
   * Yalnızca sevk edilmiş miktar için (satılmamış cihazda kâr gösterilmez). Satış fiyatı ve lot maliyeti aynı para biriminde
   * değilse hesaplanmaz (kur modülü yok). Brüt marj: gelir sıfırsa hesaplanamaz.
   */
  app.get("/api/reports/margin", async (req) => {
    const q = z.object({ from: z.string().regex(DATE), to: z.string().regex(DATE) }).parse(req.query);
    return tenant(req, "report.view", async (db) => {
      if (!can(req, "field.cost.view") || !can(req, "field.price.view")) throw forbidden("field.cost.view+field.price.view");
      return computeMarginReport(db, q.from, q.to);
    });
  });

  // ---- Metrikler ---------------------------------------------------------------------
  app.get("/api/metrics/definitions", async (req) => tenant(req, "report.view", async () => ({ version: 1, metrics: METRICS })));

  app.get("/api/metrics", async (req) => {
    const q = z.object({ from: z.string().regex(DATE), to: z.string().regex(DATE), productId: z.string().uuid().optional(), stage: z.enum(["prototype", "pilot", "series"]).optional() }).parse(req.query);
    return tenant(req, "report.view", async (db) => {
      const out = [];
      for (const m of METRICS) {
        const d = await metricData(db, m.key, q.from, q.to, q.productId ?? null, q.stage ?? null);
        const value = ratio(d.numerator, d.denominator);
        out.push({
          ...m, numerator: d.numerator, denominator: d.denominator, value,
          reason: value === null ? (d.denominator === 0 ? "Payda sıfır: hesaplanamaz" : d.note ?? "Veri yok") : null,
          note: d.note ?? null,
        });
      }
      return { version: 1, from: q.from, to: q.to, productId: q.productId ?? null, stage: q.stage ?? null, scope: `İş emri oluşturma tarihi (üretim metrikleri; aşama: ${q.stage ? { prototype: "prototip", pilot: "pilot", series: "seri" }[q.stage] : "tümü — prototip/pilot/seri birlikte"}), taahhüt tarihi (zamanında teslim), sevk/iade açılış tarihi (iade oranı)`, metrics: out };
    });
  });

  /** Metriğin kaynak kayıtları: her rakam açılabilir. */
  app.get("/api/metrics/:key/sources", async (req) => {
    const { key } = req.params as { key: string };
    const q = z.object({ from: z.string().regex(DATE), to: z.string().regex(DATE), productId: z.string().uuid().optional(), stage: z.enum(["prototype", "pilot", "series"]).optional() }).parse(req.query);
    const def = METRICS.find((m) => m.key === key);
    if (!def) throw notFound("Metrik");
    return tenant(req, "report.view", async (db) => {
      const d = await metricData(db, def.key, q.from, q.to, q.productId ?? null, q.stage ?? null);
      if (d.rows.length > 1000) throw conflict("too_many_rows", "Kapsam çok geniş; tarih aralığını daraltın");
      return { ...def, numerator: d.numerator, denominator: d.denominator, value: ratio(d.numerator, d.denominator), rows: d.rows };
    });
  });
}

/** `/api/reports/margin` ve W30 yönetici raporunun kârlılık alanı ortak hesaplayıcısı. */
export async function computeMarginReport(db: Db, from: string, to: string) {
  const r = await db.query(
    `select s.code as "shipmentCode", s.shipped_at as "shippedAt", so.code as "orderCode", c.name as "customerName", p.code as "productCode", pr.rev,
            l.unit_price as "unitPrice", l.currency, pi.lot_id, lo.lot_no as "lotNo", sum(pi.qty) as qty
       from package_items pi join packages pk on pk.id = pi.package_id join shipments s on s.id = pk.shipment_id
       join shipment_lines sl on sl.id = pi.shipment_line_id join sales_order_lines l on l.id = sl.sales_order_line_id
       join sales_orders so on so.id = l.order_id join customers c on c.id = so.customer_id
       join product_revisions pr on pr.id = l.product_revision_id join products p on p.id = pr.product_id join lots lo on lo.id = pi.lot_id
      where s.status in ('shipped', 'delivered', 'problem') and s.shipped_at >= $1::date and s.shipped_at < ($2::date + 1)
      group by s.code, s.shipped_at, so.code, c.name, p.code, pr.rev, l.unit_price, l.currency, pi.lot_id, lo.lot_no
      order by s.shipped_at, s.code`,
    [from, to],
  );
  const rows = [];
  const totals = new Map<string, { revenue: bigint; cogs: bigint }>();
  let incomplete = 0;
  for (const x of r.rows) {
    const qty = toMicro(x.qty);
    const cost = await currentLotCost(db, x.lot_id);
    const revenue = x.unitPrice === null ? null : mulM(qty, toMicro(x.unitPrice));
    let cogs: bigint | null = null;
    let note: string | null = null;
    let fx: string | null = null;
    if (revenue === null) note = "satış fiyatı yok";
    if (!cost) note = [note, "lot maliyeti yok"].filter(Boolean).join("; ");
    else if (cost.currency !== x.currency) {
      // Maliyet satış para birimine sevk tarihindeki kurla çevrilir (gelirle aynı gün).
      const shipDate = dateOf(x.shippedAt);
      const q = await findRate(db, cost.currency, x.currency, shipDate, (await activePolicy(db, shipDate))?.fxMaxAgeDays ?? 7);
      if ("error" in q) note = [note, q.error].filter(Boolean).join("; ");
      else {
        cogs = convertMicro(mulM(qty, toMicro(cost.unit_cost)), q);
        fx = describeRate(q);
      }
    } else cogs = mulM(qty, toMicro(cost.unit_cost));
    const gross = revenue !== null && cogs !== null ? revenue - cogs : null;
    const margin = gross !== null && revenue !== null && revenue > 0n ? Number(fromMicro(divM(gross, revenue))) : null;
    if (gross === null) incomplete++;
    else {
      const t = totals.get(x.currency) ?? { revenue: 0n, cogs: 0n };
      t.revenue += revenue!;
      t.cogs += cogs!;
      totals.set(x.currency, t);
    }
    rows.push({
      shipmentCode: x.shipmentCode, shippedAt: x.shippedAt, orderCode: x.orderCode, customerName: x.customerName, product: `${x.productCode} Rev.${x.rev}`,
      lotNo: x.lotNo, qty: money(qty), currency: x.currency, unitPrice: x.unitPrice === null ? null : money(toMicro(x.unitPrice)),
      unitCost: cost ? money(toMicro(cost.unit_cost)) : null, costSource: cost?.source ?? null,
      revenue: revenue === null ? null : money(revenue), cogs: cogs === null ? null : money(cogs), grossProfit: gross === null ? null : money(gross), grossMargin: margin, fx, note,
    });
  }
  const returns = await db.query(
    `select count(*)::int as n, coalesce(sum(qty), 0) as q, count(*) filter (where credit_note_requested)::int as credit
       from rmas where status <> 'cancelled' and created_at >= $1::date and created_at < ($2::date + 1)`,
    [from, to],
  );
  // İade maliyeti (tamir + hurda + değişim): dönemde KARAR verilen iadeler; brüt kârdan düşülmez, ayrı gösterilir.
  const decided = (await db.query(
    `select id from rmas where status <> 'cancelled' and decided_at >= $1::date and decided_at < ($2::date + 1) order by decided_at`,
    [from, to],
  )).rows;
  const returnCosts = new Map<string, { repair: bigint; scrap: bigint; replacement: bigint }>();
  let returnCostIncomplete = 0;
  for (const d of decided) {
    const c = await computeRmaCost(db, d.id, to);
    if (!c.currency) {
      returnCostIncomplete++;
      continue;
    }
    if (c.gaps.some((g) => !g.includes("ara maliyet"))) returnCostIncomplete++;
    const t = returnCosts.get(c.currency) ?? { repair: 0n, scrap: 0n, replacement: 0n };
    t.repair += toMicro(c.totals.repair);
    t.scrap += toMicro(c.totals.scrap);
    t.replacement += toMicro(c.totals.replacement);
    returnCosts.set(c.currency, t);
  }
  return {
    from, to, rows,
    totals: [...totals.entries()].map(([currency, t]) => ({
      currency, revenue: money(t.revenue), cogs: money(t.cogs), grossProfit: money(t.revenue - t.cogs),
      grossMargin: t.revenue > 0n ? Number(fromMicro(divM(t.revenue - t.cogs, t.revenue))) : null,
    })),
    incompleteLines: incomplete,
    returns: {
      count: returns.rows[0].n, qty: fromMicro(toMicro(returns.rows[0].q)), creditNoteRequests: returns.rows[0].credit,
      costs: [...returnCosts.entries()].map(([currency, t]) => ({ currency, repair: money(t.repair), scrap: money(t.scrap), replacement: money(t.replacement), total: money(t.repair + t.scrap + t.replacement) })),
      decidedInPeriod: decided.length, costIncomplete: returnCostIncomplete,
    },
    notes: [
      "Gelir: sevk edilen miktar × sipariş birim fiyatı (vergi hariç, sipariş para birimi). Satılmamış stokta kâr gösterilmez.",
      "Satılan malın maliyeti: sevk edilen lotun güncel birim maliyeti (üretimden gelen lotta iş emri maliyet hesabı). Para birimi farklıysa sevk tarihindeki kurla çevrilir (kur ve kaynağı satırda).",
      "İadeler ve alacak belgeleri resmî muhasebe kaydı olmadığı için gelirden düşülmez; ayrıca gösterilir.",
      "Nakit akışı ve tahsilat bu rapora dahil değildir.",
    ],
  };
}
