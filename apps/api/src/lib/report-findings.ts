/**
 * W30 (yönetici raporları) — 8 rapor alanının bulgu/kanıt hesaplayıcıları.
 *
 * Bu dosya bir AI/LLM entegrasyonu DEĞİLDİR: her alan gerçek verilerden kural tabanlı
 * (deterministik) sayısal kanıt ve olası neden/seçenek metni üretir. `causeType` her zaman
 * 'hypothesis' veya 'insufficient_data' döner — bir hesaplama asla 'confirmed' (doğrulanmış neden)
 * dönmez; bu, migrations/033_reports_ai.sql'deki CHECK kısıtıyla da veri tabanı düzeyinde zorlanır
 * (talimat §6: "olası neden ile alternatif açıklamayı" birlikte ver, bir hipotezi kanıtlanmış gibi sunma).
 *
 * Veri yetersizse ("öneri üretmek için yeterli veri yok") causeType='insufficient_data' döner ve
 * requiresApproval=false olur (görev/öneri açılmaz).
 */
import type { Db } from "../db/pool";
import { computeMarginReport, metricData, ratio } from "../modules/costing";

export const REPORT_AREAS = [
  "fire_rework", "cost_margin", "supplier_performance", "stock_shortage",
  "capacity_leadtime", "revision_impact", "project_budget", "collections",
] as const;
export type ReportArea = (typeof REPORT_AREAS)[number];

export type FindingDraft = {
  area: ReportArea;
  finding: string;
  evidence: unknown;
  sourceRefs: string[];
  causeType: "hypothesis" | "insufficient_data";
  causeText: string | null;
  actionOptions: { option: string; note?: string }[];
  expectedImpact: unknown | null;
  uncertainty: string | null;
  responsibleRole: string;
  requiresApproval: boolean;
  successMetric: string;
  measurementDueAt: string | null;
};

export type ReportScope = { productId?: string | null; supplierId?: string | null };

const insufficientData = (
  area: ReportArea,
  reason: string,
  evidence: unknown,
  sourceRefs: string[],
  responsibleRole: string,
): FindingDraft => ({
  area,
  finding: "Öneri üretmek için yeterli veri yok.",
  evidence,
  sourceRefs,
  causeType: "insufficient_data",
  causeText: reason,
  actionOptions: [],
  expectedImpact: null,
  uncertainty: reason,
  responsibleRole,
  requiresApproval: false,
  successMetric: "—",
  measurementDueAt: null,
});

