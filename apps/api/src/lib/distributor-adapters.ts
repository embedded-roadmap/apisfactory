import type { DistributorEnvironment, DistributorOffer, DistributorProvider } from "./distributor-providers";

/**
 * Oturum 41 devamı — dış bağımlılık 3b: DigiKey, Mouser, element14 (Farnell) adaptörleri.
 * DOĞRULANMADI: istek/yanıt biçimleri distribütörlerin yayımladığı belgelerden alındı (kaynaklar aşağıda), gerçek bir
 * geliştirici hesabıyla henüz denenmedi — bu yüzden her adaptör `verified: false` taşır ve ekranda öyle gösterilir.
 *  - DigiKey Product Information v4: resmi Swagger'dan üretilmiş istemci (attribute_map) — /products/v4/search/{no}/productdetails,
 *    OAuth2 client_credentials (/v1/oauth2/token), X-DIGIKEY-Client-Id / Locale-Currency başlıkları.
 *  - Mouser Search API v1: api.mouser.com/api/docs/V1 (Swagger 2.0) — POST /api/v1/search/partnumber?apiKey=…
 *  - element14 Product Search REST: partner.element14.com/docs — GET /catalog/products?term=manuPartNum:…
 * Belgede birimi yazmayan alanlar (element14 stock.leastLeadTime) tahmin edilmez, boş bırakılır.
 */

type Fetch = typeof fetch;
export const distributorDeps: { fetch: Fetch; timeoutMs: number } = { fetch: (...a) => fetch(...a), timeoutMs: 15_000 };

/** Hata mesajına erişim bilgisi veya yanıt gövdesi konmaz (çağıran zaten ayrıntıyı kullanıcıya göstermez). */
export class UpstreamError extends Error {}

