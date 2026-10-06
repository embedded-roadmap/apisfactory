/**
 * Oturum 41 — dış bağımlılık maddesi 4: her şirketin istediği distribütörü kendi hesabıyla bağlayabileceği canlı API
 * altyapısı. Farklı distribütörlere uyarlanabilirlik İKİ SAHTE adaptörle sınanır (OAuth istemci kimliği + USD;
 * API anahtarı + EUR). Gerçek bir distribütör API'sine karşı doğrulama DEĞİLDİR.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { DISTRIBUTOR_PROVIDERS, type DistributorProvider } from "../src/lib/distributor-providers";
import { UpstreamError } from "../src/lib/distributor-adapters";

let w: World;
let A: string;
let mcu: string;
const P = "purchasing@a.test";
const SECRET = "distributor-gizli-sir-555";
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const seen: Record<string, { mpn?: string; creds?: Record<string, string>; env?: string; manufacturer?: string | null; calls: number }> = { digikey: { calls: 0 }, farnell: { calls: 0 } };
let farnellFails = false;
let farnellAuthFails = false;

async function conn(key: string) {
  return expectOk(await call(w.app, P, A, "GET", "/api/distributors")).find((c: any) => c.key === key);
}
async function offers(refresh = false) {
  return expectOk(await call(w.app, P, A, "GET", `/api/items/${mcu}/offers?qty=100${refresh ? "&refresh=1" : ""}`));
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "DL-1", name: "Canlı distribütör kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "d.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;LiveSemi;MCU-LIVE;1;MCU;", mapping }));
  const bomId = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  mcu = expectOk(await call(w.app, "rd@a.test", A, "GET", `/api/boms/${bomId}`)).lines[0].itemId;

  realDigikey = DISTRIBUTOR_PROVIDERS.digikey;
  realFarnell = DISTRIBUTOR_PROVIDERS.farnell;
  DISTRIBUTOR_PROVIDERS.digikey = {
    credentialFields: ["clientId", "clientSecret"],
    async lookup(mpn, ctx) {
      Object.assign(seen.digikey!, { mpn, creds: ctx.credentials, env: ctx.environment, manufacturer: ctx.manufacturer });
      seen.digikey!.calls++;
      return { sku: "DK-123", manufacturer: "LiveSemi", stock: 1200, moq: 1, multiple: 1, leadTimeDays: 5, lifecycle: "active", currency: "USD", breaks: [{ qty: 1, price: 2.5 }, { qty: 100, price: 2.1 }], sourceRef: "https://example.test/dk/DK-123" };
    },
  };
  DISTRIBUTOR_PROVIDERS.farnell = {
    credentialFields: ["apiKey"],
    async lookup(mpn, ctx) {
      seen.farnell!.calls++;
      Object.assign(seen.farnell!, { mpn, creds: ctx.credentials });
      if (farnellFails) throw new Error(`upstream 500 apiKey=${ctx.credentials.apiKey}`);
      if (farnellAuthFails) throw new UpstreamError("element14: HTTP 401");
      return mpn === "MCU-LIVE" ? { sku: "F-9", manufacturer: null, stock: 0, moq: 10, multiple: 10, leadTimeDays: 42, lifecycle: "nrnd", currency: "EUR", breaks: [{ qty: 10, price: 1.9 }], sourceRef: "farnell:F-9" } : null;
    },
  };
});

let realDigikey: DistributorProvider | undefined;
let realFarnell: DistributorProvider | undefined;

afterAll(async () => {
  DISTRIBUTOR_PROVIDERS.digikey = realDigikey;
  DISTRIBUTOR_PROVIDERS.farnell = realFarnell;
  await w.app.close();
  await w.owner.end();
  await closePool();
});

const M = "manager@a.test";
const LICENSE_OK = { multi_tenant: "allowed", display: "allowed", cache: "allowed", history: "allowed", derived_analysis: "allowed", export: "denied", account_pricing: "unknown", ai_processing: "unknown" };

describe("Distribütör canlı API altyapısı (madde 4)", () => {
  it("adaptörü olmayan distribütör canlıya alınamaz; erişim bilgisi şifreli, değer hiçbir yanıtta yok", async () => {
    const lcsc = await conn("lcsc");
    expect(lcsc).toMatchObject({ adapterAvailable: false, hasCredentials: false });
    expect((await call(w.app, P, A, "POST", `/api/distributors/${lcsc.id}`, { mode: "live", reason: "Canlı deneme" })).body.error.code).toBe("adapter_not_available");
    expectOk(await call(w.app, P, A, "POST", `/api/distributors/${lcsc.id}/credentials`, { environment: "production", credentials: { apiKey: SECRET }, reason: "Geliştirici hesabı" }));
    const listed = await conn("lcsc");
    expect(listed).toMatchObject({ hasCredentials: true, environment: "production" });
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect((await call(w.app, "rd@a.test", A, "POST", `/api/distributors/${lcsc.id}/credentials`, { environment: "sandbox", credentials: { k: "v" }, reason: "yetkisiz" })).status).toBe(403);
  });

  it("her distribütör kendi erişim bilgisi alanlarını ister; eksik alan ve erişim bilgisiz canlı geçiş reddedilir", async () => {
    const dk = await conn("digikey");
    expect(dk).toMatchObject({ adapterAvailable: true, credentialFields: ["clientId", "clientSecret"] });
    expect((await conn("farnell")).credentialFields).toEqual(["apiKey"]);
    expect((await call(w.app, P, A, "POST", `/api/distributors/${dk.id}`, { mode: "live", reason: "Canlı" })).body.error.code).toBe("credentials_missing");
    expect((await call(w.app, P, A, "POST", `/api/distributors/${dk.id}/credentials`, { environment: "sandbox", credentials: { clientId: "c" }, reason: "Eksik" })).status).toBe(400);
    expectOk(await call(w.app, P, A, "POST", `/api/distributors/${dk.id}/credentials`, { environment: "sandbox", credentials: { clientId: "c", clientSecret: SECRET }, reason: "Sandbox" }));
    // W03: erişim bilgisi tamam ama yazılı lisans teyidi yok → canlı mod reddedilir.
    expect((await call(w.app, P, A, "POST", `/api/distributors/${dk.id}`, { mode: "live", reason: "Canlı" })).body.error.code).toBe("license_required");
    expect((await call(w.app, P, A, "POST", `/api/distributors/${dk.id}/license`, { permissions: LICENSE_OK, documentRef: "yetkisiz deneme" })).status).toBe(403);
    const partial = expectOk(await call(w.app, M, A, "POST", `/api/distributors/${dk.id}/license`, { permissions: { ...LICENSE_OK, cache: "unknown" }, documentRef: "DigiKey e-posta 2026-09-30" }));
    expect(partial).toMatchObject({ versionNo: 1, liveAllowed: false, missingForLive: ["önbellek"] });
    expect((await call(w.app, P, A, "POST", `/api/distributors/${dk.id}`, { mode: "live", reason: "Canlı" })).body.error.message).toContain("önbellek");
    expectOk(await call(w.app, M, A, "POST", `/api/distributors/${dk.id}/license`, { permissions: LICENSE_OK, cacheMaxMinutes: 60, documentRef: "DigiKey API sözleşmesi ek-2" }));
    expectOk(await call(w.app, P, A, "POST", `/api/distributors/${dk.id}`, { mode: "live", dailyCallLimit: 2, cacheTtlMinutes: 1440, reason: "Sandbox doğrulaması" }));
    expect(await conn("digikey")).toMatchObject({ mode: "live", cacheTtlMinutes: 60, license: { versionNo: 2, cacheMaxMinutes: 60 } }); // lisans sınırı
    const fa = await conn("farnell");
    expectOk(await call(w.app, P, A, "POST", `/api/distributors/${fa.id}/credentials`, { environment: "production", credentials: { apiKey: SECRET }, reason: "Üretim" }));
    expectOk(await call(w.app, M, A, "POST", `/api/distributors/${fa.id}/license`, { permissions: LICENSE_OK, documentRef: "Farnell yazılı onay" }));
    expectOk(await call(w.app, P, A, "POST", `/api/distributors/${fa.id}`, { mode: "live", reason: "Canlı" }));
  });

  it("iki farklı distribütör aynı ortak teklif biçimine çevrilir; kaynak 'api', test verisi değil", async () => {
    const r = await offers();
    expect(r.connectorsActive).toBe(2);
    const dk = r.offers.find((o: any) => o.connectorKey === "digikey");
    const fa = r.offers.find((o: any) => o.connectorKey === "farnell");
    expect(dk).toMatchObject({ mode: "live", source: "api", testData: false, sku: "DK-123", stock: 1200, currency: "USD", sourceRef: "https://example.test/dk/DK-123", unitPrice: 2.1 });
    expect(fa).toMatchObject({ source: "api", stock: 0, moq: 10, lifecycle: "nrnd", currency: "EUR", leadTimeDays: 42 });
    expect(seen.digikey).toMatchObject({ mpn: "MCU-LIVE", env: "sandbox", manufacturer: "LiveSemi", creds: { clientId: "c", clientSecret: SECRET } });
  });

  it("taze önbellek varken distribütör yeniden çağrılmaz; yenilemede günlük kota uygulanır", async () => {
    const before = seen.digikey!.calls;
    await offers();
    expect(seen.digikey!.calls).toBe(before); // önbellekten
    await offers(true); // 2. gerçek çağrı → kota (2) doldu
    const r = await offers(true);
    expect(seen.digikey!.calls).toBe(before + 1);
    expect(r.warnings.join(" ")).toMatch(/DigiKey: günlük çağrı kotası \(2\) doldu/);
    expect(r.offers.find((o: any) => o.connectorKey === "digikey")).toBeTruthy(); // önbellekteki teklif gösterilir
  });

  it("distribütör hata verirse önbellek korunur, uyarı gösterilir, hata ayrıntısı (sır) sızmaz", async () => {
    farnellFails = true;
    const r = await offers(true);
    farnellFails = false;
    expect(r.offers.find((o: any) => o.connectorKey === "farnell")).toMatchObject({ sku: "F-9" });
    const warn = r.warnings.find((x: string) => x.startsWith("Farnell"));
    expect(warn).toMatch(/hata döndü; önbellekteki teklif/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    await w.owner.query("begin");
    await w.owner.query(`select set_config('app.company_id', $1, true)`, [A]);
    const outcomes = (await w.owner.query(`select outcome from connector_calls c join distributor_connectors d on d.id = c.connector_id where d.key = 'farnell' order by c.id`)).rows.map((x) => x.outcome);
    await w.owner.query("rollback");
    expect(outcomes.at(-1)).toBe("error");
    expect(outcomes.filter((o) => o === "error")).toHaveLength(1);
  });

  it("kimlik doğrulama reddi ayrı uyarıyla gösterilir (ortam/anahtar kontrolü yönlendirmesi)", async () => {
    farnellAuthFails = true;
    const r = await offers(true);
    farnellAuthFails = false;
    expect(r.warnings.find((x: string) => x.startsWith("Farnell"))).toMatch(/kimlik doğrulama reddedildi/);
  });

  it("şema: erişim bilgisi olmadan canlı mod veri tabanında da engellenir; entegrasyon özeti CANLI gösterir", async () => {
    const lcsc = await conn("lcsc");
    await w.owner.query("begin");
    try {
      await w.owner.query(`select set_config('app.company_id', $1, true)`, [A]);
      await expect(w.owner.query(`update distributor_connectors set mode = 'live' where id = $1`, [lcsc.id])).rejects.toThrow(/distributor_connectors_live_(ready|licensed)/);
    } finally {
      await w.owner.query("rollback");
    }
    const integ = expectOk(await call(w.app, P, A, "GET", "/api/integrations"));
    expect(integ.find((i: any) => i.key === "digikey")).toMatchObject({ mode: "live" });
  });

  it("RLS: başka şirket bu şirketin canlı bağlayıcılarını ve erişim bilgisini görmez", async () => {
    const other = expectOk(await call(w.app, "all@b.test", w.b.companyId, "GET", "/api/distributors"));
    expect(other.every((c: any) => c.mode === "not_connected" && !c.hasCredentials)).toBe(true);
  });
});

describe("Lisans teyidi (W03)", () => {
  it("teyit daraltılınca bağlayıcı canlıdan çıkar; teyit geçmişi sürümlü ve değişmez", async () => {
    const fa = await conn("farnell");
    const r = expectOk(await call(w.app, M, A, "POST", `/api/distributors/${fa.id}/license`, { permissions: { ...LICENSE_OK, cache: "denied" }, documentRef: "Farnell şartları: önbellek yasak" }));
    expect(r).toMatchObject({ liveAllowed: false, leftLiveMode: true });
    expect((await conn("farnell")).mode).toBe("not_connected");
    const hist = expectOk(await call(w.app, P, A, "GET", `/api/distributors/${fa.id}/license`));
    expect(hist.map((h: any) => [h.versionNo, h.current])).toEqual([[2, true], [1, false]]);
    await w.owner.query("select set_config('app.company_id', $1, false)", [A]);
    await expect(w.owner.query(`update distributor_license_confirmations set document_ref = 'x'`)).rejects.toThrow(/append/i);
  });
});