const MIN_SAMPLE = 5;
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ---- 1. Fire ve yeniden işleme ------------------------------------------------------------
export async function computeFireRework(db: Db, from: string, to: string, scope: ReportScope): Promise<FindingDraft> {
  const productId = scope.productId ?? null;
  const [scrap, fpy, rework] = await Promise.all([
    metricData(db, "scrap_rate", from, to, productId),
    metricData(db, "first_pass_yield", from, to, productId),
    metricData(db, "rework_rate", from, to, productId),
  ]);
  const evidence = {
    scrapRate: { numerator: scrap.numerator, denominator: scrap.denominator, value: ratio(scrap.numerator, scrap.denominator) },
    firstPassYield: { numerator: fpy.numerator, denominator: fpy.denominator, value: ratio(fpy.numerator, fpy.denominator) },
    reworkRate: { numerator: rework.numerator, denominator: rework.denominator, value: ratio(rework.numerator, rework.denominator) },
  };
  const sourceRefs = ["GET /api/metrics?key=scrap_rate", "GET /api/metrics?key=first_pass_yield", "GET /api/metrics?key=rework_rate"];
  if ((scrap.denominator ?? 0) < MIN_SAMPLE) {
    return insufficientData(
      "fire_rework",
      `Dönemde üretime alınan cihaz sayısı (${scrap.denominator ?? 0}) güvenilir bir oran için yetersiz (asgari ${MIN_SAMPLE}).`,
      evidence, sourceRefs, "quality",
    );
  }
  const scrapPct = (ratio(scrap.numerator, scrap.denominator) ?? 0) * 100;
  const fpyPct = ratio(fpy.numerator, fpy.denominator);
  return {
    area: "fire_rework",
    finding: `Dönemde hurda oranı %${scrapPct.toFixed(2)} (${scrap.numerator}/${scrap.denominator}), ilk testte başarı ${fpyPct === null ? "hesaplanamadı" : `%${(fpyPct * 100).toFixed(2)}`}, yeniden işleme oranı %${((ratio(rework.numerator, rework.denominator) ?? 0) * 100).toFixed(2)}.`,
    evidence, sourceRefs,
    causeType: "hypothesis",
    causeText: "Olası neden: süreç/ekipman sapması veya komponent/parti kalitesi. Alternatif açıklama: dönem içi ürün karması değişimi (daha zor bir üründe hurda oranı doğal olarak yüksek olabilir) veya operatör deneyim farkı.",
    actionOptions: [
      { option: "Süreç incelemesi başlat", note: "İlgili iş merkezi/operasyonda kök neden analizi" },
      { option: "Kontrollü deneme (pilot) planla", note: "Şüphelenilen değişkeni küçük ölçekte test et" },
    ],
    expectedImpact: { note: "Hurda oranında 1 puanlık azalmanın parasal etkisi, ilgili iş emirlerinin maliyet hesabından ayrıca çıkarılmalı (bu bulgu yalnız oranları kapsar)." },
    uncertainty: "Küçük örneklemde (denominator az) oran dönemden döneme oynak olabilir.",
    responsibleRole: "quality",
    requiresApproval: true,
    successMetric: "scrap_rate ve first_pass_yield",
    measurementDueAt: addDays(to, 30),
  };
}

// ---- 2. Gerçek maliyet ve kârlılık --------------------------------------------------------
export async function computeCostMargin(db: Db, from: string, to: string): Promise<FindingDraft> {
  const margin = await computeMarginReport(db, from, to);
  const sourceRefs = ["GET /api/reports/margin"];
  if (margin.totals.length === 0) {
    return insufficientData("cost_margin", "Dönemde sevk edilmiş ve fiyatı/maliyeti eşleşen satır yok; kâr hesaplanamadı.", margin, sourceRefs, "accounting");
  }
  const lines = margin.totals.map((t) => `${t.currency}: gelir ${t.revenue}, SMM ${t.cogs}, brüt kâr ${t.grossProfit}${t.grossMargin === null ? " (marj hesaplanamadı)" : `, marj %${(t.grossMargin * 100).toFixed(2)}`}`);
  return {
    area: "cost_margin",
    finding: `Dönem kârlılığı: ${lines.join("; ")}.${margin.incompleteLines ? ` ${margin.incompleteLines} satır fiyat/maliyet eksikliği nedeniyle hesaba dahil edilemedi.` : ""}`,
    evidence: margin, sourceRefs,
    causeType: "hypothesis",
    causeText: "Marjdaki değişim satış fiyatı, girdi/işçilik maliyeti veya ürün karması etkisinden herhangi birinden (ya da birden fazlasından) kaynaklanıyor olabilir; bu hesap bunları ayrıştırmaz.",
    actionOptions: [
      { option: "Fiyat gözden geçirme", note: "Etkilenen ürün/revizyon için fiyat senaryosu" },
      { option: "Maliyet gözden geçirme", note: "Malzeme/işçilik/dış hizmet kalemlerini ayrı ayrı incele" },
      { option: "Ürün karması incelemesi", note: "Marjı düşük ürünlerin toplam satıştaki payı arttı mı" },
    ],
    expectedImpact: null,
    uncertainty: "Gelir sıfırsa veya kur/maliyet eksikse ilgili satır hesap dışıdır (bkz. incompleteLines).",
    responsibleRole: "accounting",
    requiresApproval: true,
    successMetric: "grossMargin (para birimi bazında)",
    measurementDueAt: addDays(to, 30),
  };
}

