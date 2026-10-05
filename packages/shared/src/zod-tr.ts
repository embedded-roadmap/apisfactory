import { z, ZodIssueCode, type ZodErrorMap } from "zod";

/**
 * Türkçe doğrulama mesajları. Uçtan uca bot testinde (2026-10-05) kullanıcıya zod'un İngilizce metni gidiyordu
 * ("note: String must contain at least 3 character(s)"). Şemada özel mesaj verilmişse o kullanılır (zod önceliği).
 */
export const trErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === "undefined" || issue.received === "null") return { message: "Zorunlu alan" };
      return { message: "Geçersiz değer" };
    case ZodIssueCode.too_small:
      if (issue.type === "string") return { message: Number(issue.minimum) <= 1 ? "Boş bırakılamaz" : `En az ${issue.minimum} karakter olmalı` };
      if (issue.type === "array") return { message: `En az ${issue.minimum} öğe gerekli` };
      if (issue.type === "number" || issue.type === "bigint") return { message: issue.inclusive ? `En az ${issue.minimum} olmalı` : `${issue.minimum} değerinden büyük olmalı` };
      return { message: "Değer çok küçük" };
    case ZodIssueCode.too_big:
      if (issue.type === "string") return { message: `En fazla ${issue.maximum} karakter olabilir` };
      if (issue.type === "array") return { message: `En fazla ${issue.maximum} öğe olabilir` };
      if (issue.type === "number" || issue.type === "bigint") return { message: `En fazla ${issue.maximum} olabilir` };
      return { message: "Değer çok büyük" };
    case ZodIssueCode.invalid_string:
      if (issue.validation === "email") return { message: "Geçerli bir e-posta adresi girin" };
      if (issue.validation === "uuid") return { message: "Geçersiz kayıt seçimi" };
      if (issue.validation === "url") return { message: "Geçerli bir adres (URL) girin" };
      return { message: "Biçim geçersiz" };
    case ZodIssueCode.invalid_enum_value:
    case ZodIssueCode.invalid_literal:
    case ZodIssueCode.invalid_union:
    case ZodIssueCode.invalid_union_discriminator:
      return { message: "Geçersiz seçim" };
    case ZodIssueCode.invalid_date:
      return { message: "Geçersiz tarih" };
    case ZodIssueCode.not_multiple_of:
      return { message: `${issue.multipleOf} katı olmalı` };
    case ZodIssueCode.unrecognized_keys:
      return { message: "Tanımsız alan gönderildi" };
    default:
      return { message: ctx.defaultError };
  }
};

/** Uygulamanın her yerinde Türkçe doğrulama mesajı. Sunucu açılışında ve web'de bir kez çağrılır. */
export function applyTurkishZodMessages() {
  z.setErrorMap(trErrorMap);
}

/** Hata kutusunda gösterilen alan adları (API alan anahtarı → ekrandaki ad). Listede olmayan anahtar olduğu gibi gösterilir. */
export const FIELD_LABELS: Record<string, string> = {
  note: "Gerekçe / not",
  reason: "Gerekçe",
  qty: "Miktar",
  quantity: "Miktar",
  code: "Kod",
  name: "Ad",
  email: "E-posta",
  password: "Parola",
  current: "Mevcut parola",
  next: "Yeni parola",
  companyName: "Şirket adı",
  companyCode: "Şirket kodu",
  adminName: "Adınız",
  adminEmail: "E-posta",
  adminPassword: "Parola",
  unitPrice: "Birim fiyat",
  currency: "Para birimi",
  leadTimeDays: "Temin süresi",
  moq: "MOQ",
  validUntil: "Geçerlilik",
  itemId: "Kalem",
  supplierId: "Tedarikçi",
  supplierName: "Tedarikçi",
  customerId: "Müşteri",
  requestedDate: "İstenen tarih",
  needDate: "İhtiyaç tarihi",
  confirmedDate: "Teyit tarihi",
  lotNo: "Lot",
  dateCode: "Tarih kodu",
  decision: "Karar",
  roles: "Roller",
  status: "Durum",
  addressId: "Adres",
  lines: "Satırlar",
  phone: "Telefon",
  billingEmail: "Fatura e-postası",
  creditLimit: "Kredi limiti",
  paymentTermsDays: "Vade",
  rev: "Revizyon",
  title: "Başlık",
  description: "Açıklama",
};
