import { ConnectorError } from "./connector-credentials";
import type { EinvoiceDocument, EinvoiceProvider } from "./einvoice-providers";

/**
 * Oturum 41 devamı — dış bağımlılık 1b: Paraşüt adaptörü. DOĞRULANMADI: api.parasut.com/v4 resmi Swagger'ından
 * (apidocs.parasut.com/swagger.json, "Satış Faturası Resmileştirme" bölümü) yazıldı; gerçek bir Paraşüt hesabıyla denenmedi.
 * Paraşüt UBL XML almaz — akış: (1) alıcı e-Fatura gelen kutusu sorgusu, (2) müşteri kartı bul/oluştur, (3) satış faturası,
 * (4) e-Fatura / e-Arşiv isteği → iş takibi (asenkron), (5) satış faturası ?include=active_e_document → UUID (ETTN).
 * Paraşüt'te ayrı test adresi yoktur (belge tek BASE_URL verir); deneme Paraşüt'ün verdiği test firmasıyla yapılır.
 *
 * Hata sınıflaması (işçi kuralı): belge OLUŞMADIĞI kesin olan durumlar ConnectorError{notSent} → 'failed' (yeniden
 * gönderilebilir). Resmileştirme isteği gittikten sonraki belirsizlikler (zaman aşımı, UUID yok) düz Error → 'unknown'.
 */

type Fetch = typeof fetch;
export const einvoiceDeps: { fetch: Fetch; pollIntervalMs: number; pollTimeoutMs: number; timeoutMs: number } = {
  fetch: (...a) => fetch(...a),
  pollIntervalMs: 2_000,
  pollTimeoutMs: 90_000,
  timeoutMs: 20_000,
};

const BASE = "https://api.parasut.com";
const CURRENCY: Record<string, string> = { TRY: "TRL", USD: "USD", EUR: "EUR", GBP: "GBP" };
const tokens = new Map<string, { token: string; expiresAt: number }>();

export function resetEinvoiceTokenCache() {
  tokens.clear();
}

async function http(url: string, init: RequestInit = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), einvoiceDeps.timeoutMs);
  try {
    return await einvoiceDeps.fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Paraşüt hata gövdesi JSON:API: { errors: [{ title, detail }] } — yalnız başlık/ayrıntı alınır (sır içermez). */
async function errorText(res: Response) {
  try {
    const j = (await res.json()) as { errors?: { title?: string; detail?: string }[] };
    const e = j.errors?.map((x) => [x.title, x.detail].filter(Boolean).join(": ")).filter(Boolean).join("; ");
    return e ? e.slice(0, 300) : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function token(c: Record<string, string>) {
  const key = `${c.clientId}:${c.username}`;
  const hit = tokens.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const res = await http(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: c.clientId!, client_secret: c.clientSecret!, username: c.username!, password: c.password!, redirect_uri: "urn:ietf:wg:oauth:2.0:oob" }).toString(),
  });
  // Jeton alınamadıysa hiçbir şey oluşmadı → kesin ret.
  if (!res.ok) throw new ConnectorError(`Paraşüt oturumu açılamadı (HTTP ${res.status}) — erişim bilgisini kontrol edin`, { notSent: true });
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new ConnectorError("Paraşüt oturumu açılamadı", { notSent: true });
  tokens.set(key, { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 7200) * 1000 });
  return j.access_token;
}