// ---- 3. Tedarikçi performansı --------------------------------------------------------------
export async function computeSupplierPerformance(db: Db, from: string, to: string, scope: ReportScope): Promise<FindingDraft> {
  const supplierId = scope.supplierId ?? null;
  const delivery = await db.query(
    `select s.id as "supplierId", s.name as "supplierName",
            count(*)::int as "receiptCount",
            count(*) filter (where gr.received_at::date > coalesce(c.confirmed_date, pol.confirmed_date))::int as "lateCount",
            avg((gr.received_at::date - coalesce(c.confirmed_date, pol.confirmed_date)))
              filter (where coalesce(c.confirmed_date, pol.confirmed_date) is not null) as "avgDelayDays"
       from goods_receipts gr
       join purchase_order_lines pol on pol.id = gr.po_line_id
       join suppliers s on s.id = pol.supplier_id
       left join lateral (
         select confirmed_date from po_confirmations where po_line_id = pol.id order by created_at desc limit 1
       ) c on true
      where gr.received_at >= $1::date and gr.received_at < ($2::date + 1) and ($3::uuid is null or s.id = $3)
      group by s.id, s.name`,
    [from, to, supplierId],
  );
  const quality = await db.query(
    `select s.id as "supplierId", coalesce(sum(i.accepted_qty), 0) as accepted, coalesce(sum(i.rejected_qty), 0) as rejected
       from inspections i
       join goods_receipt_lines grl on grl.id = i.receipt_line_id
       join goods_receipts gr on gr.id = grl.receipt_id
       join purchase_order_lines pol on pol.id = gr.po_line_id
       join suppliers s on s.id = pol.supplier_id
      where i.decided_at >= $1::date and i.decided_at < ($2::date + 1) and ($3::uuid is null or s.id = $3)
      group by s.id`,
    [from, to, supplierId],
  );
  const cost = await db.query(
    `select s.id as "supplierId", pol.currency, coalesce(sum(grl.qty * pol.unit_price), 0) as total
       from goods_receipt_lines grl
       join goods_receipts gr on gr.id = grl.receipt_id
       join purchase_order_lines pol on pol.id = gr.po_line_id
       join suppliers s on s.id = pol.supplier_id
      where gr.received_at >= $1::date and gr.received_at < ($2::date + 1) and pol.unit_price is not null and pol.currency is not null
        and ($3::uuid is null or s.id = $3)
      group by s.id, pol.currency`,
    [from, to, supplierId],
  );
  const qMap = new Map(quality.rows.map((r) => [r.supplierId, r]));
  const costMap = new Map<string, { currency: string; total: string }[]>();
  for (const r of cost.rows) costMap.set(r.supplierId, [...(costMap.get(r.supplierId) ?? []), { currency: r.currency, total: r.total }]);
  const rows = delivery.rows.map((r) => {
    const q = qMap.get(r.supplierId);
    const rejectRate = q ? ratio(Number(q.rejected), Number(q.accepted) + Number(q.rejected)) : null;
    return {
      supplierId: r.supplierId, supplierName: r.supplierName, receiptCount: r.receiptCount, lateCount: r.lateCount,
      avgDelayDays: r.avgDelayDays === null ? null : Number(Number(r.avgDelayDays).toFixed(1)),
      rejectRate, purchaseCost: costMap.get(r.supplierId) ?? [],
    };
  });
  const evidence = { suppliers: rows };
  const sourceRefs = ["goods_receipts", "po_confirmations", "inspections", "purchase_order_lines"];
  if (rows.length === 0) {
    return insufficientData("supplier_performance", "Dönemde bu kapsamda mal kabul kaydı yok.", evidence, sourceRefs, "purchasing");
  }
  const worst = [...rows].sort((a, b) => (b.lateCount / Math.max(b.receiptCount, 1)) - (a.lateCount / Math.max(a.receiptCount, 1)))[0]!;
  return {
    area: "supplier_performance",
    finding: `${rows.length} tedarikçi değerlendirildi. En düşük performans: ${worst.supplierName} — ${worst.lateCount}/${worst.receiptCount} teslimat geç, ${worst.rejectRate === null ? "ret oranı hesaplanamadı" : `ret oranı %${(worst.rejectRate * 100).toFixed(2)}`}.`,
    evidence, sourceRefs,
    causeType: "hypothesis",
    causeText: "Olası neden: tedarikçinin kapasite/lojistik sorunu veya kalite süreci. Alternatif açıklama: teyit tarihinin gerçekçi girilmemesi veya tek seferlik istisnai sevkiyat.",
    actionOptions: [
      { option: "Onaylı ikinci kaynağı değerlendir", note: `${worst.supplierName} için alternatif tedarikçi araştırması` },
      { option: "Tedarikçi performans görüşmesi", note: "Gecikme ve ret nedenlerini tedarikçiyle netleştir" },
    ],
    expectedImpact: null,
    uncertainty: "Az sayıda mal kabulü olan tedarikçilerde oranlar tek olaydan etkilenebilir.",
    responsibleRole: "purchasing",
    requiresApproval: true,
    successMetric: "lateCount/receiptCount ve rejectRate",
    measurementDueAt: addDays(to, 60),
  };
}

