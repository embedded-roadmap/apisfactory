/**
 * Oturum 41 — dış bağımlılık maddesi 1 (e-fatura) için sağlayıcıdan BAĞIMSIZ hazırlık:
 * vergi kimliği (VKN/TCKN kontrol hanesi), şifreli bağlayıcı erişim bilgisi, hazırlık denetimi ve canlı mod kapısı.
 * Canlı gönderim akışı yalnız bu testte kayıt defterine eklenen SAHTE bir adaptörle sınanır — gerçek bir entegratöre
 * karşı doğrulama değildir.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, clearTokens, expectOk, login, setupWorld, type World } from "./helpers";
import { closePool } from "../src/db/pool";
import { isValidTaxNo, isValidTckn, isValidVkn } from "../src/lib/tax-id";
import { decryptSecret, encryptSecret } from "../src/lib/secrets";
import { EINVOICE_PROVIDERS, type EinvoiceDocument } from "../src/lib/einvoice-providers";
import { ConnectorError } from "../src/lib/connector-credentials";
import { processEinvoiceSend } from "../src/modules/dispatch";

let w: World;
let A: string;
let invoiceId: string;
let customerId: string;
const mapping = { refdes: "Designator", manufacturer: "Manufacturer", mpn: "MPN", qty: "Quantity", description: "Description", dnp: "DNP" };
const stockMapping = { itemCode: "kod", qty: "miktar", lotNo: "lot", locationCode: "konum", rev: "rev" };
const W = "warehouse@a.test";
const S = "sales@a.test";
const M = "accounting@a.test";
const MGR = "manager@a.test";
const VKN = "1234567890";
const TCKN = "10000000146";
const SECRET = "cok-gizli-parola-XYZ";

async function einvoiceConnector(key: string) {
  return expectOk(await call(w.app, MGR, A, "GET", "/api/einvoice-connectors")).find((c: any) => c.key === key);
}

beforeAll(async () => {
  clearTokens();
  w = await setupWorld();
  A = w.a.companyId;
  const productId = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/products", { code: "EF-1", name: "E-fatura kartı" })).id;
  const prev = expectOk(await call(w.app, "rd@a.test", A, "POST", "/api/imports/bom/preview", { productId, fileName: "ef.csv", content: "Designator;Manufacturer;MPN;Quantity;Description;DNP\nU1;TestSemi;MCU-E;1;MCU;", mapping }));
  const bom = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/imports/${prev.jobId}/commit`, {})).bomVersionId;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/boms/${bom}/publish`));
  const rev = expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/products/${productId}/revisions`, { rev: "A", bomVersionId: bom })).id;
  expectOk(await call(w.app, "rd@a.test", A, "POST", `/api/revisions/${rev}/transition`, { action: "submit_handover" }));
  for (const area of ["rd", "production", "quality"]) expectOk(await call(w.app, `${area}@a.test`, A, "POST", `/api/revisions/${rev}/handover`, { area, decision: "approve" }));
  customerId = expectOk(await call(w.app, S, A, "POST", "/api/customers", { code: "M-EF", name: "EF Müşterisi" })).id;
  await call(w.app, S, A, "POST", `/api/customers/${customerId}/addresses`, { label: "Merkez", recipient: "Alıcı", line1: "Deneme Cad. No:5", city: "Ankara", isDefault: true });
  const sp = expectOk(await call(w.app, W, A, "POST", "/api/imports/stock/preview", { fileName: "s.csv", content: "kod,miktar,lot,konum,rev\nEF-1,5,EF-LOT,BTM,A", mapping: stockMapping }));
  expectOk(await call(w.app, W, A, "POST", `/api/imports/${sp.jobId}/commit`, {}));
  const o = expectOk(await call(w.app, S, A, "POST", "/api/sales-orders", { customerId, requestedDate: "2026-12-01", lines: [{ productRevisionId: rev, qty: "2", unitPrice: "100", currency: "TRY" }] }));
  expectOk(await call(w.app, S, A, "POST", `/api/sales-orders/${o.id}/confirm`));
  const sh = expectOk(await call(w.app, W, A, "POST", `/api/sales-orders/${o.id}/shipments`, { lines: [{ lineId: o.lines[0].id, qty: "2" }] }));
  const pkg = expectOk(await call(w.app, W, A, "GET", `/api/shipments/${sh.id}`)).packages[0].id;
  expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg}/items`, { code: "EF-LOT", qty: "2" }));
  expectOk(await call(w.app, W, A, "POST", `/api/packages/${pkg}/close`, { checklist: { box: true, accessories: true, label: true, inspection: true } }));
  expectOk(await call(w.app, W, A, "POST", `/api/shipments/${sh.id}/pack-complete`));
  expectOk(await call(w.app, W, A, "POST", `/api/shipments/${sh.id}/ship`, { carrier: "Elden" }));
  invoiceId = expectOk(await call(w.app, M, A, "POST", "/api/customer-invoices/from-shipment", { shipmentId: sh.id })).id;
  expectOk(await call(w.app, M, A, "POST", `/api/customer-invoices/${invoiceId}/issue`, {}));
});

afterAll(async () => {
  delete EINVOICE_PROVIDERS.parasut;
  await w.app.close();
  await w.owner.end();
  await closePool();
});

describe("Vergi kimliği doğrulama (birim)", () => {
  it("VKN ve TCKN kontrol hanesini doğrular, tek hane değişikliğini yakalar", () => {
    expect(isValidVkn(VKN)).toBe(true);
    expect(isValidVkn("1234567891")).toBe(false);
    expect(isValidTckn(TCKN)).toBe(true);
    expect(isValidTckn("10000000147")).toBe(false);
    expect(isValidTckn("00000000146")).toBe(false); // ilk hane 0 olamaz
    expect(isValidTaxNo(VKN)).toBe(true);
    expect(isValidTaxNo(TCKN)).toBe(true);
    expect(isValidTaxNo("123")).toBe(false);
    for (let i = 0; i < 10; i++) {
      const bumped = VKN.slice(0, i) + ((Number(VKN[i]) + 1) % 10) + VKN.slice(i + 1);
      expect(isValidVkn(bumped)).toBe(false);
    }
  });

  it("erişim bilgisi şifrelemesi: gidiş-dönüş çalışır, düz metin görünmez, bozulmuş veri reddedilir", () => {
    const enc = encryptSecret({ username: "u", password: SECRET });
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain(SECRET);
    expect(decryptSecret(enc)).toEqual({ username: "u", password: SECRET });
    expect(encryptSecret({ a: 1 })).not.toBe(encryptSecret({ a: 1 })); // rastgele IV
    const raw = Buffer.from(enc.slice(3), "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(`v1:${raw.toString("base64")}`)).toThrow();
  });
});

describe("Şirket ve müşteri vergi kimliği", () => {
  it("hazırlık denetimi eksik vergi kimliği ve adresi listeler", async () => {
    const r = expectOk(await call(w.app, M, A, "GET", `/api/customer-invoices/${invoiceId}/einvoice-readiness?kind=e_fatura`));
    expect(r.ready).toBe(false);
    const fields = r.issues.map((i: any) => i.field);
    expect(fields).toEqual(expect.arrayContaining(["company.legalName", "company.taxNo", "company.taxOffice", "company.address", "customer.taxNo", "customer.legalName"]));
    expect(fields).not.toContain("customer.address"); // varsayılan adres var
    const arsiv = expectOk(await call(w.app, M, A, "GET", `/api/customer-invoices/${invoiceId}/einvoice-readiness?kind=e_arsiv`));
    expect(arsiv.issues.map((i: any) => i.field)).not.toContain("customer.taxNo");
  });

  it("şirket profili: geçersiz VKN reddedilir, yetkisiz değiştiremez, yönetici kaydeder", async () => {
    const profile = { legalName: "Şirket A Elektronik A.Ş.", taxNo: VKN, taxOffice: "Kadıköy", addressLine: "Sanayi Cad. No:1", city: "İstanbul", postalCode: "34700" };
    const bad = await call(w.app, MGR, A, "POST", "/api/company/tax-profile", { ...profile, taxNo: "1234567891" });
    expect(bad.status).toBe(400);
    const denied = await call(w.app, W, A, "POST", "/api/company/tax-profile", profile);
    expect(denied.status).toBe(403);
    expect(expectOk(await call(w.app, MGR, A, "POST", "/api/company/tax-profile", profile))).toMatchObject({ taxNo: VKN, taxOffice: "Kadıköy", country: "TR" });
    expect(expectOk(await call(w.app, M, A, "GET", "/api/company/tax-profile"))).toMatchObject({ legalName: profile.legalName, postalCode: "34700" });
  });

  it("müşteri vergi kimliği TCKN ile kaydedilir; hazırlık tamamlanır", async () => {
    expect((await call(w.app, M, A, "POST", `/api/customers/${customerId}/tax-identity`, { legalName: "X", taxNo: "10000000147" })).status).toBe(400);
    expectOk(await call(w.app, M, A, "POST", `/api/customers/${customerId}/tax-identity`, { legalName: "EF Müşterisi Ltd.", taxNo: TCKN, taxOffice: "Çankaya" }));
    expect(expectOk(await call(w.app, M, A, "GET", `/api/customers/${customerId}/tax-identity`))).toMatchObject({ taxNo: TCKN, taxOffice: "Çankaya" });
    const r = expectOk(await call(w.app, M, A, "GET", `/api/customer-invoices/${invoiceId}/einvoice-readiness`));
    expect(r).toMatchObject({ ready: true, issues: [] });
  });

  it("UBL-TR önizlemesi: gerçek faturadan satıcı/alıcı kimliği ve tutarlarla belge üretilir; numara yoksa uyarı", async () => {
    const u = expectOk(await call(w.app, M, A, "GET", `/api/customer-invoices/${invoiceId}/ubl?kind=e_fatura`));
    expect(u).toMatchObject({ profile: "TEMELFATURA", valid: true });
    expect(u.issues.map((i: any) => `${i.severity}:${i.field}`)).toContain("warning:number");
    expect(u.xml).toContain(`<cbc:ID schemeID="VKN">${VKN}</cbc:ID>`);
    expect(u.xml).toContain(`<cbc:ID schemeID="TCKN">${TCKN}</cbc:ID>`);
    expect(u.xml).toContain("<cbc:FamilyName>Ltd.</cbc:FamilyName>"); // TCKN'li alıcı: son kelime soyad sayılır
    expect(u.xml).toMatch(/<cbc:PayableAmount currencyID="TRY">\d+\.\d{2}<\/cbc:PayableAmount>/);
    const bad = await call(w.app, M, A, "GET", `/api/customer-invoices/${invoiceId}/ubl?kind=e_fatura&number=MF-1`);
    expect(expectOk(bad).valid).toBe(false);
    expect((await call(w.app, "all@b.test", w.b.companyId, "GET", `/api/customer-invoices/${invoiceId}/ubl`)).status).toBe(404);
  });

  it("RLS: başka şirket müşteri vergi kimliğini göremez", async () => {
    expect((await call(w.app, "all@b.test", w.b.companyId, "GET", `/api/customers/${customerId}/tax-identity`)).status).toBe(404);
  });
});

describe("Canlı mod kapısı ve şifreli erişim bilgisi", () => {
  it("adaptörü olmayan sağlayıcı canlı moda alınamaz", async () => {
    const c = await einvoiceConnector("uyumsoft");
    expect(c).toMatchObject({ adapterAvailable: false, hasCredentials: false, environment: null });
    const r = await call(w.app, M, A, "POST", `/api/einvoice-connectors/${c.id}`, { mode: "live", reason: "Canlıya geçiş denemesi" });
    expect(r.body.error.code).toBe("adapter_not_available");
  });

  it("erişim bilgisi şifreli saklanır; hiçbir yanıtta, olay kaydında veya DB'de düz metin yok", async () => {
    const c = await einvoiceConnector("uyumsoft");
    const saved = expectOk(await call(w.app, M, A, "POST", `/api/einvoice-connectors/${c.id}/credentials`, { environment: "sandbox", credentials: { username: "ef-user", password: SECRET }, reason: "Test ortamı hesabı" }));
    expect(saved).toEqual({ id: c.id, environment: "sandbox", hasCredentials: true, fields: ["password", "username"] });
    const listed = await einvoiceConnector("uyumsoft");
    expect(listed).toMatchObject({ hasCredentials: true, environment: "sandbox" });
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(listed).not.toHaveProperty("credentials_enc");
    const hist = expectOk(await call(w.app, MGR, A, "GET", `/api/history/einvoice_connector/${c.id}`));
    expect(JSON.stringify(hist)).not.toContain(SECRET);
    await w.owner.query("begin");
    await w.owner.query(`select set_config('app.company_id', $1, true)`, [A]);
    const row = (await w.owner.query(`select credentials_enc from einvoice_connectors where id = $1`, [c.id])).rows[0];
    await w.owner.query("rollback");
    expect(row.credentials_enc).toMatch(/^v1:/);
    expect(row.credentials_enc).not.toContain(SECRET);
    const denied = await call(w.app, W, A, "POST", `/api/einvoice-connectors/${c.id}/credentials`, { environment: "sandbox", credentials: { k: "v" }, reason: "yetkisiz" });
    expect(denied.status).toBe(403);
  });

  it("şema: erişim bilgisi olmadan canlı mod veri tabanında da engellenir", async () => {
    const c = await einvoiceConnector("foriba");
    await w.owner.query("begin");
    try {
      await w.owner.query(`select set_config('app.company_id', $1, true)`, [A]);
      await expect(w.owner.query(`update einvoice_connectors set mode = 'live' where id = $1`, [c.id])).rejects.toThrow(/einvoice_connectors_live_ready/);
    } finally {
      await w.owner.query("rollback");
    }
  });

  it("canlı gönderim (SAHTE test adaptörü) arka planda: kuyruk → ret → belirsiz → elle çözüm → gönderildi; otomatik tekrar yok", async () => {
    const received: { doc?: EinvoiceDocument; creds?: Record<string, string>; env?: string; calls: number } = { calls: 0 };
    let behavior: "reject" | "timeout" | "ok" = "reject";
    EINVOICE_PROVIDERS.parasut = {
      credentialFields: ["client_id", "client_secret"],
      async send(doc, creds, env) {
        received.calls++;
        Object.assign(received, { doc, creds, env });
        if (behavior === "reject") throw new ConnectorError("Alıcı e-fatura mükellefi değil", { notSent: true });
        if (behavior === "timeout") throw new Error("socket hang up");
        return { ettn: "11111111-2222-3333-4444-555555555555", providerRef: "FAKE-1" };
      },
    };
    const c = await einvoiceConnector("parasut");
    expect(c).toMatchObject({ adapterAvailable: true, credentialFields: ["client_id", "client_secret"] });
    const noCreds = await call(w.app, M, A, "POST", `/api/einvoice-connectors/${c.id}`, { mode: "live", reason: "Canlı" });
    expect(noCreds.body.error.code).toBe("credentials_missing");
    const missingField = await call(w.app, M, A, "POST", `/api/einvoice-connectors/${c.id}/credentials`, { environment: "sandbox", credentials: { client_id: "id" }, reason: "Eksik alan" });
    expect(missingField.status).toBe(400);
    expectOk(await call(w.app, M, A, "POST", `/api/einvoice-connectors/${c.id}/credentials`, { environment: "sandbox", credentials: { client_id: "id", client_secret: SECRET }, reason: "Sandbox" }));
    expectOk(await call(w.app, M, A, "POST", `/api/einvoice-connectors/${c.id}`, { mode: "live", reason: "Sandbox doğrulaması" }));

    const send = () => call(w.app, M, A, "POST", `/api/customer-invoices/${invoiceId}/send-einvoice`, { connectorId: c.id, kind: "e_fatura" });
    const status = async () => (await w.owner.query(`select einvoice_status as s, einvoice_error as e from customer_invoices where id = $1`, [invoiceId])).rows[0];
    const ownerCtx = async <T>(fn: () => Promise<T>) => {
      await w.owner.query(`select set_config('app.company_id', $1, false)`, [A]);
      return fn();
    };

    // 1) istek hızlı döner: dış çağrı yapılmaz, kuyruk işi bırakılır; ikinci istek "sürüyor" ile reddedilir
    expect(expectOk(await send())).toMatchObject({ einvoiceStatus: "queued", testData: false });
    expect(received.calls).toBe(0);
    expect((await send()).body.error.code).toBe("send_in_progress");
    const jobs = await ownerCtx(async () => (await w.owner.query(`select count(*)::int as n from outbox where topic = 'einvoice.send' and payload->>'invoiceId' = $1`, [invoiceId])).rows[0].n);
    expect(jobs).toBe(1);

    // 2) sağlayıcı kesin reddetti → failed (hiçbir şey oluşmadı), yeniden gönderilebilir
    expect(await processEinvoiceSend(A, invoiceId)).toMatchObject({ status: "failed" });
    expect(await ownerCtx(status)).toMatchObject({ s: "failed", e: "Alıcı e-fatura mükellefi değil" });

    // 3) zaman aşımı → unknown; otomatik/elle yeniden gönderim engellenir; işlem tekrar çağrılsa da sağlayıcıya gitmez
    behavior = "timeout";
    expectOk(await send());
    expect(await processEinvoiceSend(A, invoiceId)).toMatchObject({ status: "unknown" });
    expect(await processEinvoiceSend(A, invoiceId)).toMatchObject({ status: "skipped" });
    expect(received.calls).toBe(2);
    expect((await send()).body.error.code).toBe("send_outcome_unknown");

    // 4) kullanıcı sağlayıcı panelinden doğruladı: gönderilmemiş → yeniden gönderilebilir
    expect((await call(w.app, M, A, "POST", `/api/customer-invoices/${invoiceId}/einvoice-resolve`, { outcome: "not_sent", reason: "Panelde belge yok" })).status).toBe(200);
    behavior = "ok";
    expectOk(await send());
    expect(await processEinvoiceSend(A, invoiceId)).toEqual({ status: "sent" });
    const full = expectOk(await call(w.app, M, A, "GET", `/api/customer-invoices/${invoiceId}`));
    expect(full).toMatchObject({ documentMode: "live", einvoiceEttn: "11111111-2222-3333-4444-555555555555" });
    expect(await ownerCtx(status)).toMatchObject({ s: "sent", e: null });
    expect(received.doc?.ettn).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/); // sağlayıcıya sabit ETTN gider
    const hist = JSON.stringify(expectOk(await call(w.app, M, A, "GET", `/api/history/customer_invoice/${invoiceId}`)));
    for (const ev of ["einvoice.queued", "einvoice.failed", "einvoice.outcome_unknown", "einvoice.resolved", "einvoice.sent"]) expect(hist).toContain(ev);
    expect(received.creds).toEqual({ client_id: "id", client_secret: SECRET });
    expect(received.env).toBe("sandbox");
    expect(received.doc).toMatchObject({
      kind: "e_fatura", grossAmount: expect.any(String),
      seller: { taxNo: VKN, taxOffice: "Kadıköy", city: "İstanbul" },
      buyer: { taxNo: TCKN, legalName: "EF Müşterisi Ltd.", city: "Ankara" },
    });
    expect(received.doc?.lines.length).toBe(1);
    const again = await call(w.app, M, A, "POST", `/api/customer-invoices/${invoiceId}/send-einvoice`, { connectorId: c.id, kind: "e_fatura" });
    expect(again.body.error.code).toBe("already_sent");
  });

  it("şirket çıkış paketi şifreli erişim bilgisini içermez", async () => {
    const token = await login(w.app, "admin@a.test");
    const r = await w.app.inject({ method: "GET", url: "/api/company/export", headers: { authorization: `Bearer ${token}`, "x-company-id": A } });
    expect(r.statusCode).toBe(200);
    const dir = mkdtempSync(path.join(tmpdir(), "apisfactory-einv-"));
    const zipPath = path.join(dir, "export.zip");
    writeFileSync(zipPath, r.rawPayload);
    const rows = JSON.parse(execFileSync("unzip", ["-p", zipPath, "veri/einvoice_connectors.json"], { encoding: "utf-8" }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).not.toHaveProperty("credentials_enc");
    expect(rows.some((x: any) => x.environment === "sandbox")).toBe(true);
    expect(execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf-8" })).toMatch(/_enc/);
  });
});
