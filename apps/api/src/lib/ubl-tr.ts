import { createHash } from "node:crypto";
import { fromMicro, toMicro } from "./decimal";
import type { EinvoiceDocument, EinvoiceParty } from "./einvoice-providers";

/**
 * UBL-TR 1.2 fatura belgesi (GİB e-Fatura / e-Arşiv). Özel entegratörlerin çoğu faturayı bu XML biçiminde alır;
 * sağlayıcıdan bağımsız üretilir, entegratör adaptörü yalnız iletir. Mali mühür/e-imza (UBLExtensions içeriği)
 * ENTEGRATÖR tarafından eklenir — burada boş yer tutucu bırakılır.
 *
 * Doğrulama sınırı (dürüst): burada yapısal ve aritmetik denetimler yapılır (zorunlu alanlar, tutar tutarlılığı,
 * numara biçimi, döviz kuru, KDV istisnası). GİB'in resmi XSD + Schematron doğrulaması çevrimdışı çalıştırılmadı;
 * belge ilk kez entegratörün test ortamında resmi doğrulamadan geçecek.
 */

export type UblProfile = "TEMELFATURA" | "TICARIFATURA" | "EARSIVFATURA";
export type UblIssue = { field: string; message: string; severity: "error" | "warning" };

export type UblOptions = {
  /** GİB fatura numarası: 3 karakter seri + 4 hane yıl + 9 hane sıra (ör. ABC2026000000001). Yoksa entegratör atar. */
  number?: string | null;
  /** ETTN (UUID). Verilmezse fatura koduna göre deterministik üretilir. */
  uuid?: string;
  profile?: UblProfile;
  /** TRY dışı para biriminde zorunlu: 1 birim döviz = kaç TRY. */
  exchangeRate?: string | null;
  /** KDV oranı 0 ise zorunlu: GİB istisna kodu (ör. 301 — mal ihracatı) ve açıklaması. */
  taxExemption?: { code: string; reason: string } | null;
  issueTime?: string;
};

const NS = {
  inv: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  ext: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
};
export const GIB_NUMBER = /^[A-Z0-9]{3}20\d{2}\d{9}$/;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** 6 ondalıklı mikro birimi 2 ondalığa yarım-yukarı yuvarlar (kuruş). */
function cents(micro: bigint): bigint {
  const neg = micro < 0n;
  const a = neg ? -micro : micro;
  const c = (a + 5_000n) / 10_000n;
  return neg ? -c : c;
}
const fmt2 = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
};
const toCents = (v: string) => cents(toMicro(v));
/** amountCents × rate% → kuruş (yarım-yukarı). */
const taxOf = (amountCents: bigint, rate: string) => {
  const r = toMicro(rate); // oran × 1e6
  const num = amountCents * r; // kuruş × oran × 1e6
  const den = 100n * 1_000_000n;
  return (num * 2n + den) / (2n * den);
};

