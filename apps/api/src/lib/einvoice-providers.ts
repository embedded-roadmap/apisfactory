import type { Db } from "../db/pool";

/**
 * E-fatura/e-arşiv sağlayıcı adaptörleri. Her entegratörün API'si farklıdır (REST/SOAP, UBL-TR XML veya JSON),
 * bu yüzden gerçek gönderim sağlayıcı başına bir adaptörle yapılır. Kayıt defteri BİLEREK boştur: bir sağlayıcının
 * adaptörü, o sağlayıcının kendi test ortamına karşı doğrulanmadan buraya eklenmez; adaptörü olmayan bağlayıcı
 * 'live' moda alınamaz (sahte "bağlandı" durumu üretilmez).
 */

export type EinvoiceEnvironment = "sandbox" | "production";

export type EinvoiceParty = {
  legalName: string;
  taxNo: string;
  taxOffice: string | null;
  addressLine: string;
  district: string | null;
  city: string;
  postalCode: string | null;
  country: string;
};

export type EinvoiceDocument = {
  kind: "e_fatura" | "e_arsiv";
  invoiceCode: string;
  invoiceDate: string;
  currency: string;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  seller: EinvoiceParty;
  buyer: EinvoiceParty;
  lines: { lineNo: number; description: string; qty: string; unitPrice: string; amount: string }[];
  /** ETTN (UUID) — gönderimde sabit tutulur; aynı belge ikinci kez ulaşırsa sağlayıcı mükerrer olarak reddedebilir. */
  ettn?: string;
};

export interface EinvoiceProvider {
  /** Sağlayıcının istediği erişim bilgisi alanları (ör. kullanıcı adı, parola) — arayüz formu ve doğrulama için. */
  credentialFields: string[];
  send(doc: EinvoiceDocument, credentials: Record<string, string>, environment: EinvoiceEnvironment): Promise<{ ettn: string; providerRef?: string }>;
}

export const EINVOICE_PROVIDERS: Partial<Record<string, EinvoiceProvider>> = {};

export type ReadinessIssue = { field: string; message: string };

/**
 * Bir fatura için e-belge ön koşullarını denetler (sağlayıcıdan bağımsız). Eksik alanları döndürür; boşsa hazır.
 * e-Fatura alıcının vergi numarasını zorunlu kılar; e-Arşivde alıcı nihai tüketici olabilir, yine de ad/adres gerekir.
 */
export async function einvoiceReadiness(db: Db, invoiceId: string, kind: "e_fatura" | "e_arsiv"): Promise<{ issues: ReadinessIssue[]; doc: EinvoiceDocument | null }> {
  const inv = (
    await db.query(
      `select ci.code, ci.status, ci.invoice_date::text as "invoiceDate", ci.currency, ci.tax_rate::text as "taxRate",
              ci.net_amount::text as "netAmount", ci.tax_amount::text as "taxAmount", ci.gross_amount::text as "grossAmount",
              co.legal_name as "sLegal", co.tax_no as "sTax", co.tax_office as "sOffice", co.address_line as "sAddr",
              co.district as "sDistrict", co.city as "sCity", co.postal_code as "sPostal", co.country as "sCountry",
              cu.name as "bName", cu.legal_name as "bLegal", cu.tax_no as "bTax", cu.tax_office as "bOffice",
              a.line1 || coalesce(' ' || a.line2, '') as "bAddr", a.district as "bDistrict", a.city as "bCity", a.postal_code as "bPostal", a.country as "bCountry"
         from customer_invoices ci
         join companies co on co.id = ci.company_id
         join customers cu on cu.id = ci.customer_id
         left join customer_addresses a on a.customer_id = cu.id and a.is_default and a.active
        where ci.id = $1`,
      [invoiceId],
    )
  ).rows[0];
  if (!inv) return { issues: [{ field: "invoice", message: "Fatura bulunamadı" }], doc: null };

  const issues: ReadinessIssue[] = [];
  const need = (ok: unknown, field: string, message: string) => { if (!ok) issues.push({ field, message }); };
  need(inv.status === "issued" || inv.status === "paid", "invoice.status", "Fatura kesilmiş olmalı");
  need(inv.sLegal, "company.legalName", "Şirketin resmi unvanı girilmemiş");
  need(inv.sTax, "company.taxNo", "Şirketin VKN/TCKN'si girilmemiş");
  need(inv.sOffice, "company.taxOffice", "Şirketin vergi dairesi girilmemiş");
  need(inv.sAddr && inv.sCity, "company.address", "Şirketin adresi (adres satırı + il) girilmemiş");
  need(inv.bAddr && inv.bCity, "customer.address", "Müşterinin varsayılan adresi yok");
  if (kind === "e_fatura") {
    need(inv.bTax, "customer.taxNo", "e-Fatura için müşterinin VKN/TCKN'si zorunlu");
    need(inv.bLegal, "customer.legalName", "e-Fatura için müşterinin resmi unvanı zorunlu");
  }
  const lines = (
    await db.query(
      `select line_no as "lineNo", description, qty::text as qty, unit_price::text as "unitPrice", amount::text as amount
         from customer_invoice_lines where invoice_id = $1 order by line_no`,
      [invoiceId],
    )
  ).rows;
  need(lines.length > 0, "invoice.lines", "Faturada satır yok");
  if (issues.length) return { issues, doc: null };

  return {
    issues,
    doc: {
      kind, invoiceCode: inv.code, invoiceDate: inv.invoiceDate, currency: inv.currency, taxRate: inv.taxRate,
      netAmount: inv.netAmount, taxAmount: inv.taxAmount, grossAmount: inv.grossAmount,
      seller: { legalName: inv.sLegal, taxNo: inv.sTax, taxOffice: inv.sOffice, addressLine: inv.sAddr, district: inv.sDistrict, city: inv.sCity, postalCode: inv.sPostal, country: inv.sCountry },
      buyer: { legalName: inv.bLegal ?? inv.bName, taxNo: inv.bTax ?? "", taxOffice: inv.bOffice, addressLine: inv.bAddr, district: inv.bDistrict, city: inv.bCity, postalCode: inv.bPostal, country: inv.bCountry },
      lines,
    },
  };
}