async function call(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), distributorDeps.timeoutMs);
  try {
    return await distributorDeps.fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function json(res: Response, what: string) {
  if (!res.ok) throw new UpstreamError(`${what}: HTTP ${res.status}`);
  return res.json() as Promise<any>;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** "$1.23", "1,23 €", "1.234,56", "TRY 12,34" → sayı. Hem nokta hem virgül varsa sondaki ondalıktır. */
export function parseLocalizedPrice(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  let s = v.replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (lastComma >= 0) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "14 Weeks", "70 Days", "8" (DigiKey: hafta) → gün. */
export function leadDays(v: unknown, defaultUnit: "weeks" | "days"): number | null {
  if (v === null || v === undefined || v === "") return null;
  const m = String(v).match(/(\d+(?:\.\d+)?)\s*(week|wk|day|gün|hafta)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ? (/^(day|gün)/i.test(m[2]) ? "days" : "weeks") : defaultUnit;
  return Math.round(unit === "weeks" ? n * 7 : n);
}

const sameMpn = (a: unknown, b: string) => String(a ?? "").replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();
const sameMfr = (a: unknown, b: string | null) => !b || String(a ?? "").toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(String(a ?? "").toLowerCase());

// ---- DigiKey ------------------------------------------------------------------------------------------------------

const DIGIKEY_BASE: Record<DistributorEnvironment, string> = { sandbox: "https://sandbox-api.digikey.com", production: "https://api.digikey.com" };
const dkTokens = new Map<string, { token: string; expiresAt: number }>();

async function digikeyToken(env: DistributorEnvironment, clientId: string, clientSecret: string) {
  const key = `${env}:${clientId}`;
  const hit = dkTokens.get(key);
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token;
  const res = await call(`${DIGIKEY_BASE[env]}/v1/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }).toString(),
  });
  const j = await json(res, "DigiKey token");
  if (!j.access_token) throw new UpstreamError("DigiKey token: access_token yok");
  dkTokens.set(key, { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 600) * 1000 });
  return j.access_token as string;
}

export function resetDistributorTokenCache() {
  dkTokens.clear();
}

function digikeyLifecycle(p: any): DistributorOffer["lifecycle"] {
  const s = String(p?.ProductStatus?.Status ?? "").toLowerCase();
  if (s === "obsolete") return "obsolete";
  if (p?.EndOfLife || s.includes("last time buy")) return "eol";
  if (s.includes("not for new design")) return "nrnd";
  if (s === "active") return "active";
  return "unknown";
}

const digikey: DistributorProvider = {
  credentialFields: ["clientId", "clientSecret"],
  // Gerçek üretim hesabıyla doğrulandı (2026-09-30): productdetails, 404 → keyword ExactMatches, fiyat/stok/ömür eşlemesi.
  verified: true,
  docsUrl: "https://developer.digikey.com/products/product-information-v4/productsearch/productdetails",
  async lookup(mpn, ctx) {
    const token = await digikeyToken(ctx.environment, ctx.credentials.clientId!, ctx.credentials.clientSecret!);
    const headers = { authorization: `Bearer ${token}`, "X-DIGIKEY-Client-Id": ctx.credentials.clientId!, "X-DIGIKEY-Locale-Currency": ctx.currency, accept: "application/json" };
    const res = await call(`${DIGIKEY_BASE[ctx.environment]}/products/v4/search/${encodeURIComponent(mpn)}/productdetails`, { headers });
    if (res.status === 401) dkTokens.delete(`${ctx.environment}:${ctx.credentials.clientId}`);
    let p: any;
    let locale: any;
    if (res.status === 404) {
      // Gerçek hesapla görüldü (2026-09-30): aynı MPN'yi birden çok üretici yapıyorsa (ör. NE555DR: TI + UMW) productdetails
      // 404 döner. O zaman anahtar kelime aramasının ExactMatches listesi kullanılır; üretici verilmişse ona göre süzülür,
      // verilmemişse stoğu en yüksek olan seçilir (seçilen üretici teklifte görünür).
      const kw = await call(`${DIGIKEY_BASE[ctx.environment]}/products/v4/search/keyword`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ Keywords: mpn, Limit: 10, Offset: 0 }),
      });
      const k = await json(kw, "DigiKey keyword");
      const exact = ((k?.ExactMatches ?? []) as any[]).filter((x) => sameMpn(x.ManufacturerProductNumber, mpn) && sameMfr(x.Manufacturer?.Name, ctx.manufacturer));
      if (!exact.length) return null;
      p = [...exact].sort((a, b) => (num(b.QuantityAvailable) ?? -1) - (num(a.QuantityAvailable) ?? -1))[0];
      locale = k?.SearchLocaleUsed;
    } else {
      const j = await json(res, "DigiKey productdetails");
      p = j?.Product;
      locale = j?.SearchLocaleUsed;
      if (!p || !sameMpn(p.ManufacturerProductNumber, mpn) || !sameMfr(p.Manufacturer?.Name, ctx.manufacturer)) return null;
    }
    // Birden çok paket türü (kesik bant, makara…) olabilir: fiyat merdiveni en küçük asgari adetli varyasyondan alınır.
    const vars: any[] = Array.isArray(p.ProductVariations) ? p.ProductVariations : [];
    const v = [...vars].sort((a, b) => (num(a.MinimumOrderQuantity) ?? 1e12) - (num(b.MinimumOrderQuantity) ?? 1e12))[0];
    const breaks = ((v?.StandardPricing ?? []) as any[])
      .map((b) => ({ qty: num(b.BreakQuantity), price: num(b.UnitPrice) }))
      .filter((b): b is { qty: number; price: number } => b.qty !== null && b.price !== null)
      .sort((a, b) => a.qty - b.qty);
    return {
      sku: v?.DigiKeyProductNumber ?? null,
      manufacturer: p.Manufacturer?.Name ?? null,
      stock: num(p.QuantityAvailable),
      moq: num(v?.MinimumOrderQuantity ?? p.MinimumOrderQuantity),
      multiple: null, // DigiKey yanıtında sipariş katı alanı yok (StandardPackage üretici paketidir, sipariş katı değil)
      leadTimeDays: leadDays(p.ManufacturerLeadWeeks, "weeks"),
      lifecycle: digikeyLifecycle(p),
      currency: String(locale?.Currency ?? ctx.currency).toUpperCase(),
      breaks,
      sourceRef: p.ProductUrl ?? `digikey:${v?.DigiKeyProductNumber ?? mpn}`,
    };
  },
};

// ---- Mouser -------------------------------------------------------------------------------------------------------

function mouserLifecycle(p: any): DistributorOffer["lifecycle"] {
  const s = String(p?.LifecycleStatus ?? "").toLowerCase();
  if (s.includes("obsolete")) return "obsolete";
  if (s.includes("end of life")) return "eol";
  if (s.includes("not recommended")) return "nrnd";
  if (s.includes("new product") || s.includes("new at mouser")) return "active";
  return "unknown"; // Mouser normal ürünlerde alanı boş bırakır; boşluk "aktif" diye yorumlanmaz.
}

const mouser: DistributorProvider = {
  credentialFields: ["apiKey"],
  verified: false,
  docsUrl: "https://api.mouser.com/api/docs/ui/index",
  async lookup(mpn, ctx) {
    // Mouser'da ayrı test ortamı yok; iki ortam da aynı uç noktadır.
    const res = await call(`https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(ctx.credentials.apiKey!)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: "Exact" } }),
    });
    const j = await json(res, "Mouser partnumber");
    if (Array.isArray(j?.Errors) && j.Errors.length) throw new UpstreamError(`Mouser: ${j.Errors.map((e: any) => e.Code).join(",")}`);
    const parts: any[] = j?.SearchResults?.Parts ?? [];
    const p = parts.find((x) => sameMpn(x.ManufacturerPartNumber, mpn) && sameMfr(x.Manufacturer, ctx.manufacturer));
    if (!p) return null;
    const pbs: any[] = p.PriceBreaks ?? [];
    return {
      sku: p.MouserPartNumber ?? null,
      manufacturer: p.Manufacturer ?? null,
      stock: num(p.AvailabilityInStock) ?? 0,
      moq: num(p.Min),
      multiple: num(p.Mult),
      leadTimeDays: leadDays(p.LeadTime, "days"),
      lifecycle: mouserLifecycle(p),
      currency: String(pbs[0]?.Currency ?? ctx.currency).toUpperCase(),
      breaks: pbs
        .map((b) => ({ qty: num(b.Quantity), price: parseLocalizedPrice(b.Price) }))
        .filter((b): b is { qty: number; price: number } => b.qty !== null && b.price !== null)
        .sort((a, b) => a.qty - b.qty),
      sourceRef: p.ProductDetailUrl ?? `mouser:${p.MouserPartNumber}`,
    };
  },
};

