/**
 * UBL-TR 1.2 belge üretimi (dış bağımlılık maddesi 1, sağlayıcıdan bağımsız kısım). Yapısal ve aritmetik denetimler;
 * resmi GİB XSD/Schematron doğrulaması DEĞİLDİR (o, entegratör test ortamında yapılır).
 */
import { describe, expect, it } from "vitest";
import { buildUblTr, deterministicUuid } from "../src/lib/ubl-tr";
import type { EinvoiceDocument } from "../src/lib/einvoice-providers";

const seller = { legalName: "A Elektronik Üretim A.Ş.", taxNo: "1234567890", taxOffice: "Kadıköy", addressLine: "Sanayi Cad. No:1", district: "Kadıköy", city: "İstanbul", postalCode: "34700", country: "TR" };
const base: EinvoiceDocument = {
  kind: "e_fatura", invoiceCode: "MF-000042", invoiceDate: "2026-09-29", currency: "TRY", taxRate: "20.00",
  netAmount: "300.00", taxAmount: "60.00", grossAmount: "360.00",
  seller,
  buyer: { legalName: "B Otomasyon Ltd. Şti.", taxNo: "9876543217", taxOffice: "Çankaya", addressLine: "Liman Yolu 9", district: null, city: "Ankara", postalCode: null, country: "TR" },
  lines: [
    { lineNo: 1, description: "Kontrol kartı <Rev B> & kablo", qty: "2.000000", unitPrice: "100.0000", amount: "200.00" },
    { lineNo: 2, description: "Montaj", qty: "2.500000", unitPrice: "40.0000", amount: "100.00" },
  ],
};

