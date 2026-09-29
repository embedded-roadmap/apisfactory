import type { Db } from "../db/pool";
import { recordEvent, type Actor } from "./records";

/**
 * R05 — Devirde Ar-Ge maliyeti (ana talimat §8).
 *
 * Kaynaklar ve sayım kuralları (aynı gider iki kez sayılmaz):
 *  - Satın alma: projeye bağlı talepten doğan her sipariş satırı TEK kez sayılır. Faturalanan kısım gerçek tutardır
 *    (tedarikçi faturası satırı, reddedilen/iptal edilen fatura hariç); teslim alınmış ama faturası gelmemiş miktar
 *    sipariş fiyatıyla TAHAKKUK olarak eklenir ve raporu geçici yapar. Teslim alınmamış açık miktar maliyet değildir,
 *    yalnız "açık taahhüt" olarak gösterilir (raporu yine geçici yapar — fatura gelecek).
 *  - Elle bölüştürülen giderler (R04, `project_cost_allocations`): kategori ile. Projenin sipariş satırlarıyla zaten
 *    sayılan bir tedarikçi faturası bölüştürmeye kaynak gösterilemez (bkz. `assertNotDoubleCounted`).
 *  - Mühendislik zamanı: her kayıt, çalışma tarihinde geçerli Ar-Ge saat ücretiyle; ters kayıt aynı tarih ve ücretle
 *    kendini sıfırlar. Ücreti olmayan saat fiyatlanmaz ve raporu geçici yapar.
 * Para birimleri dönüştürülmez; toplamlar para birimine göre ayrıdır.
 */

export const RD_COST_CATEGORIES = ["prototype_material", "pcb_assembly", "external_service", "test", "other"] as const;
export type RdCostCategory = (typeof RD_COST_CATEGORIES)[number];
export const RD_ACTIVITIES = ["design", "layout", "firmware", "prototype", "test", "documentation", "other"] as const;

type Category = RdCostCategory | "engineering_time";

/** "123.45" → 12345n (kuruş). Girdi pg numeric metnidir; en çok 2 ondalığa yuvarlanmış gelir. */
function cents(v: string | number | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  const s = String(v);
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  const c = BigInt(i || "0") * 100n + BigInt((f + "00").slice(0, 2));
  return neg ? -c : c;
}
function money(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}

type Bucket = { invoiced: bigint; accrued: bigint; allocated: bigint; engineering: bigint; openCommitment: bigint; byCategory: Map<Category, bigint> };
function bucket(map: Map<string, Bucket>, currency: string): Bucket {
  let b = map.get(currency);
  if (!b) {
    b = { invoiced: 0n, accrued: 0n, allocated: 0n, engineering: 0n, openCommitment: 0n, byCategory: new Map() };
    map.set(currency, b);
  }
  return b;
}
function addCat(b: Bucket, cat: Category, c: bigint) {
  b.byCategory.set(cat, (b.byCategory.get(cat) ?? 0n) + c);
}