// ---- element14 / Farnell ------------------------------------------------------------------------------------------

function element14Lifecycle(p: any): DistributorOffer["lifecycle"] {
  const s = String(p?.productStatus ?? "").toUpperCase();
  if (s === "NO_LONGER_MANUFACTURED") return "obsolete";
  return "unknown"; // STOCKED / DIRECT_SHIP… stok durumudur, ömür döngüsü değil.
}

const element14: DistributorProvider = {
  // Mağaza (ör. tr.farnell.com, uk.farnell.com) ve o mağazanın para birimi: yanıtta para birimi yok, mağazaya göre örtüktür —
  // uydurulmaz, şirket kendi hesabındaki para birimini girer.
  credentialFields: ["apiKey", "storeId", "storeCurrency"],
  verified: false,
  docsUrl: "https://partner.element14.com/docs/Product_Search_API_REST__Description",
  async lookup(mpn, ctx) {
    const store = ctx.credentials.storeId!;
    const cur = ctx.credentials.storeCurrency!.toUpperCase();
    if (!/^[a-z]{2}\.[a-z0-9.-]+$/.test(store)) throw new UpstreamError("element14: geçersiz mağaza kimliği");
    if (!/^[A-Z]{3}$/.test(cur)) throw new UpstreamError("element14: geçersiz para birimi");
    const q = new URLSearchParams({
      term: `manuPartNum:${mpn}`,
      "storeInfo.id": store,
      "resultsSettings.offset": "0",
      "resultsSettings.numberOfResults": "10",
      "resultsSettings.responseGroup": "large",
      "callInfo.responseDataFormat": "JSON",
      "callInfo.apiKey": ctx.credentials.apiKey!,
    });
    const j = await json(await call(`https://api.element14.com/catalog/products?${q}`, { headers: { accept: "application/json" } }), "element14 products");
    const products: any[] = j?.manufacturerPartNumberSearchReturn?.products ?? [];
    const p = products.find((x) => sameMpn(x.translatedManufacturerPartNumber, mpn) && sameMfr(x.brandName ?? x.vendorName, ctx.manufacturer));
    if (!p) return null;
    return {
      sku: p.sku ?? null,
      manufacturer: p.brandName ?? p.vendorName ?? null,
      stock: num(p.stock?.level),
      moq: num(p.translatedMinimumOrderQuality),
      multiple: num(p.packSize),
      leadTimeDays: null, // stock.leastLeadTime biriminin gün mü hafta mı olduğu belgede yazmıyor
      lifecycle: element14Lifecycle(p),
      currency: cur,
      breaks: ((p.prices ?? []) as any[])
        .map((b) => ({ qty: num(b.from), price: num(b.cost) }))
        .filter((b): b is { qty: number; price: number } => b.qty !== null && b.price !== null)
        .sort((a, b) => a.qty - b.qty),
      sourceRef: `element14:${store}:${p.sku}`,
    };
  },
};

export const DISTRIBUTOR_ADAPTERS: Record<string, DistributorProvider> = { digikey, mouser, farnell: element14 };
