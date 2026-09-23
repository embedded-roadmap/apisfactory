/**
 * Kabul senaryoları (prompt §30). Her test gerçek PostgreSQL üzerinde, HTTP katmanından geçerek çalışır.
 * Kod eşlemesi: T01, T02, T03, T04, T05, T13, T18 + olay defteri, negatif stok, yayımlanmış BOM ve alan izni doğrulamaları.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";

let w: World;
let A: string;
let B: string;
let productId: string;
let revA: string;
let revB: string;
let customerId: string;
let bomV1: string;
const items: Record<string, string> = {};

const BOM_CSV = [
  "Designator;Manufacturer;MPN;Quantity;Description;DNP",
  'U1;TestSemi;TS32-Q48;1;MCU;',
  'U2;TestPower;TP3301;1;LDO 3V3;',
  '"C1,C2,C3,C4";TestPassive;TPC106;4;10uF 0603;',
  "J1;TestConn;TCN-2X5;1;Konnektör;DNP",
].join("\n");

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  B = w.b.companyId;

  // Ar-Ge: ürün, BOM içe aktarımı, yayım ve revizyon
  const p = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "SENS-200", name: "Sensör kartı" }));
  productId = p.id;
  const prev = expectOk(
    await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", {
      productId,
      fileName: "sens200_revA.csv",
      content: BOM_CSV,
      mapping: { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" },
    }),
  );
  expect(prev.summary).toMatchObject({ total: 4, newItems: 4, errors: 0 });
  const committed = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {}));
  bomV1 = committed.bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bomV1}/publish`));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bomV1}`));
  for (const l of bom.lines) items[l.mpn] = l.itemId;

  revA = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bomV1 })).id;
  revB = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "B", bomVersionId: bomV1 })).id;
  customerId = expectOk(await call(w.app, "sales@a.test", A, "POST", "/api/customers", { code: "C1", name: "Müşteri 1" })).id;
});

afterAll(async () => {
  await w.app.close();
  await w.owner.end();
  await closePool();
});

async function newOrder(rev: string, qty: string, date = "2026-12-31") {
  return expectOk(
    await call(w.app, "sales@a.test", A, "POST", "/api/sales-orders", {
      customerId,
      requestedDate: date,
      lines: [{ productRevisionId: rev, qty, unitPrice: "125.50", currency: "TRY" }],
    }),
  );
}

describe("Ar-Ge devri ve satış engeli", () => {
  it("T01: devir onaysız ürüne kesin satış backend'de reddedilir, taslak korunur", async () => {
    const order = await newOrder(revB, "10");
    const r = await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${order.id}/confirm`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("product_not_released");
    const after = expectOk(await call(w.app, "sales@a.test", A, "GET", `/api/sales-orders/${order.id}`));
    expect(after.status).toBe("draft");
  });

  it("devir: sistem yöneticisi iş onayı veremez; üç birim onayıyla revizyon yayımlanır", async () => {
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/transition`, { action: "submit_handover" }));
    const tasks = expectOk(await call(w.app, "quality@a.test", A, "GET", "/api/tasks/mine"));
    expect(tasks.some((t: any) => t.kind === "handover_approval" && t.entityId === revA)).toBe(true);

    const admin = await call(w.app, "admin@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "rd", decision: "approve" });
    expect(admin.status).toBe(403);
    const wrongArea = await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "quality", decision: "approve" });
    expect(wrongArea.status).toBe(403);

    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "rd", decision: "approve" }));
    const mid = expectOk(await call(w.app, "production@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "production", decision: "approve" }));
    expect(mid.status).toBe("handover_review");
    expect(mid.missingApprovals).toEqual(["quality"]);
    const done = expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "quality", decision: "approve" }));
    expect(done.status).toBe("released");
    const dup = await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revA}/handover`, { area: "quality", decision: "approve" });
    expect(dup.status).toBe(409);
  });

  it("devir reddi gerekçe ister ve revizyonu geri çevirir", async () => {
    expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${revB}/transition`, { action: "submit_handover" }));
    const noReason = await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revB}/handover`, { area: "quality", decision: "reject" });
    expect(noReason.status).toBe(409);
    const rej = expectOk(
      await call(w.app, "quality@a.test", A, "POST", `/api/revisions/${revB}/handover`, { area: "quality", decision: "reject", note: "Test limitleri eksik" }),
    );
    expect(rej.status).toBe("rejected");
    const rdTasks = expectOk(await call(w.app, "rd@a.test", A, "GET", "/api/tasks/mine"));
    expect(rdTasks.some((t: any) => t.kind === "handover_fix" && t.entityId === revB)).toBe(true);
  });

  it("yayımlanmış BOM satırı veri tabanında da değiştirilemez", async () => {
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query("begin");
      await app.query("select set_config('app.company_id', $1, true)", [A]);
      await expect(app.query("update bom_lines set qty_per = 99 where bom_version_id = $1", [bomV1])).rejects.toThrow(/bom_published/);
      await app.query("rollback");
    } finally {
      await app.end();
    }
  });
});

describe("Stok, rezervasyon ve net ihtiyaç", () => {
  const STOCK_CSV = [
    "kod,miktar,lot,konum,rev",
    "SENS-200,300,FG-001,BTM,A",
    `${"CMP-TESTSEMI-TS32-Q48"},200,MCU-L1,STK,`,
    `${"CMP-TESTPOWER-TP3301"},1000,LDO-L1,STK,`,
    `${"CMP-TESTPASSIVE-TPC106"},500,CAP-L1,STK,`,
  ].join("\n");
  const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };

  it("açılış stoğu önizleme + onayla hareket olarak girer", async () => {
    const prev = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "acilis.csv", content: STOCK_CSV, mapping: stockMapping }));
    expect(prev.summary.errors).toBe(0);
    const res = expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {}));
    expect(res.moves).toBe(4);
    // Teyitli açık alım: 400 adet MCU, ihtiyaç tarihinden önce.
    await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
    await w.owner.query(
      `insert into purchase_order_lines (company_id, po_code, supplier_name, item_id, qty_ordered, confirmed_date) values ($1,'PO-1','Distribütör',$2,400,'2026-11-01')`,
      [A, items["TS32-Q48"]],
    );
  });

  it("T13: aynı stok dosyası tekrar yüklenince kayıt ve miktar çoğalmaz", async () => {
    const before = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/stock/availability/${items["TPC106"]}`));
    const prev = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "acilis-kopya.csv", content: STOCK_CSV, mapping: stockMapping }));
    expect(prev.duplicateOf).toBeTruthy();
    const r = await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("duplicate_import");
    const after = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/stock/availability/${items["TPC106"]}`));
    expect(after.physical).toBe(before.physical);
  });

  it("T02: 1.000 sipariş, 300 uygun bitmiş stok → 300 rezervasyon, 700 üretim ihtiyacı ve net alım", async () => {
    const order = await newOrder(revA, "1000");
    const preview = expectOk(await call(w.app, "sales@a.test", A, "GET", `/api/sales-orders/${order.id}/availability`));
    expect(preview.canConfirm).toBe(true);
    expect(preview.lines[0].reservedQty).toBe("300");

    const res = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${order.id}/confirm`));
    const line = res.lines[0];
    expect(line.reservedQty).toBe("300");
    expect(line.productionNeedQty).toBe("700");
    const mat = Object.fromEntries(line.materials.map((m: any) => [m.itemCode, m]));
    // MCU: brüt 700, stoktan 200, teyitli açık alımdan 400, net 100
    expect(mat["CMP-TESTSEMI-TS32-Q48"]).toMatchObject({ grossQty: "700", reservedQty: "200", openPurchaseQty: "400", netQty: "100" });
    // LDO: 1000 stok yeterli
    expect(mat["CMP-TESTPOWER-TP3301"]).toMatchObject({ grossQty: "700", reservedQty: "700", netQty: "0", purchaseRequestId: null });
    // Kondansatör: 4 × 700 = 2800, stok 500, net 2300
    expect(mat["CMP-TESTPASSIVE-TPC106"]).toMatchObject({ grossQty: "2800", reservedQty: "500", netQty: "2300" });
    // DNP konnektör ihtiyaca girmez
    expect(mat["CMP-TESTCONN-TCN-2X5"]).toBeUndefined();

    // T04: aynı onay ikinci kez geldiğinde tek üretim ihtiyacı ve tek net alım talebi
    const again = expectOk(await call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${order.id}/confirm`));
    expect(again.alreadyConfirmed).toBe(true);
    await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
    const needs = await w.owner.query(`select count(*)::int n from production_needs pn join sales_order_lines l on l.id = pn.sales_order_line_id where l.order_id = $1`, [order.id]);
    expect(needs.rows[0].n).toBe(1);
    const prs = await w.owner.query(`select count(*)::int n from purchase_requests where source_type = 'production_need'`);
    expect(prs.rows[0].n).toBe(2);

    const avail = expectOk(await call(w.app, "sales@a.test", A, "GET", `/api/stock/availability/${items["TS32-Q48"]}`));
    expect(avail.available).toBe("0");
  });

  it("T04: aynı Idempotency-Key ile eşzamanlı iki onay tek sonuç üretir", async () => {
    await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
    const order = await newOrder(revA, "5");
    const h = { "idempotency-key": `confirm-${order.id}` };
    const [r1, r2] = await Promise.all([
      call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${order.id}/confirm`, undefined, h),
      call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${order.id}/confirm`, undefined, h),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const needs = await w.owner.query(`select count(*)::int n from production_needs pn join sales_order_lines l on l.id = pn.sales_order_line_id where l.order_id = $1`, [order.id]);
    expect(needs.rows[0].n).toBe(1);
  });

  it("T03: iki sipariş eşzamanlı aynı bitmiş stoğu istediğinde toplam tahsis kullanılabilir miktarı aşmaz", async () => {
    const csv = "kod,miktar,lot,konum,rev\nSENS-200,150,FG-002,BTM,A";
    const prev = expectOk(await call(w.app, "warehouse@a.test", A, "POST", "/api/imports/stock/preview", { fileName: "ek.csv", content: csv, mapping: stockMapping }));
    expectOk(await call(w.app, "warehouse@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {}));
    const o1 = await newOrder(revA, "100");
    const o2 = await newOrder(revA, "100");
    const [c1, c2] = await Promise.all([
      call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o1.id}/confirm`),
      call(w.app, "sales@a.test", A, "POST", `/api/sales-orders/${o2.id}/confirm`),
    ]);
    const r1 = expectOk(c1).lines[0];
    const r2 = expectOk(c2).lines[0];
    expect(Number(r1.reservedQty) + Number(r2.reservedQty)).toBe(150);
    expect(Number(r1.productionNeedQty) + Number(r2.productionNeedQty)).toBe(50);
    await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
    const lotRes = await w.owner.query(
      `select coalesce(sum(r.qty),0)::numeric as q from reservations r join lots l on l.id = r.lot_id where l.lot_no = 'FG-002' and r.status = 'active'`,
    );
    expect(Number(lotRes.rows[0].q)).toBe(150);
  });
});

describe("Mal kabul ve giriş kalite", () => {
  it("T05: kısmi ret — yalnızca kabul edilen miktar kullanılabilir olur", async () => {
    const mcu = items["TS32-Q48"]!;
    const before = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/stock/availability/${mcu}`));
    const rc = expectOk(
      await call(
        w.app,
        "warehouse@a.test",
        A,
        "POST",
        "/api/receipts",
        { supplierName: "Distribütör", lines: [{ itemId: mcu, qty: "100", lotNo: "MCU-RCV-1" }] },
        { "idempotency-key": "rcv-1" },
      ),
    );
    // Tekrar gönderim ikinci kabul oluşturmaz
    const again = expectOk(
      await call(w.app, "warehouse@a.test", A, "POST", "/api/receipts", { supplierName: "Distribütör", lines: [{ itemId: mcu, qty: "100", lotNo: "MCU-RCV-1" }] }, { "idempotency-key": "rcv-1" }),
    );
    expect(again.id).toBe(rc.id);

    const mid = expectOk(await call(w.app, "warehouse@a.test", A, "GET", `/api/stock/availability/${mcu}`));
    expect(mid.usable).toBe(before.usable);
    expect(Number(mid.inspection)).toBe(Number(before.inspection) + 100);

    const lineId = rc.lines[0].id;
    const wrongRole = await call(w.app, "warehouse@a.test", A, "POST", `/api/receipt-lines/${lineId}/inspection`, { acceptedQty: "70", rejectedQty: "30" });
    expect(wrongRole.status).toBe(403);
    const badSum = await call(w.app, "quality@a.test", A, "POST", `/api/receipt-lines/${lineId}/inspection`, { acceptedQty: "70", rejectedQty: "20" });
    expect(badSum.status).toBe(400);
    const dec = expectOk(await call(w.app, "quality@a.test", A, "POST", `/api/receipt-lines/${lineId}/inspection`, { acceptedQty: "70", rejectedQty: "30", note: "30 adet ters bantlı" }));
    expect(dec.inspectionStatus).toBe("partial");
    expect(Number(dec.availability.usable)).toBe(Number(before.usable) + 70);
    expect(Number(dec.availability.quarantine)).toBe(Number(before.quarantine) + 30);
    const second = await call(w.app, "quality@a.test", A, "POST", `/api/receipt-lines/${lineId}/inspection`, { acceptedQty: "100", rejectedQty: "0" });
    expect(second.status).toBe(409);
  });

  it("fiziksel stok negatife düşemez (veri tabanı kuralı)", async () => {
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query("begin");
      await app.query("select set_config('app.company_id', $1, true)", [A]);
      const lot = await app.query(`select id, item_id from lots where lot_no = 'CAP-L1'`);
      await expect(
        app.query(
          `insert into stock_moves (company_id, item_id, lot_id, from_location_id, to_location_id, qty, move_type) values ($1,$2,$3,$4,$5,9999,'transfer')`,
          [A, lot.rows[0].item_id, lot.rows[0].id, w.a.locations.STK, w.a.locations.URT],
        ),
      ).rejects.toThrow(/negative_stock/);
      await app.query("rollback");
    } finally {
      await app.end();
    }
  });
});

describe("Yetki ve şirket ayrımı", () => {
  it("T18: başka şirketin kullanıcısı API, arama ve veri tabanı yolunda kayda erişemez", async () => {
    // B kullanıcısı A şirketi başlığıyla gelirse reddedilir
    const cross = await call(w.app, "all@b.test", A, "GET", "/api/products");
    expect(cross.status).toBe(403);
    const crossSearch = await call(w.app, "all@b.test", A, "GET", "/api/lots/lookup?code=FG-001");
    expect(crossSearch.status).toBe(403);
    // Kendi şirketinde A'nın kayıtlarını görmez; A'nın kimliğiyle doğrudan erişim bulunamaz
    const own = expectOk(await call(w.app, "all@b.test", B, "GET", "/api/products"));
    expect(own).toEqual([]);
    const direct = await call(w.app, "all@b.test", B, "GET", `/api/products/${productId}`);
    expect(direct.status).toBe(404);
    const lookup = expectOk(await call(w.app, "all@b.test", B, "GET", "/api/lots/lookup?code=FG-001"));
    expect(lookup).toEqual([]);
    // A kullanıcısı B başlığıyla
    const reverse = await call(w.app, "rd@a.test", B, "GET", "/api/products");
    expect(reverse.status).toBe(403);
    // Veri tabanı: B bağlamında A satırları görünmez, A şirketine yazılamaz
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query("begin");
      await app.query("select set_config('app.company_id', $1, true)", [B]);
      const r = await app.query(`select count(*)::int n from items`);
      expect(r.rows[0].n).toBe(0);
      await expect(app.query(`insert into customers (company_id, code, name) values ($1, 'X', 'Sızma')`, [A])).rejects.toThrow(/row-level security/);
      await app.query("rollback");
    } finally {
      await app.end();
    }
  });

  it("alan izni: fiyat yetkisi olmayan rol satış fiyatını API'de görmez; teknisyen sipariş kesinleştiremez", async () => {
    const order = await newOrder(revA, "1");
    const sales = expectOk(await call(w.app, "sales@a.test", A, "GET", `/api/sales-orders/${order.id}`));
    expect(sales.lines[0].unitPrice).toBe("125.5000");
    await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
    // Üretim rolü satış siparişini görebilir ama fiyatı göremez
    const prod = expectOk(await call(w.app, "production@a.test", A, "GET", `/api/sales-orders/${order.id}`));
    expect(prod.lines[0].unitPrice).toBeUndefined();
    const tech = await call(w.app, "technician@a.test", A, "POST", `/api/sales-orders/${order.id}/confirm`);
    expect(tech.status).toBe(403);
  });

  it("çıkış yapılan oturum tekrar kullanılamaz", async () => {
    const r = await w.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "manager@a.test", password: "test-password-1" } });
    const token = r.json().token;
    const ok = await w.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}`, "x-company-id": A } });
    expect(ok.statusCode).toBe(200);
    await w.app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${token}` } });
    const after = await w.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}`, "x-company-id": A } });
    expect(after.statusCode).toBe(401);
  });
});

describe("Olay geçmişi ve BOM farkı", () => {
  it("olay defteri değiştirilemez ve işlemler kayıtlıdır", async () => {
    const hist = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/history/product_revision/${revA}`));
    const types = hist.map((e: any) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(["created", "status.handover_review", "handover.approve", "status.released"]));
    const released = hist.find((e: any) => e.eventType === "status.released");
    expect(released.actorKind).toBe("automation");

    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query("begin");
      await app.query("select set_config('app.company_id', $1, true)", [A]);
      await expect(app.query(`update events set reason = 'değişti'`)).rejects.toThrow();
      await app.query("rollback");
    } finally {
      await app.end();
    }
  });

  it("BOM sürüm farkı eklenen, silinen ve değişen satırları gösterir; belirsiz MPN otomatik kesinleşmez", async () => {
    const v2csv = [
      "Designator;Manufacturer;MPN;Quantity;Description;DNP",
      "U1;TestSemi;TS32-Q48;1;MCU;",
      '"C1,C2,C3,C4";TestPassive;TPC106;4;10uF 0603;',
      "U3;TestSemi;TS-NEW-1;2;Yeni sensör;",
      "J1;TestConn;TCN-2X5;1;Konnektör;",
      "U2;OtherMaker;TP3301;1;LDO farklı üretici;",
    ].join("\n");
    const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
    const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "v2.csv", content: v2csv, mapping }));
    const amb = prev.rows.find((r: any) => r.values.mpn === "TP3301");
    expect(amb.status).toBe("ambiguous");
    const blocked = await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("import_has_errors");
    const ok = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, { resolutions: { [amb.row]: items["TP3301"] } }));
    const diff = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bomV1}/diff/${ok.bomVersionId}`));
    expect(diff.added.map((l: any) => l.refdes)).toEqual(["U3"]);
    expect(diff.changed.find((c: any) => c.key === "ref:J1").fields).toEqual(["dnp"]);
    expect(diff.removed).toEqual([]);
  });
});