export async function computeRdCost(db: Db, projectId: string) {
  const project = (await db.query(`select id, code, name, status from rd_projects where id = $1`, [projectId])).rows[0];
  if (!project) return null;
  const totals = new Map<string, Bucket>();
  const provisionalReasons: string[] = [];

  const lines = (await db.query(
    `select pol.id, pol.po_code as "poCode", i.code as "itemCode", pol.currency, pol.unit_price as "unitPrice",
            pol.qty_ordered as "qtyOrdered", pol.qty_received as "qtyReceived", pol.status,
            coalesce(pr.rd_cost_category, 'prototype_material') as category, pr.code as "requestCode",
            coalesce(inv.qty, 0) as "invoicedQty", inv.amount as "invoicedAmount", inv.currencies, inv.codes as "invoiceCodes",
            case when pol.unit_price is null then null
                 else round(greatest(pol.qty_received - coalesce(inv.qty, 0), 0) * pol.unit_price, 2) end as accrued,
            case when pol.unit_price is null or pol.status <> 'open' then 0
                 else round(greatest(pol.qty_ordered - pol.qty_received, 0) * pol.unit_price, 2) end as "openAmount"
       from purchase_order_lines pol
       join purchase_requests pr on pr.id = pol.purchase_request_id
       join items i on i.id = pol.item_id
       left join lateral (
         select sum(sil.qty) as qty, sum(sil.amount) as amount, array_agg(distinct si.currency) as currencies,
                array_agg(distinct si.code) as codes
           from supplier_invoice_lines sil join supplier_invoices si on si.id = sil.invoice_id
          where sil.po_line_id = pol.id and si.status not in ('rejected', 'cancelled')
       ) inv on true
      where pr.project_id = $1 and pol.status <> 'cancelled'
      order by pol.po_code, i.code`,
    [projectId],
  )).rows;

  const purchased = [];
  for (const l of lines) {
    const cat = l.category as RdCostCategory;
    const invCurrency: string | null = l.currencies?.length === 1 ? l.currencies[0] : null;
    if (l.currencies && l.currencies.length > 1) provisionalReasons.push(`${l.poCode} ${l.itemCode}: faturalar farklı para birimlerinde`);
    if (l.invoicedAmount !== null && invCurrency) {
      const b = bucket(totals, invCurrency);
      b.invoiced += cents(l.invoicedAmount);
      addCat(b, cat, cents(l.invoicedAmount));
    }
    if (l.unitPrice === null) {
      provisionalReasons.push(`${l.poCode} ${l.itemCode}: sipariş fiyatı yok, tahakkuk hesaplanamadı`);
    } else if (l.currency) {
      const b = bucket(totals, l.currency);
      const acc = cents(l.accrued);
      if (acc > 0n) {
        b.accrued += acc;
        addCat(b, cat, acc);
        provisionalReasons.push(`${l.poCode} ${l.itemCode}: teslim alınan miktarın faturası gelmedi (tahakkuk ${money(acc)} ${l.currency})`);
      }
      const open = cents(l.openAmount);
      if (open > 0n) {
        b.openCommitment += open;
        provisionalReasons.push(`${l.poCode} ${l.itemCode}: açık sipariş miktarı var (taahhüt ${money(open)} ${l.currency})`);
      }
    }
    purchased.push({
      poLineId: l.id, poCode: l.poCode, itemCode: l.itemCode, requestCode: l.requestCode, category: cat,
      qtyOrdered: l.qtyOrdered, qtyReceived: l.qtyReceived, invoicedQty: String(l.invoicedQty), unitPrice: l.unitPrice, currency: l.currency,
      invoicedAmount: l.invoicedAmount === null ? null : money(cents(l.invoicedAmount)), invoiceCurrency: invCurrency, invoiceCodes: l.invoiceCodes ?? [],
      accruedAmount: l.accrued === null ? null : money(cents(l.accrued)), openAmount: money(cents(l.openAmount)),
    });
  }

  const allocations = (await db.query(
    `select id, amount, currency, category, description, source_ref as "sourceRef", allocated_at as "allocatedAt"
       from project_cost_allocations where project_id = $1 order by allocated_at`,
    [projectId],
  )).rows;
  for (const a of allocations) {
    const b = bucket(totals, a.currency);
    b.allocated += cents(a.amount);
    addCat(b, a.category, cents(a.amount));
  }

  const time = (await db.query(
    `select t.id, t.work_date as "workDate", t.hours, t.activity, t.reverses_entry_id as "reversesEntryId", u.name as "userName",
            r.rate_per_hour as rate, r.currency, case when r.rate_per_hour is null then null else round(t.hours * r.rate_per_hour, 2) end as amount
       from rd_time_entries t join users u on u.id = t.user_id
       left join lateral (
         select rate_per_hour, currency from rd_labor_rates where effective_from <= t.work_date order by effective_from desc limit 1
       ) r on true
      where t.project_id = $1 order by t.work_date, t.created_at`,
    [projectId],
  )).rows;
  let hours = 0n; // yüzde birim saat
  let unpricedHours = 0n;
  const byActivity = new Map<string, bigint>();
  for (const t of time) {
    const h = cents(t.hours);
    hours += h;
    byActivity.set(t.activity, (byActivity.get(t.activity) ?? 0n) + h);
    if (t.amount === null) unpricedHours += h;
    else {
      const b = bucket(totals, t.currency);
      b.engineering += cents(t.amount);
      addCat(b, "engineering_time", cents(t.amount));
    }
  }
  if (unpricedHours !== 0n) provisionalReasons.push(`${money(unpricedHours)} saat mühendislik zamanının tarihinde geçerli Ar-Ge saat ücreti yok`);

  const categories: Category[] = ["prototype_material", "pcb_assembly", "engineering_time", "external_service", "test", "other"];
  const byCurrency = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, b]) => ({
    currency,
    invoiced: money(b.invoiced), accrued: money(b.accrued), allocated: money(b.allocated), engineering: money(b.engineering),
    total: money(b.invoiced + b.accrued + b.allocated + b.engineering),
    openCommitment: money(b.openCommitment),
    byCategory: Object.fromEntries(categories.map((c) => [c, money(b.byCategory.get(c) ?? 0n)])),
  }));

  return {
    project: { id: project.id, code: project.code, name: project.name, status: project.status },
    computedAt: new Date().toISOString(),
    status: provisionalReasons.length ? ("provisional" as const) : ("final" as const),
    provisionalReasons,
    byCurrency,
    purchased,
    allocations: allocations.map((a) => ({ ...a, amount: money(cents(a.amount)) })),
    engineering: {
      hours: money(hours), unpricedHours: money(unpricedHours), entries: time.length,
      byActivity: [...byActivity.entries()].map(([activity, h]) => ({ activity, hours: money(h) })),
    },
    limitations: [
      "Projeye bağlı talebin stoktan karşılanan kısmı için stok çıkışı/maliyet kaydı oluşmaz; bu malzeme rapora girmez.",
      "Para birimleri dönüştürülmez; her para birimi ayrı toplanır.",
    ],
  };
}

