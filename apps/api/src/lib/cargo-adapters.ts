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

// ---- Basit Kargo (toplayıcı) ---------------------------------------------------------------------------------------
// Kaynak: basitkargo.com/api (herkese açık REST belgesi). Tek adaptörle PTT, MNG, Yurtiçi, Aras, Sürat, HepsiJET,
// KolayGelsin, Birgünde + şirketin kendi anlaşması (SELF_…). Ayrı test ortamı yok. Etiket SVG'dir; SVG betik taşıyabildiği
// için uygulama alanından satır içi sunulmaz — etiket Basit Kargo panelinden basılır.

const BK_BASE = "https://basitkargo.com/api";
const BK_HANDLERS = ["PTT", "MNG", "YURTICI", "ARAS", "SURAT", "HEPSIJET", "KOLAYGELSIN", "BIRGUNDEKARGO", "ECONOMIC", "FAST", "SELF_PTT", "SELF_MNG", "SELF_YURTICI", "SELF_ARAS", "SELF_SURAT"];
const BK_STATUS: Record<string, CargoStatus> = {
  NEW: "created", READY_TO_SHIP: "created", SHIPPED: "in_transit", DELAYED: "in_transit", OUT_FOR_DELIVERY: "out_for_delivery",
  DELIVERED: "delivered", RETURNING: "returned", RETURNED: "returned", NEEDS_SUPPORT: "problem", LOST: "problem",
};

async function bkError(res: Response) {
  try {
    const j = (await res.json()) as { message?: string; error?: string; errors?: string[] };
    const m = j.message ?? j.error ?? j.errors?.join("; ");
    return m ? `HTTP ${res.status}: ${String(m).slice(0, 200)}` : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Belge: telefon 10 hane olmalı (fazla hane kesilmez, reddedilir) → 0/90 öneki atılır, 10 hane değilse gönderilmez. */
export function tenDigitPhone(v: string | null) {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("90")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^\d{10}$/.test(d) ? d : null;
}

const dim = (v: string | undefined, label: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 500) throw new ConnectorError(`Basit Kargo ayarı: ${label} 0–500 cm arası olmalı`, { notSent: true });
  return n;
};

export const basitkargo: CargoProvider = {
  credentialFields: ["apiToken"],
  settingFields: [
    { key: "handlerCode", label: "Kargo firması (SELF_ = kendi anlaşmanız, ECONOMIC/FAST = otomatik)", options: BK_HANDLERS, required: true },
    { key: "packageHeightCm", label: "Koli yüksekliği (cm)", required: true },
    { key: "packageWidthCm", label: "Koli genişliği (cm)", required: true },
    { key: "packageDepthCm", label: "Koli derinliği (cm)", required: true },
    { key: "addressId", label: "Kayıtlı gönderici adres ID (boşsa varsayılan)" },
  ],
  verified: false,
  docsUrl: "https://basitkargo.com/api",

  async createShipment(req, ctx) {
    const s = ctx.settings;
    if (!BK_HANDLERS.includes(s.handlerCode ?? "")) throw new ConnectorError("Basit Kargo ayarı: kargo firması seçilmeli", { notSent: true });
    const [h, wd, dp] = [dim(s.packageHeightCm, "yükseklik"), dim(s.packageWidthCm, "genişlik"), dim(s.packageDepthCm, "derinlik")];
    const phone = tenDigitPhone(req.recipient.phone);
    if (!phone) throw new ConnectorError("Basit Kargo için alıcı telefonu 10 haneli olmalı (5xx…)", { notSent: true });
    if (!req.recipient.district) throw new ConnectorError("Basit Kargo için alıcı adresinde ilçe gerekli", { notSent: true });
    const missing = req.packages.filter((p) => p.weightKg === null).map((p) => p.code);
    if (missing.length) throw new ConnectorError(`Basit Kargo için koli ağırlığı gerekli: ${missing.join(", ")}`, { notSent: true });
    const headers = { authorization: `Bearer ${ctx.credentials.apiToken}`, "content-type": "application/json", accept: "application/json" };

    // 1) Taslak sipariş (NEW). Başarısızsa hiçbir kayıt yok.
    const o = await http(`${BK_BASE}/v2/order`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "OUTGOING",
        content: { name: `Sevkiyat ${req.shipmentCode}`, code: req.shipmentCode, packages: req.packages.map((p) => ({ height: h, width: wd, depth: dp, weight: Number(p.weightKg) })) },
        client: { name: req.recipient.name, phone, city: req.recipient.city, town: req.recipient.district, address: [req.recipient.line1, req.recipient.line2].filter(Boolean).join(" ") },
        ...(s.addressId ? { addressId: s.addressId } : {}),
      }),
    });
    if (!o.ok) throw new ConnectorError(`Basit Kargo sipariş: ${await bkError(o)}`, { notSent: true });
    const order = (await o.json()) as { id?: string };
    if (!order.id) throw new ConnectorError("Basit Kargo sipariş: kimlik dönmedi", { notSent: true });

    // 2) Kargo kodu. Belge: başarısızlıkta sipariş NEW kalır (ücret düşülmez) → açık ret kesin; ağ hatası belirsiz.
    let b: Response;
    try {
      b = await http(`${BK_BASE}/v2/order/${encodeURIComponent(order.id)}/barcode`, { method: "POST", headers, body: JSON.stringify({ handlerCode: s.handlerCode }) });
    } catch (e) {
      throw new Error(`Basit Kargo sipariş ${order.id} açıldı, kargo kodu yanıtı alınamadı (${(e as Error).name}) — panelden kontrol edin`);
    }
    if (b.status >= 500) throw new Error(`Basit Kargo sipariş ${order.id}: kargo kodu isteği ${await bkError(b)} — panelden kontrol edin`);
    if (!b.ok) throw new ConnectorError(`Basit Kargo kargo kodu: ${await bkError(b)} (taslak sipariş ${order.id} panelde kalır)`, { notSent: true });
    const r = (await b.json()) as { id: string; barcode?: string; shipmentInfo?: { handler?: { name?: string }; handlerShipmentCode?: string | null } };
    if (!r.barcode) throw new Error(`Basit Kargo sipariş ${order.id}: kargo kodu dönmedi — panelden kontrol edin`);
    return { trackingNo: r.barcode, labelRef: `BK-${order.id}` };
  },

  async track(trackingNo, ctx) {
    const res = await http(`${BK_BASE}/v2/order/barcode/${encodeURIComponent(trackingNo)}`, { headers: { authorization: `Bearer ${ctx.credentials.apiToken}`, accept: "application/json" } });
    if (!res.ok) throw new ConnectorError(`Basit Kargo takip: ${await bkError(res)}`, { notSent: true });
    const j = (await res.json()) as { status?: string };
    const st = String(j.status ?? "");
    return { status: BK_STATUS[st] ?? "unknown", raw: st.slice(0, 120), at: null };
  },
};

export const CARGO_ADAPTERS: Record<string, CargoProvider> = { mng, basitkargo };
