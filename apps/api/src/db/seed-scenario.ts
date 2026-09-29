/**
 * DEMO senaryo verisi (kalan işler 2). `db/seed.ts` yalnız ana veriyi (kullanıcı, bileşen, tedarikçi) kurar; hareket verisi
 * olmadığından yönetici raporunun bütün alanları "yeterli veri yok" döner ve AI yorumu denenemez. Bu betik, DEMO-ELK
 * şirketinde GERÇEK API uçlarıyla (iş kuralları, yetkiler, olay kaydı dahil — doğrudan tablo yazımı yok) bir iş akışı
 * oynatır:
 *   ürün + BOM + devir → stok → satış siparişi → sevkiyat → fatura (45 gün önce kesilmiş → vadesi geçmiş)
 *   bütçeli Ar-Ge projesi → proje talebi → teklif → ödül (bütçe aşımı) → sipariş → teyit → mal kabul
 * Geçmiş tarihli olaylar da API'nin kabul ettiği alanlarla verilir (fatura tarihi, tedarikçi teyit tarihi); hiçbir
 * tutar/durum SQL ile elle yazılmaz.
 * Tekrar çalıştırılırsa (DEMO-KART-01 varsa) atlanır. Kullanım: pnpm db:seed-scenario
 * Sonuç (bu ay): tahsilat, proje bütçesi, tedarikçi performansı ve kârlılık alanları onay bekleyen bulgu üretir.
 * Üretim hareketi gerektiren alanlar (fire/yeniden işleme, kapasite, revizyon etkisi, stok açığı) veri yetersiz kalır.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../app";
import { config } from "../config";
import { DEMO_PASSWORD } from "./seed";

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

type Api = (who: string, method: "GET" | "POST", url: string, payload?: unknown) => Promise<any>;

/** Bitmiş ürün lotunun birim maliyeti (DEMO değeri) — kârlılık alanının hesaplanabilmesi için. */
export async function recordDemoLotCost(api: Api) {
  const lot = (await api("depo", "GET", "/api/lots/lookup?code=DK-LOT-01"))[0];
  await api("muhasebe", "POST", `/api/lots/${lot.id}/cost`, { unitCost: "1420.00", currency: "TRY", source: "manual", reference: "DEMO birim maliyet" });
}