// ---- 4. Stok ve eksik malzeme ---------------------------------------------------------------
export async function computeStockShortage(db: Db, _from: string, to: string, _scope: ReportScope): Promise<FindingDraft> {
  // Not: bu alan bileşen (component) düzeyinde çalışır; productId kapsam filtresi henüz desteklenmiyor
  // (bir ürünün eksikleri, ürünün kendi kalemi değil altındaki bileşenlerdir).
  const rows = await db.query(
    `with balances as (
       select item_id, sum(qty) as onhand from stock_moves m
        cross join lateral (values (m.to_location_id, m.qty), (m.from_location_id, -m.qty)) as l(location_id, delta)
        where l.location_id is not null group by item_id
     ),
     reserved as (
       select item_id, sum(qty) as qty from reservations where status = 'active' group by item_id
     ),
     open_po as (
       select item_id, sum(qty_ordered - qty_received) as qty from purchase_order_lines where status = 'open' group by item_id
     )
     select i.id as "itemId", i.code, i.name,
            coalesce(b.onhand, 0) as onhand, coalesce(r.qty, 0) as reserved, coalesce(p.qty, 0) as "openPurchase"
       from items i
       left join balances b on b.item_id = i.id
       left join reserved r on r.item_id = i.id
       left join open_po p on p.item_id = i.id
      where (coalesce(r.qty, 0) > 0 or coalesce(p.qty, 0) > 0)
      order by (coalesce(r.qty, 0) - coalesce(b.onhand, 0)) desc
      limit 50`,
  );
  const shortages = rows.rows
    .map((r) => ({ ...r, shortfall: Number(r.reserved) - Number(r.onhand) }))
    .filter((r) => r.shortfall > 0);
  const evidence = { candidates: rows.rows.length, shortages };
  const sourceRefs = ["reservations", "stock_moves", "purchase_order_lines"];
  if (rows.rows.length === 0) {
    return insufficientData("stock_shortage", "Aktif rezervasyon veya açık satın alma satırı bulunamadı.", evidence, sourceRefs, "warehouse");
  }
  if (shortages.length === 0) {
    return insufficientData("stock_shortage", "Değerlendirilen kalemlerde rezervasyonu aşan stok açığı görülmedi.", evidence, sourceRefs, "warehouse");
  }
  return {
    area: "stock_shortage",
    finding: `${shortages.length} kalemde aktif rezervasyon eldeki stoğu aşıyor. En kritik: ${shortages[0].code} — açık ${shortages[0].shortfall}, açık satın alma ${shortages[0].openPurchase}.`,
    evidence, sourceRefs,
    causeType: "hypothesis",
    causeText: "Olası neden: sipariş zamanlaması/miktarı ihtiyacı karşılamıyor. Alternatif açıklama: rezervasyon güncel talebi yansıtmıyor olabilir (iptal edilen sipariş rezervasyonu serbest bırakılmamış olabilir).",
    actionOptions: [
      { option: "Sipariş zamanlama/miktar senaryosu", note: "Açık satın alma miktarını ihtiyaca göre güncelle" },
      { option: "Rezervasyonları gözden geçir", note: "Güncel talebi yansıtmayan rezervasyonları serbest bırak" },
    ],
    expectedImpact: null,
    uncertainty: "Eldeki stok, konum bazında kullanılamaz (karantina) miktarları ayırmadan hesaplandı.",
    responsibleRole: "purchasing",
    requiresApproval: true,
    successMetric: "reserved - onhand (kalem bazında)",
    measurementDueAt: addDays(to, 14),
  };
}

