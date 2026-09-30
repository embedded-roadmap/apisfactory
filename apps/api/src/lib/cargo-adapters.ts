import { ConnectorError } from "./connector-credentials";
import type { CargoProvider, CargoShipmentRequest, CargoStatus } from "./cargo-providers";

/**
 * Oturum 41 devamı — dış bağımlılık 2b: MNG Kargo adaptörü. DOĞRULANMADI: MNG'nin apizone.mngkargo.com.tr portalında
 * yayımladığı resmi Swagger 2.0 tanımlarından yazıldı (Identity, Standard Command, Barcode Command, Standard Query,
 * CBS Info); gerçek bir MNG müşteri/uygulama hesabıyla denenmedi.
 * Akış: token (müşteri no + şifre, X-IBM-Client-Id/Secret) → CBS ile il/ilçe kodu → createOrder → createbarcode
 * (siparişi faturalaştırıp gönderiye çevirir; gönderi numarası = takip no) · takip: getshipmentstatusByShipmentId.
 * Belgede yazmayanlar uydurulmaz: test adresi resmi tanımda yok (varsayılan testapi.mngkargo.com.tr, ayardan değişir);
 * barkod değerinin etiket biçimi belgesiz → yalnız ZPL olduğu içeriğinden anlaşılırsa etiket dosyası sayılır.
 */

type Fetch = typeof fetch;
export const cargoDeps: { fetch: Fetch; timeoutMs: number } = { fetch: (...a) => fetch(...a), timeoutMs: 20_000 };

const MNG_PROD = "https://api.mngkargo.com.tr";
const MNG_TEST_DEFAULT = "testapi.mngkargo.com.tr";
const tokens = new Map<string, { jwt: string; expiresAt: number }>();
const cityCache = new Map<string, Map<string, string>>();
const districtCache = new Map<string, Map<string, string>>();

export function resetCargoAdapterCaches() {
  tokens.clear();
  cityCache.clear();
  districtCache.clear();
}