export async function sendViaParasut(doc: EinvoiceDocument, c: Record<string, string>): Promise<{ ettn: string; providerRef?: string }> {
  if (!/^\d+$/.test(c.companyId ?? "")) throw new ConnectorError("Paraşüt firma numarası (companyId) sayısal olmalı", { notSent: true });
  const currency = CURRENCY[doc.currency];
  // Döviz faturası kur ister; belgemizde kur alanı yok → uydurulmaz, desteklenene kadar açıkça reddedilir.
  if (currency !== "TRL") throw new ConnectorError(`Paraşüt adaptörü şimdilik yalnız TL faturayı gönderir (fatura: ${doc.currency})`, { notSent: true });
  const buyerTax = doc.buyer.taxNo.replace(/\s/g, "");
  if (!/^\d{10,11}$/.test(buyerTax)) throw new ConnectorError("Paraşüt için alıcının VKN/TCKN'si gerekli", { notSent: true });

  const api = `${BASE}/v4/${c.companyId}`;
  const auth = { authorization: `Bearer ${await token(c)}`, accept: "application/json" };
  const jsonHeaders = { ...auth, "content-type": "application/json" };
  const get = async (path: string, what: string) => {
    const res = await http(`${api}${path}`, { headers: auth });
    if (!res.ok) throw new ConnectorError(`Paraşüt ${what}: ${await errorText(res)}`, { notSent: true });
    return (await res.json()) as any;
  };
  const post = async (path: string, body: unknown, what: string) => {
    const res = await http(`${api}${path}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
    if (!res.ok) throw new ConnectorError(`Paraşüt ${what}: ${await errorText(res)}`, { notSent: true });
    return (await res.json()) as any;
  };

  // 1) e-Fatura mükellefiyeti: gelen kutusu varsa e-Fatura, yoksa e-Arşiv zorunlu (Paraşüt kuralı). Seçim uyuşmazsa gönderilmez.
  const inboxes: any[] = (await get(`/e_invoice_inboxes?filter[vkn]=${encodeURIComponent(buyerTax)}`, "gelen kutusu sorgusu")).data ?? [];
  if (doc.kind === "e_fatura" && !inboxes.length) throw new ConnectorError("Alıcı e-Fatura mükellefi değil — e-Arşiv olarak gönderin", { notSent: true });
  if (doc.kind === "e_arsiv" && inboxes.length) throw new ConnectorError("Alıcı e-Fatura mükellefi — e-Fatura olarak gönderin", { notSent: true });

  // 2) Müşteri kartı: vergi numarasıyla bul, yoksa oluştur.
  const found: any[] = (await get(`/contacts?filter[tax_number]=${encodeURIComponent(buyerTax)}&filter[account_type]=customer`, "müşteri sorgusu")).data ?? [];
  const contactId: string =
    found[0]?.id ??
    (
      await post("/contacts", {
        data: {
          type: "contacts",
          attributes: {
            name: doc.buyer.legalName, account_type: "customer", contact_type: buyerTax.length === 11 ? "person" : "company",
            tax_number: buyerTax, tax_office: doc.buyer.taxOffice ?? undefined, address: doc.buyer.addressLine, city: doc.buyer.city,
            district: doc.buyer.district ?? undefined, postal_code: doc.buyer.postalCode ?? undefined,
          },
        },
      }, "müşteri oluşturma")
    ).data.id;

  // 3) Satış faturası (açıklamada bizim fatura kodumuz — Paraşüt tarafında izlenebilirlik).
  const vatRate = Number(doc.taxRate);
  const si = await post("/sales_invoices", {
    data: {
      type: "sales_invoices",
      attributes: {
        item_type: "invoice", description: doc.invoiceCode, issue_date: doc.invoiceDate, currency,
        tax_number: buyerTax, tax_office: doc.buyer.taxOffice ?? undefined, billing_address: doc.buyer.addressLine,
        billing_postal_code: doc.buyer.postalCode ?? undefined, city: doc.buyer.city, district: doc.buyer.district ?? undefined,
      },
      relationships: {
        contact: { data: { id: contactId, type: "contacts" } },
        details: { data: doc.lines.map((l) => ({ type: "sales_invoice_details", attributes: { quantity: Number(l.qty), unit_price: Number(l.unitPrice), vat_rate: vatRate, description: l.description } })) },
      },
    },
  }, "satış faturası");
  const salesInvoiceId: string = si.data.id;

  // 4) Resmileştirme. Buradan sonra belge oluşmuş olabilir → hata sınıfı dikkatle seçilir.
  let job: any;
  if (doc.kind === "e_fatura") {
    job = await post("/e_invoices", {
      data: { type: "e_invoices", attributes: { scenario: "basic", to: inboxes[0].attributes?.e_invoice_address }, relationships: { invoice: { data: { id: salesInvoiceId, type: "sales_invoices" } } } },
    }, "e-Fatura isteği");
  } else {
    job = await post("/e_archives", {
      data: { type: "e_archives", attributes: {}, relationships: { sales_invoice: { data: { id: salesInvoiceId, type: "sales_invoices" } } } },
    }, "e-Arşiv isteği");
  }
  const jobId: string = job.data.id;
  const deadline = Date.now() + einvoiceDeps.pollTimeoutMs;
  for (;;) {
    const res = await http(`${api}/trackable_jobs/${jobId}`, { headers: auth });
    if (!res.ok) throw new Error(`Paraşüt iş takibi: HTTP ${res.status} (satış faturası ${salesInvoiceId})`);
    const a = ((await res.json()) as any).data?.attributes ?? {};
    if (a.status === "done") break;
    if (a.status === "error") throw new ConnectorError(`Paraşüt resmileştirme hatası: ${(a.errors ?? []).join("; ").slice(0, 300) || "ayrıntı yok"}`, { notSent: true });
    if (Date.now() > deadline) throw new Error(`Paraşüt resmileştirmesi zamanında bitmedi (satış faturası ${salesInvoiceId}) — Paraşüt panelinden kontrol edin`);
    await new Promise((r) => setTimeout(r, einvoiceDeps.pollIntervalMs));
  }

  // 5) ETTN: aktif e-belgenin UUID'si.
  const show = await http(`${api}/sales_invoices/${salesInvoiceId}?include=active_e_document`, { headers: auth });
  if (!show.ok) throw new Error(`Paraşüt fatura sorgusu: HTTP ${show.status} (satış faturası ${salesInvoiceId})`);
  const body = (await show.json()) as any;
  const ref = body.data?.relationships?.active_e_document?.data;
  const edoc = (body.included ?? []).find((x: any) => ref && x.id === ref.id && x.type === ref.type) ?? (body.included ?? []).find((x: any) => ["e_invoices", "e_archives"].includes(x.type));
  const uuid = String(edoc?.attributes?.uuid ?? "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) throw new Error(`Paraşüt belgesi oluştu ama ETTN okunamadı (satış faturası ${salesInvoiceId})`);
  return { ettn: uuid, providerRef: `parasut:${salesInvoiceId}` };
}

export const parasut: EinvoiceProvider = {
  credentialFields: ["clientId", "clientSecret", "username", "password", "companyId"],
  verified: false,
  docsUrl: "https://apidocs.parasut.com/",
  send: (doc, credentials) => sendViaParasut(doc, credentials),
};

export const EINVOICE_ADAPTERS: Record<string, EinvoiceProvider> = { parasut };
