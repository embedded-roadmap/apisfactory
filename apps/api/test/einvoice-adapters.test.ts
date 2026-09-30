/**
 * Oturum 41 devamı — dış bağımlılık 1b: Paraşüt adaptörü (DOĞRULANMADI — gerçek hesap yok).
 * Sahte fetch ile resmi Swagger'daki akış sınanır: oturum (password grant) → gelen kutusu → müşteri → satış faturası →
 * e-Fatura/e-Arşiv → iş takibi → active_e_document UUID. Hata sınıfları: kesin ret = notSent, belirsizlik = düz Error.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { einvoiceDeps, resetEinvoiceTokenCache } from "../src/lib/einvoice-adapters";
import { EINVOICE_PROVIDERS, type EinvoiceDocument } from "../src/lib/einvoice-providers";
import { ConnectorError } from "../src/lib/connector-credentials";

type Req = { method: string; url: string; path: string; headers: Headers; body: string };
let log: Req[] = [];
let routes: ((r: Req) => { status?: number; json?: unknown } | undefined)[] = [];
const real = { ...einvoiceDeps };
const P = EINVOICE_PROVIDERS.parasut!;
const CREDS = { clientId: "cid", clientSecret: "csec", username: "u@firma.test", password: "pw-SECRET", companyId: "12345" };
const ETTN = "5f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const doc = (over: Partial<EinvoiceDocument> = {}): EinvoiceDocument => ({
  kind: "e_fatura", invoiceCode: "FTR-000042", invoiceDate: "2026-09-30", currency: "TRY", taxRate: "20.00",
  netAmount: "200.00", taxAmount: "40.00", grossAmount: "240.00",
  seller: { legalName: "Şirket A", taxNo: "1234567890", taxOffice: "Kadıköy", addressLine: "Sanayi Cad. 1", district: null, city: "İstanbul", postalCode: "34700", country: "TR" },
  buyer: { legalName: "Alıcı Ltd.", taxNo: "9876543210", taxOffice: "Çankaya", addressLine: "Deneme Cad. 5", district: "Çankaya", city: "Ankara", postalCode: null, country: "TR" },
  lines: [{ lineNo: 1, description: "Kart", qty: "2", unitPrice: "100.00", amount: "200.00" }],
  ...over,
});

function happy(opts: { inbox: boolean; contactExists?: boolean; jobStates?: string[]; uuid?: string | null }) {
  const states = [...(opts.jobStates ?? ["running", "done"])];
  routes = [
    (r) => (r.path === "/oauth/token" ? { json: { access_token: "tok", token_type: "bearer", expires_in: 7200, refresh_token: "r" } } : undefined),
    (r) => (r.path === "/v4/12345/e_invoice_inboxes" ? { json: { data: opts.inbox ? [{ id: "1", type: "e_invoice_inboxes", attributes: { vkn: "9876543210", e_invoice_address: "urn:mail:defaultpk@alici.test" } }] : [] } } : undefined),
    (r) => (r.path === "/v4/12345/contacts" && r.method === "GET" ? { json: { data: opts.contactExists ? [{ id: "77", type: "contacts" }] : [] } } : undefined),
    (r) => (r.path === "/v4/12345/contacts" && r.method === "POST" ? { status: 201, json: { data: { id: "88", type: "contacts" } } } : undefined),
    (r) => (r.path === "/v4/12345/sales_invoices" ? { status: 201, json: { data: { id: "555", type: "sales_invoices" } } } : undefined),
    (r) => (["/v4/12345/e_invoices", "/v4/12345/e_archives"].includes(r.path) ? { status: 201, json: { data: { id: "job-1", type: "trackable_jobs", attributes: { status: "running" } } } } : undefined),
    (r) => (r.path === "/v4/12345/trackable_jobs/job-1" ? { json: { data: { id: "job-1", type: "trackable_jobs", attributes: { status: states.shift() ?? "done", errors: [] } } } } : undefined),
    (r) => (r.path === "/v4/12345/sales_invoices/555"
      ? { json: { data: { id: "555", type: "sales_invoices", relationships: { active_e_document: { data: { id: "9", type: opts.inbox ? "e_invoices" : "e_archives" } } } }, included: opts.uuid === null ? [] : [{ id: "9", type: opts.inbox ? "e_invoices" : "e_archives", attributes: { uuid: (opts.uuid ?? ETTN).toUpperCase() } }] } }
      : undefined),
  ];
}

beforeEach(() => {
  log = [];
  routes = [];
  resetEinvoiceTokenCache();
  Object.assign(einvoiceDeps, { pollIntervalMs: 1, pollTimeoutMs: 200 });
  einvoiceDeps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const r: Req = { method: init?.method ?? "GET", url: String(input), path: u.pathname, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    log.push(r);
    for (const fn of routes) {
      const out = fn(r);
      if (out) return new Response(out.json === undefined ? "" : JSON.stringify(out.json), { status: out.status ?? 200 });
    }
    return new Response(JSON.stringify({ errors: [{ title: "unrouted" }] }), { status: 599 });
  }) as typeof fetch;
});
afterEach(() => Object.assign(einvoiceDeps, real));

describe("Paraşüt adaptörü", () => {
  it("kayıt defterinde, DOĞRULANMADI işaretli, beş erişim alanı ister", () => {
    expect(P).toMatchObject({ verified: false, credentialFields: ["clientId", "clientSecret", "username", "password", "companyId"] });
    expect(P.docsUrl).toBe("https://apidocs.parasut.com/");
  });

  it("e-Fatura: belgedeki sırayla istekler; gövdeler Swagger şemasına uygun; ETTN küçük harfle döner", async () => {
    happy({ inbox: true });
    const out = await P.send(doc(), CREDS, "production");
    expect(out).toEqual({ ettn: ETTN, providerRef: "parasut:555" });
    expect(log.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /oauth/token", "GET /v4/12345/e_invoice_inboxes", "GET /v4/12345/contacts", "POST /v4/12345/contacts",
      "POST /v4/12345/sales_invoices", "POST /v4/12345/e_invoices", "GET /v4/12345/trackable_jobs/job-1", "GET /v4/12345/trackable_jobs/job-1",
      "GET /v4/12345/sales_invoices/555",
    ]);
    expect(Object.fromEntries(new URLSearchParams(log[0]!.body))).toEqual({ grant_type: "password", client_id: "cid", client_secret: "csec", username: "u@firma.test", password: "pw-SECRET", redirect_uri: "urn:ietf:wg:oauth:2.0:oob" });
    expect(new URL(log[1]!.url).searchParams.get("filter[vkn]")).toBe("9876543210");
    expect(log[1]!.headers.get("authorization")).toBe("Bearer tok");
    expect(JSON.parse(log[3]!.body).data).toMatchObject({ type: "contacts", attributes: { name: "Alıcı Ltd.", account_type: "customer", contact_type: "company", tax_number: "9876543210", tax_office: "Çankaya", city: "Ankara" } });
    const si = JSON.parse(log[4]!.body).data;
    expect(si).toMatchObject({
      type: "sales_invoices",
      attributes: { item_type: "invoice", description: "FTR-000042", issue_date: "2026-09-30", currency: "TRL", tax_number: "9876543210" },
      relationships: { contact: { data: { id: "88", type: "contacts" } }, details: { data: [{ type: "sales_invoice_details", attributes: { quantity: 2, unit_price: 100, vat_rate: 20, description: "Kart" } }] } },
    });
    expect(JSON.parse(log[5]!.body).data).toEqual({ type: "e_invoices", attributes: { scenario: "basic", to: "urn:mail:defaultpk@alici.test" }, relationships: { invoice: { data: { id: "555", type: "sales_invoices" } } } });
    expect(new URL(log[8]!.url).searchParams.get("include")).toBe("active_e_document");
  });

  it("e-Arşiv: mevcut müşteri kartı kullanılır, ilişki adı sales_invoice; TCKN kişi olarak açılır", async () => {
    happy({ inbox: false, contactExists: true });
    await P.send(doc({ kind: "e_arsiv" }), CREDS, "sandbox");
    expect(log.some((r) => r.method === "POST" && r.path.endsWith("/contacts"))).toBe(false);
    const ea = JSON.parse(log.find((r) => r.path.endsWith("/e_archives"))!.body).data;
    expect(ea).toEqual({ type: "e_archives", attributes: {}, relationships: { sales_invoice: { data: { id: "555", type: "sales_invoices" } } } });
    happy({ inbox: false });
    log = [];
    await P.send(doc({ kind: "e_arsiv", buyer: { ...doc().buyer, taxNo: "10000000146" } }), CREDS, "sandbox");
    expect(JSON.parse(log.find((r) => r.method === "POST" && r.path.endsWith("/contacts"))!.body).data.attributes.contact_type).toBe("person");
  });

  it("tür uyuşmazlığı, döviz, eksik VKN ve hatalı firma no: hiçbir belge oluşmadan kesin ret (notSent)", async () => {
    const expectNotSent = async (p: Promise<unknown>, msg: RegExp) => {
      const e = await p.catch((x) => x);
      expect(e).toBeInstanceOf(ConnectorError);
      expect((e as ConnectorError).opts.notSent).toBe(true);
      expect((e as Error).message).toMatch(msg);
    };
    happy({ inbox: false });
    await expectNotSent(P.send(doc(), CREDS, "production"), /e-Arşiv olarak/);
    happy({ inbox: true });
    await expectNotSent(P.send(doc({ kind: "e_arsiv" }), CREDS, "production"), /e-Fatura olarak/);
    expect(log.some((r) => r.path.endsWith("/sales_invoices"))).toBe(false);
    log = [];
    await expectNotSent(P.send(doc({ currency: "USD" }), CREDS, "production"), /yalnız TL/);
    await expectNotSent(P.send(doc({ buyer: { ...doc().buyer, taxNo: "" } }), CREDS, "production"), /VKN\/TCKN/);
    await expectNotSent(P.send(doc(), { ...CREDS, companyId: "../x" }, "production"), /firma numarası/);
    expect(log).toHaveLength(0);
  });

  it("oturum reddi kesin ret; hata mesajında parola yok", async () => {
    routes = [() => ({ status: 401, json: { error: "invalid_grant", password: "pw-SECRET" } })];
    const e = await P.send(doc(), CREDS, "production").catch((x) => x);
    expect((e as ConnectorError).opts.notSent).toBe(true);
    expect((e as Error).message).not.toContain("pw-SECRET");
  });

  it("iş takibi 'error' → kesin ret (Paraşüt hata metniyle); zaman aşımı ve UUID yok → belirsiz (düz Error)", async () => {
    happy({ inbox: true, jobStates: ["running", "error"] });
    routes.splice(6, 1, (r) => (r.path.endsWith("/trackable_jobs/job-1") ? { json: { data: { attributes: { status: "error", errors: ["Alıcı etiketi geçersiz"] } } } } : undefined));
    const e1 = await P.send(doc(), CREDS, "production").catch((x) => x);
    expect(e1).toBeInstanceOf(ConnectorError);
    expect((e1 as Error).message).toContain("Alıcı etiketi geçersiz");

    happy({ inbox: true, jobStates: Array(1000).fill("running") });
    const e2 = await P.send(doc(), CREDS, "production").catch((x) => x);
    expect(e2).not.toBeInstanceOf(ConnectorError);
    expect((e2 as Error).message).toMatch(/zamanında bitmedi.*555/);

    happy({ inbox: true, uuid: null });
    const e3 = await P.send(doc(), CREDS, "production").catch((x) => x);
    expect(e3).not.toBeInstanceOf(ConnectorError);
    expect((e3 as Error).message).toMatch(/ETTN okunamadı/);
  });

  it("satış faturası reddi JSON:API hata başlığıyla kesin ret", async () => {
    happy({ inbox: true });
    routes.splice(4, 1, (r) => (r.path.endsWith("/sales_invoices") ? { status: 422, json: { errors: [{ title: "Geçersiz", detail: "issue_date boş olamaz" }] } } : undefined));
    const e = await P.send(doc(), CREDS, "production").catch((x) => x);
    expect((e as ConnectorError).opts.notSent).toBe(true);
    expect((e as Error).message).toBe("Paraşüt satış faturası: Geçersiz: issue_date boş olamaz");
  });
});
