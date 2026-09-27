/**
 * Oturum 41 — dış bağımlılık maddesi 2 (kargo) için firmadan BAĞIMSIZ canlı altyapı: hazırlık denetimi, şifreli
 * erişim bilgisi, firmaya özel ayarlar, canlı mod kapısı, etiket dosyası ve normalize takip durumu.
 * Farklı firmalara uyarlanabilirlik, bu testte kayıt defterine eklenen İKİ SAHTE adaptörle sınanır (biri PDF etiket
 * + takip yok, diğeri ZPL etiket + takip var). Gerçek bir kargo firmasına karşı doğrulama DEĞİLDİR.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, login, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { CARGO_PROVIDERS, type CargoShipmentRequest } from "../src/lib/cargo-providers";

let w: World;
let A: string;
let shipA: string;
let shipB: string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
const W = "warehouse@a.test";
const S = "sales@a.test";
const MGR = "manager@a.test";
const SECRET = "kargo-gizli-anahtar-987";
const ALL = { box: true, accessories: true, label: true, inspection: true };

async function cargo(key: string) {
  return expectOk(await call(w.app, W, A, "GET", "/api/cargo-connectors")).find((c: any) => c.key === key);
}

async function packShipment(id: string, weightKg: number) {
  const pkg = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${id}`)).packages[0].id;
  expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg}/items`, { code: "CG-LOT", qty: "2" }));
  expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg}/close`, { checklist: ALL, weightKg }));
  expectOk(await call(w.app, W, A, "POST", `/api/shipments/${id}/pack-complete`));
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "CG-1", name: "Kargo kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "cg.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;MCU-C;1;MCU;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  const rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  for (const area of ["rd", "production", "quality"]) expectOk(await call(w.app, `${area}@a.test`, A, "POST", `/api/revisions/${rev}/handover`, { area, decision: "approve" }));
  const customerId = expectOk(await call(w.app, S, A, "POST", "/api/customers", { code: "M-CG", name: "Kargo Müşterisi" })).id;
  expectOk(await call(w.app, S, A, "POST", `/api/customers/${customerId}/addresses`, { label: "Depo", recipient: "Ayşe Alıcı", line1: "Liman Yolu No:9", city: "İzmir", isDefault: true }));
  const sp = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: "kod,miktar,lot,konum,rev\nCG-1,10,CG-LOT,BTM,A", mapping: stockMapping }));
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  const o = expectOk(await call(w.app, S, A, "POST", "/api/sales-orders", { customerId, requestedDate: "2026-12-01", lines: [{ productRevisionId: rev, qty: "4", unitPrice: "50", currency: "TRY" }] }));
  expectOk(await call(w.app, S, A, "POST", `/api/sales-orders/${o.id}/confirm`));
  shipA = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o.id}/shipments`, { lines: [{ lineId: o.lines[0].id, qty: "2" }] })).id;
  shipB = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o.id}/shipments`, { lines: [{ lineId: o.lines[0].id, qty: "2" }] })).id;
});

afterAll(async () => {
  delete CARGO_PROVIDERS.aras;
  delete CARGO_PROVIDERS.mng;
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Kargo hazırlık denetimi ve erişim bilgisi (firmadan bağımsız)", () => {
  it("hazırlık eksik gönderici adres/telefon, alıcı telefon ve kapalı koliyi listeler", async () => {
    const r = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${shipA}/cargo-readiness`));
    expect(r.ready).toBe(false);
    expect(r.issues.map((i: any) => i.field)).toEqual(expect.arrayContaining(["company.address", "company.phone", "customer.phone", "packages"]));
  });

  it("şirket telefonu profile eklenir, alıcı adresi telefonla güncellenir, koli kapatılınca hazırlık tamamlanır", async () => {
    expect((await call(w.app, MGR, A, "POST", "/api/company/tax-profile", { legalName: "A Elektronik", taxNo: "1234567890", taxOffice: "Kadıköy", addressLine: "Sanayi Cad. 1", city: "İstanbul", phone: "abc" })).status).toBe(400);
    expectOk(await call(w.app, MGR, A, "POST", "/api/company/tax-profile", { legalName: "A Elektronik", taxNo: "1234567890", taxOffice: "Kadıköy", addressLine: "Sanayi Cad. 1", city: "İstanbul", phone: "+90 216 555 00 00" }));
    const sh = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${shipA}`));
    await w.owner.query("begin");
    await w.owner.query(`select set_config('app.company_id', $1, true)`, [A]);
    await w.owner.query(`update customer_addresses set phone = '+90 232 555 11 22' where id = $1`, [sh.addressId]);
    await w.owner.query("commit");
    await packShipment(shipA, 1.5);
    await packShipment(shipB, 2.25);
    const r = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${shipA}/cargo-readiness`));
    expect(r).toMatchObject({ ready: true, issues: [], packages: 1, totalWeightKg: "1.500" });
  });

  it("adaptörü olmayan firma canlıya alınamaz; erişim bilgisi şifreli saklanır, değer hiçbir yanıtta yok", async () => {
    const c = await cargo("yurtici");
    expect(c).toMatchObject({ adapterAvailable: false, hasCredentials: false, settings: {}, trackingSupported: false });
    expect((await call(w.app, W, A, "POST", `/api/cargo-connectors/${c.id}`, { mode: "live", reason: "Canlı deneme" })).body.error.code).toBe("adapter_not_available");
    const saved = expectOk(await call(w.app, W, A, "POST", `/api/cargo-connectors/${c.id}/credentials`, { environment: "sandbox", credentials: { musteriKodu: "123", apiKey: SECRET }, reason: "Sandbox hesabı" }));
    expect(saved).toEqual({ id: c.id, environment: "sandbox", hasCredentials: true, fields: ["apiKey", "musteriKodu"] });
    const listed = await cargo("yurtici");
    expect(listed).toMatchObject({ hasCredentials: true, environment: "sandbox" });
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(JSON.stringify(expectOk(await call(w.app, MGR, A, "GET", `/api/history/cargo_connector/${c.id}`)))).not.toContain(SECRET);
    expect((await call(w.app, "accounting@a.test", A, "POST", `/api/cargo-connectors/${c.id}/credentials`, { environment: "sandbox", credentials: { k: "v" }, reason: "yetkisiz" })).status).toBe(403);
  });

  it("adaptörsüz firmada ayarlar serbest kaydedilir ve olay kaydına yazılır", async () => {
    const c = await cargo("yurtici");
    expectOk(await call(w.app, W, A, "POST", `/api/cargo-connectors/${c.id}/settings`, { settings: { odemeTipi: "gonderici" }, reason: "Anlaşma" }));
    expect((await cargo("yurtici")).settings).toEqual({ odemeTipi: "gonderici" });
  });
});

describe("Farklı firmalara uyarlanabilirlik (iki SAHTE adaptör)", () => {
  const seen: Record<string, { req?: CargoShipmentRequest; creds?: Record<string, string>; settings?: Record<string, string> }> = { aras: {}, mng: {} };

  beforeAll(() => {
    // Firma 1: PDF etiket, takip sorgusu yok, müşteri kodu + parola, servis tipi ayarı.
    CARGO_PROVIDERS.aras = {
      credentialFields: ["customerCode", "password"],
      settingFields: [{ key: "serviceType", label: "Servis tipi", options: ["standart", "hizli"], required: true }],
      async createShipment(req, ctx) {
        Object.assign(seen.aras!, { req, creds: ctx.credentials, settings: ctx.settings });
        return { trackingNo: "AR-REAL-0001", label: { contentType: "application/pdf", data: Buffer.from("%PDF-1.4 sahte etiket") } };
      },
    };
    // Firma 2: ZPL etiket + takip sorgusu, tek API anahtarı, ayar yok. Firmanın kendi durum kodu normalize edilir.
    CARGO_PROVIDERS.mng = {
      credentialFields: ["apiKey"],
      settingFields: [],
      async createShipment(req, ctx) {
        Object.assign(seen.mng!, { req, creds: ctx.credentials, settings: ctx.settings });
        return { trackingNo: "MNG-777", labelRef: "MNG-BARKOD-777", label: { contentType: "application/zpl", data: Buffer.from("^XA^FO50,50^FDMNG-777^FS^XZ") } };
      },
      async track(trackingNo) {
        return { status: "in_transit", raw: `DAGITIM_MERKEZINDE:${trackingNo}`, at: "2026-09-28T09:00:00Z" };
      },
    };
  });

  it("her firma kendi erişim bilgisi alanlarını ve ayarlarını ister; ayarlar adaptöre göre doğrulanır", async () => {
    const aras = await cargo("aras");
    expect(aras).toMatchObject({ adapterAvailable: true, credentialFields: ["customerCode", "password"], trackingSupported: false });
    expect(aras.settingFields[0]).toMatchObject({ key: "serviceType", options: ["standart", "hizli"] });
    expect((await cargo("mng"))).toMatchObject({ credentialFields: ["apiKey"], trackingSupported: true });
    expect((await call(w.app, W, A, "POST", `/api/cargo-connectors/${aras.id}/credentials`, { environment: "sandbox", credentials: { customerCode: "C1" }, reason: "Eksik" })).status).toBe(400);
    expect((await call(w.app, W, A, "POST", `/api/cargo-connectors/${aras.id}/settings`, { settings: { serviceType: "ucak" }, reason: "Geçersiz" })).status).toBe(400);
    expect((await call(w.app, W, A, "POST", `/api/cargo-connectors/${aras.id}/settings`, { settings: { renk: "mavi", serviceType: "hizli" }, reason: "Tanımsız" })).status).toBe(400);
    expectOk(await call(w.app, W, A, "POST", `/api/cargo-connectors/${aras.id}/settings`, { settings: { serviceType: "hizli" }, reason: "Anlaşma" }));
    expect((await call(w.app, W, A, "POST", `/api/cargo-connectors/${aras.id}`, { mode: "live", reason: "Canlı" })).body.error.code).toBe("credentials_missing");
    expectOk(await call(w.app, W, A, "POST", `/api/cargo-connectors/${aras.id}/credentials`, { environment: "sandbox", credentials: { customerCode: "C1", password: SECRET }, reason: "Sandbox" }));
    expectOk(await call(w.app, W, A, "POST", `/api/cargo-connectors/${aras.id}`, { mode: "live", reason: "Sandbox doğrulaması" }));
    const mng = await cargo("mng");
    expectOk(await call(w.app, W, A, "POST", `/api/cargo-connectors/${mng.id}/credentials`, { environment: "production", credentials: { apiKey: SECRET }, reason: "Üretim" }));
    expectOk(await call(w.app, W, A, "POST", `/api/cargo-connectors/${mng.id}`, { mode: "live", reason: "Canlı" }));
  });

  it("firma 1 (PDF): canlı etiket gerçek takip no ile kaydedilir, adaptöre aynı ortak istek gider, etiket indirilir", async () => {
    const aras = await cargo("aras");
    const r = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipA}/cargo-label`, { connectorId: aras.id }));
    expect(r).toMatchObject({ trackingNo: "AR-REAL-0001", labelMode: "live", hasLabelFile: true, environment: "sandbox", testData: false });
    expect(seen.aras!.creds).toEqual({ customerCode: "C1", password: SECRET });
    expect(seen.aras!.settings).toEqual({ serviceType: "hizli" });
    expect(seen.aras!.req).toMatchObject({
      sender: { name: "A Elektronik", phone: "+90 216 555 00 00", city: "İstanbul", taxNo: "1234567890" },
      recipient: { name: "Ayşe Alıcı", phone: "+90 232 555 11 22", city: "İzmir" },
      totalWeightKg: "1.500",
    });
    const token = await login(w.app, W);
    const f = await w.app.inject({ method: "GET", url: `/api/shipments/${shipA}/cargo-label-file`, headers: { authorization: `Bearer ${token}`, "x-company-id": A } });
    expect(f.statusCode).toBe(200);
    expect(f.headers["content-type"]).toBe("application/pdf");
    expect(f.body).toBe("%PDF-1.4 sahte etiket");
    const sh = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${shipA}`));
    expect(sh).toMatchObject({ trackingNo: "AR-REAL-0001", carrier: "Aras Kargo", cargoLabelMode: "live", hasLabelFile: true, cargoStatus: "created" });
    expect((await call(w.app, W, A, "POST", `/api/shipments/${shipA}/cargo-track`)).body.error.code).toBe("tracking_not_supported");
    // Etiketli sevkiyat, taşıyıcı girilmeden sevk edilir (mevcut akış korunur).
    expect(expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipA}/ship`, {}))).toMatchObject({ status: "shipped", carrier: "Aras Kargo", trackingNo: "AR-REAL-0001" });
  });

  it("firma 2 (ZPL + takip): farklı etiket biçimi ve firma durum kodu normalize edilir; değişiklik olay kaydına yazılır", async () => {
    const mng = await cargo("mng");
    const r = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipB}/cargo-label`, { connectorId: mng.id }));
    expect(r).toMatchObject({ trackingNo: "MNG-777", labelRef: "MNG-BARKOD-777", environment: "production" });
    expect(seen.mng!.req?.totalWeightKg).toBe("2.250");
    const token = await login(w.app, W);
    const f = await w.app.inject({ method: "GET", url: `/api/shipments/${shipB}/cargo-label-file`, headers: { authorization: `Bearer ${token}`, "x-company-id": A } });
    expect(f.headers["content-type"]).toBe("application/zpl");
    const t = expectOk(await call(w.app, W, A, "POST", `/api/shipments/${shipB}/cargo-track`));
    expect(t).toMatchObject({ cargoStatus: "in_transit", cargoStatusRaw: "DAGITIM_MERKEZINDE:MNG-777" });
    const hist = expectOk(await call(w.app, MGR, A, "GET", `/api/history/shipment/${shipB}`));
    expect(JSON.stringify(hist)).toContain("cargo_status.changed");
    expect(JSON.stringify(hist)).not.toContain(SECRET);
  });

  it("şema: erişim bilgisi olmadan canlı mod veri tabanında da engellenir", async () => {
    const c = await cargo("ptt");
    await w.owner.query("begin");
    try {
      await w.owner.query(`select set_config('app.company_id', $1, true)`, [A]);
      await expect(w.owner.query(`update cargo_connectors set mode = 'live' where id = $1`, [c.id])).rejects.toThrow(/cargo_connectors_live_ready/);
    } finally {
      await w.owner.query("rollback");
    }
  });

  it("RLS: başka şirket kargo bağlayıcı ayarlarını ve etiket dosyasını göremez", async () => {
    const other = expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/cargo-connectors"));
    expect(other.every((c: any) => !c.hasCredentials && c.mode === "not_connected")).toBe(true);
    expect((await call(w.app, "all@b.test", w.b.companyId, "GET", `/api/shipments/${shipA}/cargo-label-file`)).status).toBe(404);
  });
});