// ---- 5. Kapasite ve termin -------------------------------------------------------------------
export async function computeCapacityLeadtime(db: Db, from: string, to: string): Promise<FindingDraft> {
  const queue = await db.query(
    `select wc.id as "workCenterId", wc.code, wc.name, count(*)::int as "pending"
       from work_order_operations o join work_centers wc on wc.id = o.work_center_id
       join work_orders w on w.id = o.work_order_id
      where o.status in ('pending', 'in_progress') and w.status in ('released', 'in_progress')
      group by wc.id, wc.code, wc.name order by count(*) desc limit 20`,
  );
  const cycle = await db.query(
    `select w.id, w.code, w.due_date, w.released_at, w.completed_at,
            extract(epoch from (w.completed_at - w.released_at)) / 86400 as "cycleDays",
            (w.due_date is not null and w.completed_at::date > w.due_date) as late
       from work_orders w
      where w.completed_at is not null and w.completed_at >= $1::date and w.completed_at < ($2::date + 1) and w.released_at is not null`,
    [from, to],
  );
  const lateOpen = await db.query(
    `select count(*)::int as n from work_orders where status in ('released', 'in_progress') and due_date is not null and due_date < current_date`,
  );
  const done = cycle.rows;
  const avgCycle = done.length ? done.reduce((a, r) => a + Number(r.cycleDays), 0) / done.length : null;
  const lateCount = done.filter((r) => r.late).length + lateOpen.rows[0].n;
  const evidence = { queueByWorkCenter: queue.rows, completedInPeriod: done.length, avgCycleDays: avgCycle, lateOpenWorkOrders: lateOpen.rows[0].n, lateCompletedInPeriod: done.filter((r) => r.late).length };
  const sourceRefs = ["work_order_operations", "work_orders"];
  if (queue.rows.length === 0 && done.length === 0) {
    return insufficientData("capacity_leadtime", "Dönemde kuyrukta iş veya tamamlanmış iş emri bulunamadı.", evidence, sourceRefs, "production");
  }
  const bottleneck = queue.rows[0];
  return {
    area: "capacity_leadtime",
    finding: `${lateCount} iş emri terminde gecikmiş veya gecikme riski taşıyor.${bottleneck ? ` En yoğun iş merkezi: ${bottleneck.name} (${bottleneck.pending} bekleyen operasyon).` : ""}${avgCycle !== null ? ` Dönemde tamamlanan iş emirlerinde ortalama çevrim süresi ${avgCycle.toFixed(1)} gün.` : ""}`,
    evidence, sourceRefs,
    causeType: "hypothesis",
    causeText: "Olası neden: darboğaz iş merkezinde kapasite yetersizliği. Alternatif açıklama: malzeme eksikliği nedeniyle operasyon başlayamıyor olabilir (kapasite değil malzeme kısıtı).",
    actionOptions: [
      { option: "Sıralama/önceliklendirme gözden geçir", note: "Termin riski taşıyan iş emirlerini öne al" },
      { option: "Kapasite transferi", note: "Darboğaz iş merkezine ek vardiya/operatör" },
      { option: "Fason değerlendirmesi", note: "Uygun operasyonları dış kaynağa aktarma senaryosu" },
    ],
    expectedImpact: null,
    uncertainty: "Malzeme durumu bu hesaba dahil değildir; gecikme nedeninin kapasite mi malzeme mi olduğu ayrıca doğrulanmalı.",
    responsibleRole: "production",
    requiresApproval: true,
    successMetric: "geciken iş emri sayısı ve ortalama çevrim süresi",
    measurementDueAt: addDays(to, 14),
  };
}