async function http(url: string, init: RequestInit) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), cargoDeps.timeoutMs);
  try {
    return await cargoDeps.fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Türkçe karakterleri sadeleştirir — il/ilçe adı eşleştirmesi için ("Çankaya" = "CANKAYA"). */
export function fold(v: string) {
  return v.toLocaleLowerCase("tr").replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c").replace(/[^a-z0-9]/g, "");
}

/** MNG tarihleri "13-02-2019 12:03" veya "10.03.2020 16:05:00" (Türkiye saati, GMT+03:00). */
export function mngDate(v: unknown): string | null {
  const m = String(v ?? "").match(/^(\d{2})[.-](\d{2})[.-](\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] ?? "00"}+03:00`).toISOString();
}

type Ctx = { credentials: Record<string, string>; settings: Record<string, string>; environment: "sandbox" | "production" };

function base(ctx: Ctx) {
  if (ctx.environment === "production") return MNG_PROD;
  const host = ctx.settings.testApiHost || MNG_TEST_DEFAULT;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.mngkargo\.com\.tr$/.test(host)) throw new ConnectorError("MNG test adresi yalnız *.mngkargo.com.tr olabilir", { notSent: true });
  return `https://${host}`;
}

function appHeaders(ctx: Ctx) {
  return { "X-IBM-Client-Id": ctx.credentials.clientId!, "X-IBM-Client-Secret": ctx.credentials.clientSecret!, accept: "application/json" };
}

async function mngError(res: Response) {
  try {
    const j = (await res.json()) as { message?: string; error?: { Description?: string; description?: string; message?: string } };
    const m = j.error?.Description ?? j.error?.description ?? j.error?.message ?? j.message;
    return m ? `HTTP ${res.status}: ${String(m).slice(0, 200)}` : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function jwt(ctx: Ctx) {
  const b = base(ctx);
  const key = `${b}:${ctx.credentials.clientId}:${ctx.credentials.customerNumber}`;
  const hit = tokens.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.jwt;
  const res = await http(`${b}/mngapi/api/token`, {
    method: "POST",
    headers: { ...appHeaders(ctx), "content-type": "application/json" },
    body: JSON.stringify({ customerNumber: ctx.credentials.customerNumber, password: ctx.credentials.password, identityType: 1 }),
  });
  if (!res.ok) throw new ConnectorError(`MNG oturumu açılamadı (HTTP ${res.status}) — erişim bilgisini kontrol edin`, { notSent: true });
  const j = (await res.json()) as { jwt?: string; jwtExpireDate?: string };
  if (!j.jwt) throw new ConnectorError("MNG oturumu açılamadı", { notSent: true });
  const exp = mngDate(j.jwtExpireDate);
  tokens.set(key, { jwt: j.jwt, expiresAt: exp ? Date.parse(exp) : Date.now() + 30 * 60_000 });
  return j.jwt;
}

async function get(ctx: Ctx, path: string, what: string) {
  const res = await http(`${base(ctx)}${path}`, { headers: { ...appHeaders(ctx), authorization: `Bearer ${await jwt(ctx)}` } });
  if (!res.ok) throw new ConnectorError(`MNG ${what}: ${await mngError(res)}`, { notSent: true });
  return res.json() as Promise<any>;
}

async function cityCode(ctx: Ctx, city: string) {
  const b = base(ctx);
  let m = cityCache.get(b);
  if (!m) {
    const list: { code: string; name: string }[] = await get(ctx, "/mngapi/api/cbsinfoapi/getcities", "il listesi");
    m = new Map(list.map((c) => [fold(c.name), c.code]));
    cityCache.set(b, m);
  }
  const code = m.get(fold(city));
  if (!code) throw new ConnectorError(`MNG il kodu bulunamadı: ${city}`, { notSent: true });
  return code;
}

async function districtCode(ctx: Ctx, city: string, district: string) {
  const key = `${base(ctx)}:${city}`;
  let m = districtCache.get(key);
  if (!m) {
    const list: { code: string; name: string }[] = await get(ctx, `/mngapi/api/cbsinfoapi/getdistricts/${encodeURIComponent(city)}`, "ilçe listesi");
    m = new Map(list.map((d) => [fold(d.name), d.code]));
    districtCache.set(key, m);
  }
  const code = m.get(fold(district));
  if (!code) throw new ConnectorError(`MNG ilçe kodu bulunamadı: ${district}`, { notSent: true });
  return code;
}

const MNG_STATUS: Record<number, CargoStatus> = { 1: "created", 2: "in_transit", 3: "in_transit", 4: "out_for_delivery", 5: "delivered", 6: "problem", 7: "returned", 8: "problem" };

export const mng: CargoProvider = {
  credentialFields: ["clientId", "clientSecret", "customerNumber", "password"],
  settingFields: [
    { key: "shipmentServiceType", label: "Gönderi tipi (1 standart, 7 gün içi, 8 akşam)", options: ["1", "7", "8"], required: true },
    { key: "packagingType", label: "Kargo cinsi (1 dosya, 2 mi, 3 paket, 4 koli)", options: ["1", "2", "3", "4"], required: true },
    { key: "paymentType", label: "Ödeme (1 gönderici, 2 alıcı)", options: ["1", "2"], required: true },
    { key: "desiPerPackage", label: "Koli başına desi (ölçü tutulmadığı için şirket belirler)", required: true },
    { key: "testApiHost", label: "Test API adresi (sandbox portalında yazan; boşsa testapi.mngkargo.com.tr)" },
  ],
  verified: false,
  docsUrl: "https://apizone.mngkargo.com.tr/tr/product",

  async createShipment(req: CargoShipmentRequest, ctx) {
    const s = ctx.settings;
    const desi = Number(s.desiPerPackage);
    if (!Number.isInteger(desi) || desi < 1 || desi > 999) throw new ConnectorError("MNG ayarı: koli başına desi 1–999 arası tam sayı olmalı", { notSent: true });
    if (!req.recipient.district) throw new ConnectorError("MNG için alıcı adresinde ilçe gerekli", { notSent: true });
    const missingWeight = req.packages.filter((p) => p.weightKg === null).map((p) => p.code);
    if (missingWeight.length) throw new ConnectorError(`MNG için koli ağırlığı gerekli: ${missingWeight.join(", ")}`, { notSent: true });
    const referenceId = req.shipmentCode.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    const cCode = await cityCode(ctx, req.recipient.city);
    const dCode = await districtCode(ctx, cCode, req.recipient.district);
    const pieces = req.packages.map((p, i) => ({ barcode: `${referenceId}-${i + 1}`, desi, kg: Math.max(1, Math.ceil(Number(p.weightKg))), content: p.code }));
    const headers = { ...appHeaders(ctx), "content-type": "application/json", authorization: `Bearer ${await jwt(ctx)}` };

    // 1) Sipariş. Başarısızsa MNG'de hiçbir kayıt yok → kesin ret.
    const order = await http(`${base(ctx)}/mngapi/api/standardcmdapi/createOrder`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        order: {
          referenceId, barcode: referenceId, billOfLandingId: referenceId, isCOD: 0, codAmount: 0,
          shipmentServiceType: Number(s.shipmentServiceType), packagingType: Number(s.packagingType), content: `Sevkiyat ${req.shipmentCode}`,
          smsPreference1: 0, smsPreference2: 0, smsPreference3: 0, paymentType: Number(s.paymentType), deliveryType: 1, description: req.shipmentCode,
        },
        orderPieceList: pieces,
        recipient: {
          fullName: req.recipient.name, cityCode: Number(cCode), districtCode: Number(dCode),
          address: [req.recipient.line1, req.recipient.line2].filter(Boolean).join(" "), mobilePhoneNumber: req.recipient.phone ?? undefined,
        },
      }),
    });
    if (!order.ok) throw new ConnectorError(`MNG sipariş: ${await mngError(order)}`, { notSent: true });

    // 2) Gönderiye çevirme. Sipariş MNG'de VAR; buradaki hata belirsizdir (aynı referansla yeniden sipariş açılamaz).
    const bc = await http(`${base(ctx)}/mngapi/api/barcodecmdapi/createbarcode`, { method: "POST", headers, body: JSON.stringify({ referenceId }) });
    if (!bc.ok) throw new Error(`MNG sipariş ${referenceId} açıldı ama gönderiye çevrilemedi (${await mngError(bc)}) — MNG panelinden kontrol edin`);
    const out = (await bc.json()) as { shipmentId?: string; barcodes?: { pieceNumber: number; value: string }[] };
    if (!out.shipmentId) throw new Error(`MNG sipariş ${referenceId}: gönderi numarası dönmedi — MNG panelinden kontrol edin`);
    const first = out.barcodes?.[0]?.value ?? "";
    const isZpl = /^\s*\^XA/.test(first);
    return {
      trackingNo: String(out.shipmentId),
      labelRef: isZpl ? `MNG-${out.shipmentId}` : first ? first.slice(0, 80) : `MNG-${out.shipmentId}`,
      label: isZpl ? { contentType: "application/zpl", data: Buffer.from((out.barcodes ?? []).map((b) => b.value).join("\n"), "utf8") } : undefined,
    };
  },

  async track(trackingNo, ctx) {
    const j = await get(ctx, `/mngapi/api/standardqueryapi/getshipmentstatusByShipmentId/${encodeURIComponent(trackingNo)}`, "takip");
    const r = Array.isArray(j) ? j[0] : j;
    const code = Number(r?.shipmentStatusCode);
    return { status: MNG_STATUS[code] ?? "unknown", raw: String(r?.shipmentStatus ?? code ?? "").slice(0, 120), at: mngDate(r?.statusDateTime) };
  },
};

export const CARGO_ADAPTERS: Record<string, CargoProvider> = { mng };