/** Basit iyi-biçimlilik denetimi: açılış/kapanış etiketleri dengeli ve doğru sırada mı. */
function wellFormed(xml: string) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name!);
  }
  return stack.length === 0;
}
const tag = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}(?: [^>]*)?>([^<]*)</${name}>`, "g"))].map((m) => m[1]);

describe("UBL-TR 1.2 belge üretimi", () => {
  it("iyi biçimli; zorunlu başlık alanları UBL sırasıyla; ad alanları doğru", () => {
    const r = buildUblTr(base, { number: "ABC2026000000042" });
    expect(wellFormed(r.xml)).toBe(true);
    expect(r.xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    const order = ["ext:UBLExtensions", "cbc:UBLVersionID", "cbc:CustomizationID", "cbc:ProfileID", "cbc:ID", "cbc:CopyIndicator", "cbc:UUID", "cbc:IssueDate", "cbc:InvoiceTypeCode", "cbc:DocumentCurrencyCode", "cbc:LineCountNumeric", "cac:AccountingSupplierParty", "cac:AccountingCustomerParty", "cac:TaxTotal", "cac:LegalMonetaryTotal", "cac:InvoiceLine"];
    const idx = order.map((t) => r.xml.indexOf(`<${t}`));
    expect(idx.every((v) => v > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(tag(r.xml, "cbc:CustomizationID")).toEqual(["TR1.2"]);
    expect(tag(r.xml, "cbc:ProfileID")).toEqual(["TEMELFATURA"]);
    expect(tag(r.xml, "cbc:ID")[0]).toBe("ABC2026000000042");
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("tutarlar kuruş hassasiyetinde; satır KDV toplamı fatura KDV'sine eşit; miktar sadeleşir", () => {
    const r = buildUblTr(base, { number: "ABC2026000000042" });
    expect(r.xml).toContain('<cbc:PayableAmount currencyID="TRY">360.00</cbc:PayableAmount>');
    expect(r.xml).toContain('<cbc:TaxExclusiveAmount currencyID="TRY">300.00</cbc:TaxExclusiveAmount>');
    expect(tag(r.xml, "cbc:InvoicedQuantity")).toEqual(["2", "2.5"]);
    const lineTaxes = [...r.xml.matchAll(/<cac:InvoiceLine>.*?<cac:TaxTotal><cbc:TaxAmount currencyID="TRY">([\d.]+)</g)].map((m) => Number(m[1]));
    expect(lineTaxes).toEqual([40, 20]);
    expect(tag(r.xml, "cbc:Percent")[0]).toBe("20");
    expect(r.xml).toContain("<cbc:TaxTypeCode>0015</cbc:TaxTypeCode>");
  });

  it("yuvarlama farkı son satıra yazılır (3 × 33,33 → toplam KDV korunur)", () => {
    const doc: EinvoiceDocument = { ...base, netAmount: "99.99", taxAmount: "20.00", grossAmount: "119.99", lines: [1, 2, 3].map((n) => ({ lineNo: n, description: `S${n}`, qty: "1", unitPrice: "33.33", amount: "33.33" })) };
    const r = buildUblTr(doc, { number: "ABC2026000000043" });
    const lineTaxes = [...r.xml.matchAll(/<cac:InvoiceLine>.*?<cac:TaxTotal><cbc:TaxAmount currencyID="TRY">([\d.]+)</g)].map((m) => m[1]);
    expect(lineTaxes).toEqual(["6.67", "6.67", "6.66"]);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("özel karakterler XML kaçışlıdır (enjeksiyon yok)", () => {
    const r = buildUblTr(base, { number: "ABC2026000000042" });
    expect(r.xml).toContain("Kontrol kartı &lt;Rev B&gt; &amp; kablo");
    expect(r.xml).not.toContain("<Rev B>");
  });

  it("VKN'li taraf PartyName, TCKN'li (gerçek kişi) taraf Person ad/soyad ile yazılır", () => {
    const doc = { ...base, kind: "e_arsiv" as const, buyer: { ...base.buyer, legalName: "Ayşe Nur Yılmaz", taxNo: "10000000146", taxOffice: null } };
    const r = buildUblTr(doc, { number: "ABC2026000000044" });
    expect(tag(r.xml, "cbc:ProfileID")).toEqual(["EARSIVFATURA"]);
    expect(r.xml).toContain('<cbc:ID schemeID="VKN">1234567890</cbc:ID>');
    expect(r.xml).toContain('<cbc:ID schemeID="TCKN">10000000146</cbc:ID>');
    expect(r.xml).toContain("<cac:Person><cbc:FirstName>Ayşe Nur</cbc:FirstName><cbc:FamilyName>Yılmaz</cbc:FamilyName></cac:Person>");
    expect(wellFormed(r.xml)).toBe(true);
  });

  it("denetimler: numara biçimi, döviz kuru, KDV istisnası, profil uyumu, tutar tutarsızlığı", () => {
    const codes = (o: Parameters<typeof buildUblTr>[1], d: EinvoiceDocument = base) => buildUblTr(d, o).issues.map((i) => `${i.severity}:${i.field}`);
    expect(codes({})).toContain("warning:number");
    expect(codes({ number: "MF-42" })).toContain("error:number");
    expect(codes({ number: "ABC2026000000042" }, { ...base, currency: "USD" })).toContain("error:exchangeRate");
    const usd = buildUblTr({ ...base, currency: "USD" }, { number: "ABC2026000000042", exchangeRate: "41.25" });
    expect(usd.xml).toContain("<cbc:CalculationRate>41.25</cbc:CalculationRate>");
    expect(usd.issues.filter((i) => i.severity === "error")).toEqual([]);
    const zero: EinvoiceDocument = { ...base, taxRate: "0", taxAmount: "0.00", grossAmount: "300.00" };
    expect(codes({ number: "ABC2026000000042" }, zero)).toContain("error:taxExemption");
    const ex = buildUblTr(zero, { number: "ABC2026000000042", taxExemption: { code: "301", reason: "11/1-a Mal ihracatı" } });
    expect(ex.xml).toContain("<cbc:TaxExemptionReasonCode>301</cbc:TaxExemptionReasonCode>");
    expect(codes({ number: "ABC2026000000042", profile: "EARSIVFATURA" })).toContain("error:profile");
    expect(codes({ number: "ABC2026000000042" }, { ...base, netAmount: "299.00" })).toEqual(expect.arrayContaining(["error:lines", "error:totals"]));
  });

  it("ETTN verilmezse fatura koduna göre deterministik ve UUID v4 biçiminde", () => {
    const u = deterministicUuid("MF-000042");
    expect(u).toBe(deterministicUuid("MF-000042"));
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(buildUblTr(base).uuid).toBe(u);
  });
});