/** Fatura kodundan deterministik ETTN (UUID v4 biçiminde) — aynı fatura için aynı önizleme. */
export function deterministicUuid(seed: string) {
  const h = createHash("sha256").update(`apisfactory-ettn:${seed}`).digest("hex");
  const v = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function party(tag: "AccountingSupplierParty" | "AccountingCustomerParty", p: EinvoiceParty, issues: UblIssue[], who: string) {
  const isTckn = p.taxNo.length === 11;
  if (!p.taxNo) issues.push({ field: `${who}.taxNo`, message: `${who === "seller" ? "Satıcı" : "Alıcı"} VKN/TCKN yok`, severity: "error" });
  const person = (() => {
    if (!isTckn) return "";
    const parts = p.legalName.trim().split(/\s+/);
    if (parts.length < 2) issues.push({ field: `${who}.person`, message: "TCKN'li (gerçek kişi) tarafta ad ve soyad ayrı olmalı — resmi unvan tek kelime", severity: "error" });
    const family = parts.length > 1 ? parts.pop()! : parts[0] ?? "";
    return `<cac:Person><cbc:FirstName>${esc(parts.join(" ") || family)}</cbc:FirstName><cbc:FamilyName>${esc(family)}</cbc:FamilyName></cac:Person>`;
  })();
  return `<cac:${tag}><cac:Party>`
    + `<cac:PartyIdentification><cbc:ID schemeID="${isTckn ? "TCKN" : "VKN"}">${esc(p.taxNo)}</cbc:ID></cac:PartyIdentification>`
    + (isTckn ? "" : `<cac:PartyName><cbc:Name>${esc(p.legalName)}</cbc:Name></cac:PartyName>`)
    + `<cac:PostalAddress><cbc:StreetName>${esc(p.addressLine)}</cbc:StreetName>`
    + `<cbc:CitySubdivisionName>${esc(p.district ?? p.city)}</cbc:CitySubdivisionName><cbc:CityName>${esc(p.city)}</cbc:CityName>`
    + (p.postalCode ? `<cbc:PostalZone>${esc(p.postalCode)}</cbc:PostalZone>` : "")
    + `<cac:Country><cbc:Name>${p.country === "TR" ? "Türkiye" : esc(p.country)}</cbc:Name></cac:Country></cac:PostalAddress>`
    + (p.taxOffice ? `<cac:PartyTaxScheme><cac:TaxScheme><cbc:Name>${esc(p.taxOffice)}</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme>` : "")
    + person
    + `</cac:Party></cac:${tag}>`;
}

export function buildUblTr(doc: EinvoiceDocument, opts: UblOptions = {}): { xml: string; issues: UblIssue[]; uuid: string; profile: UblProfile } {
  const issues: UblIssue[] = [];
  const profile: UblProfile = opts.profile ?? (doc.kind === "e_arsiv" ? "EARSIVFATURA" : "TEMELFATURA");
  if (doc.kind === "e_arsiv" && profile !== "EARSIVFATURA") issues.push({ field: "profile", message: "e-Arşiv faturanın profili EARSIVFATURA olmalı", severity: "error" });
  if (doc.kind === "e_fatura" && profile === "EARSIVFATURA") issues.push({ field: "profile", message: "e-Fatura için TEMELFATURA veya TICARIFATURA seçilmeli", severity: "error" });
  const uuid = opts.uuid ?? deterministicUuid(doc.invoiceCode);
  const number = opts.number ?? null;
  if (!number) issues.push({ field: "number", message: "GİB fatura numarası verilmedi — entegratör atamalı (bu belgede iç kod geçici ID olarak kullanıldı)", severity: "warning" });
  else if (!GIB_NUMBER.test(number)) issues.push({ field: "number", message: "GİB fatura numarası biçimi: 3 karakter seri + 4 hane yıl + 9 hane sıra (ör. ABC2026000000001)", severity: "error" });
  if (!doc.invoiceDate) issues.push({ field: "invoiceDate", message: "Fatura tarihi yok", severity: "error" });
  if (doc.currency !== "TRY" && !opts.exchangeRate) issues.push({ field: "exchangeRate", message: `${doc.currency} faturada TRY döviz kuru zorunlu`, severity: "error" });
  const rateZero = toMicro(doc.taxRate) === 0n;
  if (rateZero && !opts.taxExemption) issues.push({ field: "taxExemption", message: "KDV %0 faturada GİB istisna kodu ve açıklaması zorunlu", severity: "error" });

  // ---- tutarlar (kuruş) ve tutarlılık ----
  const net = toCents(doc.netAmount);
  const tax = toCents(doc.taxAmount);
  const gross = toCents(doc.grossAmount);
  const lineAmounts = doc.lines.map((l) => toCents(l.amount));
  const lineSum = lineAmounts.reduce((a, b) => a + b, 0n);
  if (lineSum !== net) issues.push({ field: "lines", message: `Satır toplamı (${fmt2(lineSum)}) net tutarla (${fmt2(net)}) eşleşmiyor`, severity: "error" });
  if (net + tax !== gross) issues.push({ field: "totals", message: "Net + KDV ≠ genel toplam", severity: "error" });
  // Fatura KDV'si receivables.ts'te kayan noktayla yuvarlanıyor; x,xx5 sınırında 1 kuruş sapabilir → uyarı.
  if (taxOf(net, doc.taxRate) !== tax) issues.push({ field: "taxAmount", message: `KDV tutarı (${fmt2(tax)}) oranla kesin hesaplanandan (${fmt2(taxOf(net, doc.taxRate))}) farklı — GİB doğrulamasında reddedilebilir`, severity: "warning" });
  // Satır KDV'leri: her satır kendi oranıyla; yuvarlama farkı son satıra yazılır ki toplam fatura KDV'sine eşit olsun.
  const lineTaxes = lineAmounts.map((a) => taxOf(a, doc.taxRate));
  if (lineTaxes.length) lineTaxes[lineTaxes.length - 1]! += tax - lineTaxes.reduce((a, b) => a + b, 0n);

  const cur = esc(doc.currency);
  const money = (c: bigint) => `currencyID="${cur}">${fmt2(c)}`;
  const taxCategory = `<cac:TaxCategory>${rateZero && opts.taxExemption ? `<cbc:TaxExemptionReasonCode>${esc(opts.taxExemption.code)}</cbc:TaxExemptionReasonCode><cbc:TaxExemptionReason>${esc(opts.taxExemption.reason)}</cbc:TaxExemptionReason>` : ""}<cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>`;
  const pct = (() => {
    const r = toMicro(doc.taxRate);
    return `${r / 1_000_000n}${r % 1_000_000n ? `.${(r % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")}` : ""}`;
  })();
  const subtotal = (base: bigint, t: bigint, seq?: number) =>
    `<cac:TaxSubtotal><cbc:TaxableAmount ${money(base)}</cbc:TaxableAmount><cbc:TaxAmount ${money(t)}</cbc:TaxAmount>${seq ? `<cbc:CalculationSequenceNumeric>${seq}</cbc:CalculationSequenceNumeric>` : ""}<cbc:Percent>${pct}</cbc:Percent>${taxCategory}</cac:TaxSubtotal>`;

  const lines = doc.lines.map((l, i) => {
    const qty = fromMicro(toMicro(l.qty)); // "2.500000" → "2.5", "2.000000" → "2"
    return `<cac:InvoiceLine><cbc:ID>${l.lineNo}</cbc:ID><cbc:InvoicedQuantity unitCode="C62">${esc(qty)}</cbc:InvoicedQuantity>`
      + `<cbc:LineExtensionAmount ${money(lineAmounts[i]!)}</cbc:LineExtensionAmount>`
      + `<cac:TaxTotal><cbc:TaxAmount ${money(lineTaxes[i]!)}</cbc:TaxAmount>${subtotal(lineAmounts[i]!, lineTaxes[i]!, 1)}</cac:TaxTotal>`
      + `<cac:Item><cbc:Name>${esc(l.description)}</cbc:Name></cac:Item>`
      + `<cac:Price><cbc:PriceAmount currencyID="${cur}">${esc(l.unitPrice)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<Invoice xmlns="${NS.inv}" xmlns:cac="${NS.cac}" xmlns:cbc="${NS.cbc}" xmlns:ext="${NS.ext}">`
    + `<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>`
    + `<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>TR1.2</cbc:CustomizationID><cbc:ProfileID>${profile}</cbc:ProfileID>`
    + `<cbc:ID>${esc(number ?? doc.invoiceCode)}</cbc:ID><cbc:CopyIndicator>false</cbc:CopyIndicator><cbc:UUID>${uuid}</cbc:UUID>`
    + `<cbc:IssueDate>${esc(doc.invoiceDate ?? "")}</cbc:IssueDate>${opts.issueTime ? `<cbc:IssueTime>${esc(opts.issueTime)}</cbc:IssueTime>` : ""}`
    + `<cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode><cbc:Note>${esc(`İç belge no: ${doc.invoiceCode}`)}</cbc:Note>`
    + `<cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode><cbc:LineCountNumeric>${doc.lines.length}</cbc:LineCountNumeric>`
    + party("AccountingSupplierParty", doc.seller, issues, "seller")
    + party("AccountingCustomerParty", doc.buyer, issues, "buyer")
    + (doc.currency !== "TRY" && opts.exchangeRate
      ? `<cac:PricingExchangeRate><cbc:SourceCurrencyCode>${cur}</cbc:SourceCurrencyCode><cbc:TargetCurrencyCode>TRY</cbc:TargetCurrencyCode><cbc:CalculationRate>${esc(opts.exchangeRate)}</cbc:CalculationRate></cac:PricingExchangeRate>`
      : "")
    + `<cac:TaxTotal><cbc:TaxAmount ${money(tax)}</cbc:TaxAmount>${subtotal(net, tax)}</cac:TaxTotal>`
    + `<cac:LegalMonetaryTotal><cbc:LineExtensionAmount ${money(lineSum)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount ${money(net)}</cbc:TaxExclusiveAmount>`
    + `<cbc:TaxInclusiveAmount ${money(gross)}</cbc:TaxInclusiveAmount><cbc:AllowanceTotalAmount ${money(0n)}</cbc:AllowanceTotalAmount><cbc:PayableAmount ${money(gross)}</cbc:PayableAmount></cac:LegalMonetaryTotal>`
    + lines.join("")
    + `</Invoice>\n`;
  return { xml, issues, uuid, profile };
}