export async function runScenario() {
  const owner = new pg.Client({ connectionString: config.migrationDatabaseUrl });
  await owner.connect();
  const app = await buildApp({ logger: false });
  try {
    const co = (await owner.query(`select id from companies where code = 'DEMO-ELK'`)).rows[0];
    if (!co) throw new Error("DEMO-ELK şirketi yok — önce `pnpm db:seed` çalıştırın");
    const A = co.id as string;
    await owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    if ((await owner.query(`select 1 from items where code = 'DEMO-KART-01'`)).rowCount) {
      console.log("Senaryo verisi zaten var; atlandı.");
      return;
    }

    const tokens = new Map<string, string>();
    const as = async (who: string) => {
      const email = `${who}@demo.apisfactory.com`;
      if (!tokens.has(email)) {
        const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: DEMO_PASSWORD } });
        if (r.statusCode !== 200) throw new Error(`giriş ${email}: ${r.body}`);
        tokens.set(email, r.json().token);
      }
      return tokens.get(email)!;
    };
    const api = async (who: string, method: "GET" | "POST", url: string, payload?: unknown) => {
      const r = await app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${await as(who)}`, "x-company-id": A } });
      if (r.statusCode >= 300) throw new Error(`${method} ${url} (${who}) → ${r.statusCode}: ${r.body}`);
      return r.json();
    };
    const step = (s: string) => console.log(`• ${s}`);

    // ---- 1) Ürün, BOM, devir ----
    step("Ürün, BOM ve devir (Ar-Ge → üretim → kalite)");
    const productId = (await api("arge", "POST", "/api/products", { code: "DEMO-KART-01", name: "DEMO Kontrol Kartı" })).id;
    const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
    const bomCsv = [
      "Designator;Manufacturer;MPN;Quantity;Description;DNP",
      "U1;DemoSemi;DS32F100-Q48;1;MCU;",
      "U2;DemoPower;DP3301-33;1;LDO;",
      "C1,C2,C3,C4;DemoPassive;DPC0603X106;4;Kondansatör;",
      "J1;DemoConn;DCN-2X5-127;1;Konnektör;",
    ].join("\n");
    const prev = await api("arge", "POST", "/api/imports/bom/preview", { productId, fileName: "demo-kart.csv", content: bomCsv, mapping });
    const bomId = (await api("arge", "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
    await api("arge", "POST", `/api/boms/${bomId}/publish`);
    const revId = (await api("arge", "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bomId })).id;
    await api("arge", "POST", `/api/revisions/${revId}/transition`, { action: "submit_handover" });
    for (const [who, area] of [["arge", "rd"], ["uretim", "production"], ["kalite", "quality"]] as const) {
      await api(who, "POST", `/api/revisions/${revId}/handover`, { area, decision: "approve" });
    }

    // ---- 2) Stok (bitmiş ürün) ----
    step("Bitmiş ürün stoğu içe aktarımı");
    const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
    const sp = await api("depo", "POST", "/api/imports/stock/preview", { fileName: "demo-stok.csv", content: "kod,miktar,lot,konum,rev\nDEMO-KART-01,6,DK-LOT-01,BTM,A", mapping: stockMapping });
    await api("depo", "POST", `/api/imports/${sp.jobId}/commit`, {});
    await recordDemoLotCost(api);

    // ---- 3) Satış → sevkiyat → fatura (45 gün önce kesilmiş → vadesi geçmiş) ----
    step("Satış siparişi, sevkiyat ve vadesi geçmiş fatura");
    const customerId = (await api("satis", "GET", "/api/customers")).find((c: any) => c.code === "MUS-001").id;
    const order = await api("satis", "POST", "/api/sales-orders", { customerId, requestedDate: day(-50), lines: [{ productRevisionId: revId, qty: "4", unitPrice: "1850", currency: "TRY" }] });
    await api("satis", "POST", `/api/sales-orders/${order.id}/confirm`);
    const sh = await api("depo", "POST", `/api/sales-orders/${order.id}/shipments`, { lines: [{ lineId: order.lines[0].id, qty: "4" }] });
    const pkg = (await api("depo", "GET", `/api/shipments/${sh.id}`)).packages[0].id;
    await api("depo", "POST", `/api/packages/${pkg}/items`, { code: "DK-LOT-01", qty: "4" });
    await api("depo", "POST", `/api/packages/${pkg}/close`, { checklist: { box: true, accessories: true, label: true, inspection: true }, weightKg: 2.4 });
    await api("depo", "POST", `/api/shipments/${sh.id}/pack-complete`);
    await api("depo", "POST", `/api/shipments/${sh.id}/ship`, { carrier: "DEMO Kargo" });
    const inv = await api("muhasebe", "POST", "/api/customer-invoices/from-shipment", { shipmentId: sh.id, taxRate: 20 });
    await api("muhasebe", "POST", `/api/customer-invoices/${inv.id}/issue`, { invoiceDate: day(-45) });

    // ---- 4) Bütçeli Ar-Ge projesi → satın alma (bütçe aşımı) ----
    step("Ar-Ge projesi (bütçe 5.000 TL) ve proje satın alması");
    const project = await api("arge", "POST", "/api/rd-projects", { name: "DEMO Yeni nesil sensör kartı", costCenter: "ARGE-01", budgetAmount: "5000.00", currency: "TRY", note: "DEMO senaryosu" });
    const mcu = (await owner.query(`select id from items where code = 'CMP-MCU-01'`)).rows[0].id;
    const pr = await api("arge", "POST", "/api/purchase-requests", { itemId: mcu, qty: "100", note: "DEMO prototip serisi", projectId: project.id });
    const prId = pr.id ?? pr.purchaseRequestId;
    await api("satinalma", "POST", `/api/purchase-requests/${prId}/decision`, { decision: "approve" });
    const supplier = (await api("satinalma", "GET", "/api/suppliers")).find((s: any) => s.code === "DEMO-DAG");
    const rfq = await api("satinalma", "POST", "/api/rfqs", { purchaseRequestId: prId });
    const q = await api("satinalma", "POST", `/api/rfqs/${rfq.id}/quotes`, { supplierId: supplier.id, unitPrice: "62.50", currency: "TRY", leadTimeDays: 7 });
    const award = await api("satinalma", "POST", `/api/rfqs/${rfq.id}/award`, { quoteId: q.quotes[0].id, reason: "DEMO: tek teklif" });
    const poId = award.poId as string;

    // ---- 5) Sipariş gönderimi, teyit, geç teslim ----
    step("Satın alma siparişi gönderimi, teyit ve geç mal kabulü");
    await api("satinalma", "POST", `/api/purchase-orders/${poId}/send`);
    const lineId = (await api("satinalma", "GET", `/api/purchase-orders/${poId}`)).lines[0].id;
    // Tedarikçi 8 gün önceye teslim teyidi vermiş; mal bugün geliyor → 8 gün gecikme (teyit ucu geçmiş tarihi kabul eder).
    await api("satinalma", "POST", `/api/purchase-orders/${poId}/lines/${lineId}/confirm`, { confirmedDate: day(-8), supplierReference: "DEMO-SO-1" });
    await api("depo", "POST", "/api/receipts", { supplierName: supplier.name, purchaseOrderLineId: lineId, lines: [{ itemId: mcu, lotNo: "DEMO-MCU-L1", qty: "100" }] });

    console.log("\nSenaryo verisi oluşturuldu. Yönetici raporunda (bu ay) tahsilat, proje bütçesi ve tedarikçi performansı alanları bulgu üretir.");
  } finally {
    await app.close();
    await owner.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runScenario().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
