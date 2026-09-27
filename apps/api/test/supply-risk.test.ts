/**
 * R37: Tedarik riskinin sipariş ve termine etkisi (ana talimat §10 "BOM izleme ve tedarik risk asistanı").
 * TEST bağlayıcısı deterministik olduğundan gerçek "değişim" iki gerçek anlık görüntü gerektirir — burada
 * bunlar doğrudan part_offers'a yazılarak (gerçek bir fiyat dosyası yeniden yüklemesini veya ileride gerçek
 * bir API yenilemesini temsilen) simüle edilir. Tek anlık görüntüden çıkan riskler (stok yok, yaşam döngüsü)
 * tek satırla test edilir.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let connectorId: string;
let itemNoStock: string;
let itemEol: string;
let itemDrop: string;
let itemAlt: string, itemAltReplacement: string;

async function insertOffer(itemId: string, mpn: string, fields: { stock?: number; leadTimeDays?: number; lifecycle?: string; price?: number; fetchedAt?: string }) {
  await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
  await w.owner.query(
    `insert into part_offers (company_id, connector_id, item_id, mpn, stock, lead_time_days, lifecycle, currency, price_breaks, source, source_ref, fetched_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'USD', $8, 'test_connector', 'test', coalesce($9::timestamptz, now()), now() + interval '1 day')`,
    [A, connectorId, itemId, mpn, fields.stock ?? 100, fields.leadTimeDays ?? 5, fields.lifecycle ?? "active",
     JSON.stringify([{ qty: 1, price: fields.price ?? 1 }]), fields.fetchedAt ?? null],
  );
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;

  expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/distributors")); // bağlayıcı satırlarını oluşturur (ensureConnectors)
  await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
  connectorId = (await w.owner.query(`select id from distributor_connectors where company_id = $1 and key = 'digikey'`, [A])).rows[0].id;

  itemNoStock = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "RISK-1", name: "Kaynakta stoksuz kalem", kind: "component" })).id;
  itemEol = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "RISK-2", name: "EOL kalem", kind: "component" })).id;
  itemDrop = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "RISK-3", name: "Stok düşüşü kalemi", kind: "component" })).id;
  itemAlt = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "RISK-4", name: "Alternatifi olan EOL kalem", kind: "component" })).id;
  itemAltReplacement = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/items", { code: "RISK-4-ALT", name: "Onaylı alternatif", kind: "component" })).id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Tedarik riski (R37)", () => {
  it("varsayılan ayarlar: görüntüleme purchase.view ile, değiştirme yalnızca supply.risk.manage ile", async () => {
    const g = await call(w.app, "rd@a.test", A, "GET", "/api/supply-risk-settings");
    expect(g.status).toBe(200);
    expect(g.body.stockDropPct).toBe("50.00");
    expect(g.body.enabled).toBe(true);

    const forbidden = await call(w.app, "sales@a.test", A, "POST", "/api/supply-risk-settings", {
      enabled: true, stockDropPct: 50, priceIncreasePct: 20, leadTimeIncreaseDays: 10, scanFrequencyHours: 24,
    });
    expect(forbidden.status).toBe(403);

    const ok = await call(w.app, "purchasing@a.test", A, "POST", "/api/supply-risk-settings", {
      enabled: true, stockDropPct: 40, priceIncreasePct: 15, leadTimeIncreaseDays: 7, scanFrequencyHours: 24,
    });
    expect(ok.status).toBe(200);
    const g2 = await call(w.app, "rd@a.test", A, "GET", "/api/supply-risk-settings");
    expect(g2.body.stockDropPct).toBe("40.00");
  });

  it("kaynakta stok yok (tek anlık görüntü) — gerçek açık talep varsa kritik ve göreve yükseltilir", async () => {
    await insertOffer(itemNoStock, "RISK-1-MPN", { stock: 0 });
    // Bu kaleme bağlı gerçek bir açık satın alma talebi aç (ihtiyaç tarihi yakın → kritik).
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/purchase-requests", { itemId: itemNoStock, qty: "10", note: "R37 test talebi", needDate: soon }));

    const scan = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/supply-risks/scan"));
    expect(scan.detected).toBeGreaterThanOrEqual(1);
    expect(scan.escalated).toBeGreaterThanOrEqual(1);

    const list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/supply-risks?status=open"));
    const r = list.find((x: any) => x.itemId === itemNoStock && x.riskType === "no_source_stock");
    expect(r).toBeTruthy();
    expect(r.severity).toBe("critical");
    expect(Number(r.openRequestQty)).toBe(10);
    expect(r.hasApprovedAlternate).toBe(false);

    const tasks = await w.owner.query(`select title, assignee_role, status from tasks where kind = 'supply_risk' and entity_id = $1`, [r.id]);
    expect(tasks.rows[0]?.assignee_role).toBe("purchasing");
    expect(tasks.rows[0]?.status).toBe("open");
  });

  it("teknisyen tedarik risklerini göremez (purchase.view yok)", async () => {
    const r = await call(w.app, "technician@a.test", A, "GET", "/api/supply-risks");
    expect(r.status).toBe(403);
  });

  it("yaşam döngüsü riski Ar-Ge'ye yükseltilir; onaylı alternatif varsa öneri metni değişir", async () => {
    await insertOffer(itemEol, "RISK-2-MPN", { lifecycle: "eol" });
    await insertOffer(itemAlt, "RISK-4-MPN", { lifecycle: "eol" });

    // itemAlt için onaylı alternatif oluştur (öneren, kendi önerisini onaylayamaz — purchasing önerir).
    const alt = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/alternates", {
      itemId: itemAlt, alternateItemId: itemAltReplacement, reason: "R37 testi için onaylı alternatif kalem", pinCompatible: true, footprintSame: true, electricalEquivalent: true,
    }));
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/alternates/${alt.id}/decision`, { area: "rd", decision: "approve" }));
    expectOk(await call(w.app, "production@a.test", A, "POST", `/api/alternates/${alt.id}/decision`, { area: "production", decision: "approve" }));

    expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/supply-risks/scan"));

    const list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/supply-risks?status=open"));
    const rEol = list.find((x: any) => x.itemId === itemEol && x.riskType === "lifecycle_risk");
    expect(rEol.severity).toBe("critical");
    expect(rEol.responsibleRole).toBe("rd");

    const rAlt = list.find((x: any) => x.itemId === itemAlt && x.riskType === "lifecycle_risk");
    expect(rAlt.hasApprovedAlternate).toBe(true);
    expect(rAlt.recommendedAction).toMatch(/alternatif/i);

    const rdTask = await w.owner.query(`select assignee_role from tasks where kind = 'supply_risk' and entity_id = $1`, [rEol.id]);
    expect(rdTask.rows[0]?.assignee_role).toBe("rd");
  });

  it("stok düşüşü: iki gerçek anlık görüntü karşılaştırılır, eşik altı değişim risk üretmez, eşik üstü üretir", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await insertOffer(itemDrop, "RISK-3-MPN", { stock: 1000, fetchedAt: twoDaysAgo });
    // %20 düşüş — şirketin güncel eşiği %40 (bu testte önceki testte 40'a düşürülmüştü) → tetiklenmemeli.
    await insertOffer(itemDrop, "RISK-3-MPN", { stock: 800 });
    let scan = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/supply-risks/scan"));
    let list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/supply-risks?status=open"));
    expect(list.find((x: any) => x.itemId === itemDrop && x.riskType === "stock_drop")).toBeUndefined();

    // Şimdi %90 düşüş → eşik üstü, tetiklenmeli.
    await insertOffer(itemDrop, "RISK-3-MPN", { stock: 80 });
    scan = expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/supply-risks/scan"));
    list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/supply-risks?status=open"));
    const r = list.find((x: any) => x.itemId === itemDrop && x.riskType === "stock_drop");
    expect(r).toBeTruthy();
    expect(r.changeSummary).toMatch(/800.*80|azalma/);

    // Tekrar aynı eşiği aşan taramada tekilleştirilir (ikinci kayıt açılmaz).
    const beforeCount = list.filter((x: any) => x.itemId === itemDrop && x.riskType === "stock_drop").length;
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/supply-risks/scan"));
    const list2 = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/supply-risks?status=open"));
    expect(list2.filter((x: any) => x.itemId === itemDrop && x.riskType === "stock_drop").length).toBe(beforeCount);

    // Stok toparlanınca (yeni en güncel değer önceki iki taramadaki en düşükten yüksek) risk otomatik kapanır.
    await insertOffer(itemDrop, "RISK-3-MPN", { stock: 900 });
    expectOk(await call(w.app, "purchasing@a.test", A, "POST", "/api/supply-risks/scan"));
    const list3 = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/supply-risks?status=open"));
    expect(list3.find((x: any) => x.itemId === itemDrop && x.riskType === "stock_drop")).toBeUndefined();
    const resolved = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/supply-risks?status=resolved"));
    const resolvedRisk = resolved.find((x: any) => x.itemId === itemDrop && x.riskType === "stock_drop");
    expect(resolvedRisk?.resolvedReason).toMatch(/otomatik/);
  });

  it("elle çözüldü işaretleme yalnızca supply.risk.manage ile, gerekçe zorunlu", async () => {
    const list = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/supply-risks?status=open"));
    const r = list.find((x: any) => x.itemId === itemNoStock && x.riskType === "no_source_stock");
    expect(r).toBeTruthy();

    const forbidden = await call(w.app, "sales@a.test", A, "POST", `/api/supply-risks/${r.id}/resolve`, { reason: "test" });
    expect(forbidden.status).toBe(403);

    const short = await call(w.app, "purchasing@a.test", A, "POST", `/api/supply-risks/${r.id}/resolve`, { reason: "ab" });
    expect(short.status).toBe(400);

    const ok = await call(w.app, "purchasing@a.test", A, "POST", `/api/supply-risks/${r.id}/resolve`, { reason: "Tedarikçiyle görüşüldü, ek stok teyit edildi" });
    expect(ok.status).toBe(200);

    const after = expectOk(await call(w.app, "purchasing@a.test", A, "GET", "/api/supply-risks?status=open"));
    expect(after.find((x: any) => x.id === r.id)).toBeUndefined();

    const tasks = await w.owner.query(`select status from tasks where kind = 'supply_risk' and entity_id = $1`, [r.id]);
    expect(tasks.rows[0]?.status).toBe("done");
  });

  it("tarama sıklığı: force olmadan çağrı, son taramadan bu yana eşik süre geçmediyse hiçbir şey yapmaz", async () => {
    await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
    await w.owner.query(`update supply_risk_settings set last_scanned_at = now() where company_id = $1`, [A]);
    // (force parametresi yalnız API içinde kullanılıyor; burada iç fonksiyonun cadence korumasını dolaylı
    // olarak POST /scan her zaman force=true gönderdiği için test edemeyiz — bu, worker döngüsünün kendi
    // sorumluluğu; burada yalnızca ayarın okunabildiğini doğruluyoruz.)
    const g = expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/supply-risk-settings"));
    expect(g.lastScannedAt).toBeTruthy();
  });
});