// ---- 6. Revizyon etkisi -----------------------------------------------------------------------
export async function computeRevisionImpact(db: Db, from: string, to: string, scope: ReportScope): Promise<FindingDraft> {
  const sourceRefs = ["product_revisions", "GET /api/metrics?key=scrap_rate", "GET /api/metrics?key=first_pass_yield"];
  if (!scope.productId) {
    return insufficientData("revision_impact", "Bu alan bir ürün seçilmeden hesaplanamaz.", null, sourceRefs, "rd");
  }
  const rev = (await db.query(
    `select id, rev, released_at::date::text as "releasedAt" from product_revisions
      where product_id = $1 and released_at is not null and released_at::date between $2::date and $3::date
      order by released_at desc limit 1`,
    [scope.productId, from, to],
  )).rows[0];
  if (!rev) {
    return insufficientData("revision_impact", "Bu dönemde bu ürün için yayımlanmış (released_at) bir revizyon bulunamadı.", null, sourceRefs, "rd");
  }
  const [before, after] = await Promise.all([
    metricData(db, "scrap_rate", from, rev.releasedAt, scope.productId),
    metricData(db, "scrap_rate", rev.releasedAt, to, scope.productId),
  ]);
  const [fpyBefore, fpyAfter] = await Promise.all([
    metricData(db, "first_pass_yield", from, rev.releasedAt, scope.productId),
    metricData(db, "first_pass_yield", rev.releasedAt, to, scope.productId),
  ]);
  const evidence = {
    revision: rev,
    scrapRate: { before: { ...before, value: ratio(before.numerator, before.denominator) }, after: { ...after, value: ratio(after.numerator, after.denominator) } },
    firstPassYield: { before: { ...fpyBefore, value: ratio(fpyBefore.numerator, fpyBefore.denominator) }, after: { ...fpyAfter, value: ratio(fpyAfter.numerator, fpyAfter.denominator) } },
  };
  if ((before.denominator ?? 0) < MIN_SAMPLE || (after.denominator ?? 0) < MIN_SAMPLE) {
    return insufficientData(
      "revision_impact",
      `Revizyon öncesi (${before.denominator ?? 0}) veya sonrası (${after.denominator ?? 0}) cihaz sayısı karşılaştırma için yetersiz (asgari ${MIN_SAMPLE}).`,
      evidence, sourceRefs, "rd",
    );
  }
  const scrapBeforeV = ratio(before.numerator, before.denominator) ?? 0;
  const scrapAfterV = ratio(after.numerator, after.denominator) ?? 0;
  const improved = scrapAfterV < scrapBeforeV;
  return {
    area: "revision_impact",
    finding: `Rev.${rev.rev} (${rev.releasedAt}) öncesi hurda oranı %${(scrapBeforeV * 100).toFixed(2)}, sonrası %${(scrapAfterV * 100).toFixed(2)} — ${improved ? "iyileşme" : "kötüleşme veya değişim yok"} yönünde.`,
    evidence, sourceRefs,
    causeType: "hypothesis",
    causeText: `Olası neden: revizyonun kendisi (tasarım/BOM değişikliği). Alternatif açıklama: aynı dönemde başka bir değişiklik (operatör, komponent partisi, süreç) eşzamanlı etkide bulunmuş olabilir.`,
    actionOptions: improved
      ? [{ option: "Daha geniş üretime yayılım", note: "Bulguyu diğer üretim hatlarına/vardiyalara genişlet" }]
      : [{ option: "Ek doğrulama", note: "Revizyonu geçici olarak durdurup ek test/analiz yap" }],
    expectedImpact: null,
    uncertainty: "Örneklem küçükse (denominator asgari sınıra yakın) sonuç dönemsel gürültüden etkilenebilir.",
    responsibleRole: "rd",
    requiresApproval: true,
    successMetric: "scrap_rate ve first_pass_yield (revizyon öncesi/sonrası)",
    measurementDueAt: addDays(to, 30),
  };
}