/**
 * Elle bölüştürmede çift sayım koruması: kaynak olarak verilen tedarikçi faturası (iç kod veya tedarikçi fatura no.),
 * bu projenin sipariş satırlarına bağlı bir satır içeriyorsa o tutar rapora zaten satın alma olarak girer.
 */
export async function doubleCountedInvoice(db: Db, projectId: string, sourceRef: string): Promise<string | null> {
  const r = await db.query(
    `select si.code from supplier_invoices si
      where (si.code = $2 or si.invoice_no = $2) and si.status not in ('rejected', 'cancelled')
        and exists (select 1 from supplier_invoice_lines sil
                      join purchase_order_lines pol on pol.id = sil.po_line_id
                      join purchase_requests pr on pr.id = pol.purchase_request_id
                     where sil.invoice_id = si.id and pr.project_id = $1)
      limit 1`,
    [projectId, sourceRef.trim()],
  );
  return r.rows[0]?.code ?? null;
}

/** Revizyon için yeni rapor sürümü yazar (devirde sürüm 1; sonra gerekçeli yeniden hesaplama). */
export async function writeRdCostReport(db: Db, actor: Actor, revisionId: string, projectId: string, trigger: "handover" | "recalculation", reason: string | null) {
  const report = (await computeRdCost(db, projectId))!;
  await db.query(`select pg_advisory_xact_lock(hashtext('rd_cost_report:' || $1::text))`, [revisionId]);
  const prev = (await db.query(
    `select version_no, report from rd_cost_reports where revision_id = $1 order by version_no desc limit 1`,
    [revisionId],
  )).rows[0];
  const versionNo = (prev?.version_no ?? 0) + 1;
  const r = await db.query(
    `insert into rd_cost_reports (company_id, revision_id, project_id, version_no, status, trigger, report, reason, created_by)
     values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id, created_at as "createdAt"`,
    [revisionId, projectId, versionNo, report.status, trigger, JSON.stringify(report), reason, actor.userId],
  );
  const changes = prev ? diffTotals(prev.report.byCurrency, report.byCurrency) : [];
  await recordEvent(db, actor, {
    entityType: "product_revision", entityId: revisionId, eventType: `rd_cost.${trigger}`,
    after: { versionNo, status: report.status, projectId, totals: report.byCurrency.map((c) => ({ currency: c.currency, total: c.total })), changes },
    reason: reason ?? undefined,
  });
  return { id: r.rows[0].id as string, versionNo, status: report.status, createdAt: r.rows[0].createdAt, report, changes };
}

function diffTotals(before: { currency: string; total: string }[], after: { currency: string; total: string }[]) {
  const currencies = new Set([...before.map((b) => b.currency), ...after.map((a) => a.currency)]);
  const out = [];
  for (const c of [...currencies].sort()) {
    const b = cents(before.find((x) => x.currency === c)?.total ?? "0");
    const a = cents(after.find((x) => x.currency === c)?.total ?? "0");
    if (a !== b) out.push({ currency: c, before: money(b), after: money(a), delta: money(a - b) });
  }
  return out;
}
