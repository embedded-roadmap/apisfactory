/**
 * Oturum 41 devamı — dış bağımlılık 3b: DigiKey / Mouser / element14 adaptörleri (DOĞRULANMADI — gerçek hesap yok).
 * Sahte fetch ile: giden isteğin yayımlanmış belgeye uyduğu (uç nokta, yöntem, başlıklar, gövde) ve belgedeki yanıt
 * biçiminin ortak teklif biçimine doğru çevrildiği sınanır. Yanıt örnekleri belgedeki alan adlarıyla kurulmuştur.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISTRIBUTOR_ADAPTERS, distributorDeps, leadDays, parseLocalizedPrice, resetDistributorTokenCache } from "../src/lib/distributor-adapters";
import { DISTRIBUTOR_PROVIDERS } from "../src/lib/distributor-providers";

type Req = { method: string; url: string; headers: Headers; body: string };
let log: Req[] = [];
let respond: (r: Req) => { status?: number; json?: unknown };
const realFetch = distributorDeps.fetch;

beforeEach(() => {
  log = [];
  resetDistributorTokenCache();
  distributorDeps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r: Req = { method: init?.method ?? "GET", url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    log.push(r);
    const out = respond(r);
    return new Response(out.json === undefined ? "" : JSON.stringify(out.json), { status: out.status ?? 200 });
  }) as typeof fetch;
});
afterEach(() => {
  distributorDeps.fetch = realFetch;
});

const ctx = (credentials: Record<string, string>, over: Partial<{ environment: "sandbox" | "production"; currency: string; manufacturer: string | null }> = {}) =>
  ({ credentials, environment: "sandbox" as const, currency: "EUR", manufacturer: null, ...over });

describe("Yardımcılar", () => {
  it("yerel fiyat biçimleri ve teslim süresi birimleri", () => {
    expect(parseLocalizedPrice("$1.23")).toBe(1.23);
    expect(parseLocalizedPrice("1,23 €")).toBe(1.23);
    expect(parseLocalizedPrice("1.234,56 €")).toBe(1234.56);
    expect(parseLocalizedPrice("$1,234.56")).toBe(1234.56);
    expect(parseLocalizedPrice("Fiyat yok")).toBeNull();
    expect(leadDays("14 Weeks", "days")).toBe(98);
    expect(leadDays("70 Days", "weeks")).toBe(70);
    expect(leadDays("8", "weeks")).toBe(56);
    expect(leadDays(null, "weeks")).toBeNull();
  });

  it("kayıt defteri: üç adaptör var, hepsi DOĞRULANMADI olarak işaretli ve belgeye bağlı", () => {
    for (const k of ["digikey", "mouser", "farnell"]) {
      expect(DISTRIBUTOR_PROVIDERS[k]).toBe(DISTRIBUTOR_ADAPTERS[k]);
      expect(DISTRIBUTOR_ADAPTERS[k]!.verified).toBe(false);
      expect(DISTRIBUTOR_ADAPTERS[k]!.docsUrl).toMatch(/^https:\/\//);
    }
    expect(DISTRIBUTOR_PROVIDERS.lcsc).toBeUndefined();
  });
});

describe("DigiKey (Product Information v4)", () => {
  const dk = DISTRIBUTOR_ADAPTERS.digikey!;
  const product = {
    SearchLocaleUsed: { Site: "US", Language: "en", Currency: "EUR" },
    Product: {
      ManufacturerProductNumber: "STM32F103C8T6",
      Manufacturer: { Id: 497, Name: "STMicroelectronics" },
      QuantityAvailable: 12500,
      ProductUrl: "https://www.digikey.com/en/products/detail/x/497-6063-ND/1646338",
      ManufacturerLeadWeeks: "12",
      ProductStatus: { Id: 0, Status: "Active" },
      EndOfLife: false,
      ProductVariations: [
        { DigiKeyProductNumber: "497-6063-2-ND", MinimumOrderQuantity: 1500, StandardPricing: [{ BreakQuantity: 1500, UnitPrice: 3.1 }] },
        { DigiKeyProductNumber: "497-6063-ND", MinimumOrderQuantity: 1, StandardPricing: [{ BreakQuantity: 10, UnitPrice: 4.2 }, { BreakQuantity: 1, UnitPrice: 4.8 }] },
      ],
    },
  };

  it("OAuth2 client_credentials + productdetails isteği belgeye uygun; yanıt ortak biçime çevrilir; jeton önbellekte", async () => {
    respond = (r) => (r.url.endsWith("/v1/oauth2/token") ? { json: { access_token: "tok-1", expires_in: 599, token_type: "Bearer" } } : { json: product });
    const o = await dk.lookup("STM32F103C8T6", ctx({ clientId: "cid", clientSecret: "sec" }, { manufacturer: "STMicro" }));
    expect(log[0]).toMatchObject({ method: "POST", url: "https://sandbox-api.digikey.com/v1/oauth2/token" });
    expect(Object.fromEntries(new URLSearchParams(log[0]!.body))).toEqual({ client_id: "cid", client_secret: "sec", grant_type: "client_credentials" });
    expect(log[1]!.url).toBe("https://sandbox-api.digikey.com/products/v4/search/STM32F103C8T6/productdetails");
    expect(log[1]!.headers.get("authorization")).toBe("Bearer tok-1");
    expect(log[1]!.headers.get("x-digikey-client-id")).toBe("cid");
    expect(log[1]!.headers.get("x-digikey-locale-currency")).toBe("EUR");
    expect(o).toEqual({
      sku: "497-6063-ND", manufacturer: "STMicroelectronics", stock: 12500, moq: 1, multiple: null, leadTimeDays: 84, lifecycle: "active", currency: "EUR",
      breaks: [{ qty: 1, price: 4.8 }, { qty: 10, price: 4.2 }], sourceRef: product.Product.ProductUrl,
    });
    await dk.lookup("STM32F103C8T6", ctx({ clientId: "cid", clientSecret: "sec" }));
    expect(log.filter((r) => r.url.endsWith("/oauth2/token"))).toHaveLength(1);
  });

  it("üretim ortamı adresi; bulunamayan 404 → null; farklı MPN veya üretici → null; durum eşlemesi", async () => {
    respond = (r) => (r.url.endsWith("/token") ? { json: { access_token: "t", expires_in: 600 } } : r.url.includes("/NOPE/") ? { status: 404, json: {} } : { json: { ...product, Product: { ...product.Product, ProductStatus: { Status: "Not For New Designs" } } } });
    expect(await dk.lookup("NOPE", ctx({ clientId: "c", clientSecret: "s" }, { environment: "production" }))).toBeNull();
    expect(log.every((r) => r.url.startsWith("https://api.digikey.com/"))).toBe(true);
    expect(await dk.lookup("STM32F103C8T6", ctx({ clientId: "c", clientSecret: "s" }, { environment: "production", manufacturer: "Microchip" }))).toBeNull();
    expect((await dk.lookup("STM32F103C8T6", ctx({ clientId: "c", clientSecret: "s" }, { environment: "production" })))!.lifecycle).toBe("nrnd");
  });

  it("jeton hatası sır içermeyen hata fırlatır", async () => {
    respond = () => ({ status: 401, json: { error: "invalid_client", secret: "sec-XYZ" } });
    await expect(dk.lookup("X", ctx({ clientId: "c", clientSecret: "sec-XYZ" }))).rejects.toThrow(/^DigiKey token: HTTP 401$/);
  });
});

describe("Mouser (Search API v1)", () => {
  const ms = DISTRIBUTOR_ADAPTERS.mouser!;
  const resp = {
    Errors: [],
    SearchResults: {
      NumberOfResult: 2,
      Parts: [
        { ManufacturerPartNumber: "LM358DR2G-X", Manufacturer: "onsemi", MouserPartNumber: "863-X" },
        {
          ManufacturerPartNumber: "LM358DR2G", Manufacturer: "onsemi", MouserPartNumber: "863-LM358DR2G", AvailabilityInStock: "24310", Min: "1", Mult: "1",
          LeadTime: "15 Weeks", LifecycleStatus: null, ProductDetailUrl: "https://www.mouser.com/ProductDetail/863-LM358DR2G",
          PriceBreaks: [{ Quantity: 10, Price: "0,245 €", Currency: "EUR" }, { Quantity: 1, Price: "0,40 €", Currency: "EUR" }],
        },
      ],
    },
  };

  it("apiKey sorgu parametresinde, gövde SearchByPartRequest (Exact); tam MPN eşleşmesi seçilir", async () => {
    respond = () => ({ json: resp });
    const o = await ms.lookup("LM358DR2G", ctx({ apiKey: "mk-1" }));
    expect(log[0]).toMatchObject({ method: "POST", url: "https://api.mouser.com/api/v1/search/partnumber?apiKey=mk-1" });
    expect(JSON.parse(log[0]!.body)).toEqual({ SearchByPartRequest: { mouserPartNumber: "LM358DR2G", partSearchOptions: "Exact" } });
    expect(o).toEqual({
      sku: "863-LM358DR2G", manufacturer: "onsemi", stock: 24310, moq: 1, multiple: 1, leadTimeDays: 105, lifecycle: "unknown", currency: "EUR",
      breaks: [{ qty: 1, price: 0.4 }, { qty: 10, price: 0.245 }], sourceRef: "https://www.mouser.com/ProductDetail/863-LM358DR2G",
    });
  });

  it("Errors dolu → hata (anahtar mesajda yok); sonuç yok → null", async () => {
    respond = () => ({ json: { Errors: [{ Code: "InvalidAuthorization", Message: "key mk-1 invalid" }], SearchResults: null } });
    const e = await ms.lookup("X", ctx({ apiKey: "mk-1" })).catch((x: Error) => x);
    expect((e as Error).message).toBe("Mouser: InvalidAuthorization");
    respond = () => ({ json: { Errors: [], SearchResults: { NumberOfResult: 0, Parts: [] } } });
    expect(await ms.lookup("X", ctx({ apiKey: "mk-1" }))).toBeNull();
  });
});

describe("element14 / Farnell (Product Search REST)", () => {
  const e14 = DISTRIBUTOR_ADAPTERS.farnell!;
  const resp = {
    manufacturerPartNumberSearchReturn: {
      numberOfResults: 1,
      products: [{ sku: "1360825", translatedManufacturerPartNumber: "LM339ADT", brandName: "STMICROELECTRONICS", packSize: 1, productStatus: "STOCKED", prices: [{ to: 90, from: 10, cost: 0.78 }, { to: 9, from: 1, cost: 0.95 }], stock: { level: 518, leastLeadTime: 63, status: 1 }, translatedMinimumOrderQuality: 1 }],
    },
  };

  it("sorgu parametreleri belgeye uygun; para birimi mağaza ayarından; teslim süresi (birimi belgesiz) boş", async () => {
    respond = () => ({ json: resp });
    const o = await e14.lookup("LM339ADT", ctx({ apiKey: "ek", storeId: "tr.farnell.com", storeCurrency: "eur" }, { manufacturer: "STMicroelectronics" }));
    const u = new URL(log[0]!.url);
    expect(`${u.origin}${u.pathname}`).toBe("https://api.element14.com/catalog/products");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ term: "manuPartNum:LM339ADT", "storeInfo.id": "tr.farnell.com", "callInfo.apiKey": "ek", "callInfo.responseDataFormat": "JSON", "resultsSettings.responseGroup": "large" });
    expect(o).toEqual({ sku: "1360825", manufacturer: "STMICROELECTRONICS", stock: 518, moq: 1, multiple: 1, leadTimeDays: null, lifecycle: "unknown", currency: "EUR", breaks: [{ qty: 1, price: 0.95 }, { qty: 10, price: 0.78 }], sourceRef: "element14:tr.farnell.com:1360825" });
  });

  it("geçersiz mağaza / para birimi istek atılmadan reddedilir; sonuç yok → null", async () => {
    respond = () => ({ json: resp });
    await expect(e14.lookup("LM339ADT", ctx({ apiKey: "ek", storeId: "http://evil", storeCurrency: "EUR" }))).rejects.toThrow("mağaza");
    await expect(e14.lookup("LM339ADT", ctx({ apiKey: "ek", storeId: "uk.farnell.com", storeCurrency: "pound" }))).rejects.toThrow("para birimi");
    expect(log).toHaveLength(0);
    respond = () => ({ json: { manufacturerPartNumberSearchReturn: { numberOfResults: 0 } } });
    expect(await e14.lookup("NONE", ctx({ apiKey: "ek", storeId: "uk.farnell.com", storeCurrency: "GBP" }))).toBeNull();
  });
});