// ---- 7. Proje bütçesi -----------------------------------------------------------------------
export async function computeProjectBudget(): Promise<FindingDraft> {
  // Onaylı proje/bütçe kaydı tutan bir modül henüz yok (bkz. costing.ts METRICS.budget_variance notu).
  return insufficientData(
    "project_budget",
    "Onaylı proje/bütçe kaydı tutan bir modül yok; bu alan hesaplanamaz.",
    null, ["packages/shared (proje/bütçe tablosu planlandı, henüz yok)"], "accounting",
  );
}

// ---- 8. Tahsilat ------------------------------------------------------------------------------
export async function computeCollections(db: Db, from: string, to: string): Promise<FindingDraft> {
  const r = await db.query(
    `select ci.currency, count(*)::int as "openCount",
            coalesce(sum(ci.gross_amount - coalesce((select sum(rc.amount) from customer_receipts rc where rc.invoice_id = ci.id), 0)), 0) as "openAmount",
            max(current_date - ci.due_date) as "maxOverdueDays"
       from customer_invoices ci
      where ci.status = 'issued' and ci.due_date < current_date
      group by ci.currency`,
  );
  const evidence = { overdue: r.rows };
  const sourceRefs = ["GET /api/receivables/aging", "customer_invoices", "customer_receipts"];
  if (r.rows.length === 0) {
    return insufficientData("collections", "Vadesi geçmiş, açık müşteri faturası yok.", evidence, sourceRefs, "accounting");
  }
  const worst = [...r.rows].sort((a, b) => b.maxOverdueDays - a.maxOverdueDays)[0];
  return {
    area: "collections",
    finding: `${r.rows.reduce((a, x) => a + x.openCount, 0)} açık vadesi geçmiş fatura var. En uzun gecikme ${worst.maxOverdueDays} gün (${worst.currency}).`,
    evidence, sourceRefs,
    causeType: "hypothesis",
    causeText: "Olası neden: müşteri ödeme gecikmesi. Alternatif açıklama: fatura/teslimat kaydında hata (yanlış vade veya tahsilat kaydedilmemiş olabilir).",
    actionOptions: [{ option: "Muhasebe takip görevi aç", note: "Tahsilat takibi — müşteriye doğrudan mesaj bu sistemden gönderilmez, yetkilendirme gerekir" }],
    expectedImpact: null,
    uncertainty: "Tahsilat kaydı gecikmiş olabilir; tutar güncel olmayabilir.",
    responsibleRole: "accounting",
    requiresApproval: true,
    successMetric: "openAmount ve maxOverdueDays",
    measurementDueAt: addDays(to, 14),
  };
}

export async function computeArea(db: Db, area: ReportArea, from: string, to: string, scope: ReportScope): Promise<FindingDraft> {
  switch (area) {
    case "fire_rework": return computeFireRework(db, from, to, scope);
    case "cost_margin": return computeCostMargin(db, from, to);
    case "supplier_performance": return computeSupplierPerformance(db, from, to, scope);
    case "stock_shortage": return computeStockShortage(db, from, to, scope);
    case "capacity_leadtime": return computeCapacityLeadtime(db, from, to);
    case "revision_impact": return computeRevisionImpact(db, from, to, scope);
    case "project_budget": return computeProjectBudget();
    case "collections": return computeCollections(db, from, to);
  }
}
