import type { Db } from "../db/pool";
import type { ReadinessIssue } from "./einvoice-providers";
import { CARGO_ADAPTERS } from "./cargo-adapters";

/**
 * Kargo firması adaptörleri. Firmalar arasında değişen her şey adaptördedir; yeni bir firma eklemek = bu arayüzü
 * uygulayan bir nesne yazıp CARGO_PROVIDERS'a kaydetmek (+ firma anahtarı migration 024'teki listede değilse CHECK'e
 * eklemek). Adaptörü olmayan bağlayıcı 'live' moda alınamaz. Oturum 41 devamı: MNG (resmi Swagger), Basit Kargo (açık REST
 * belgesi) Yurtiçi ve Aras (resmi WSDL'ler) adaptörleri yazıldı ama gerçek hesapla DOĞRULANMADI (`verified: false`; lib/cargo-adapters.ts).
 */

export type CargoEnvironment = "sandbox" | "production";

/** Firmadan bağımsız takip durumu. Adaptör, firmanın kendi durum kodunu bunlardan birine eşler (ham metin de saklanır). */
export const CARGO_STATUSES = ["created", "in_transit", "out_for_delivery", "delivered", "returned", "problem", "unknown"] as const;
export type CargoStatus = (typeof CARGO_STATUSES)[number];

export type CargoAddress = {
  name: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  district: string | null;
  city: string;
  postalCode: string | null;
  country: string;
};

export type CargoShipmentRequest = {
  shipmentCode: string;
  sender: CargoAddress & { taxNo: string | null };
  recipient: CargoAddress;
  packages: { code: string; weightKg: string | null }[];
  totalWeightKg: string | null;
};

export type CargoLabel = { contentType: "application/pdf" | "application/zpl" | "image/png"; data: Buffer };

/** Bir ayar alanı: firmaya özel, gizli olmayan yapılandırma (ör. servis tipi). */
export type CargoSettingField = { key: string; label: string; options?: string[]; required?: boolean };

export interface CargoProvider {
  /** Firmanın istediği gizli erişim bilgisi alanları (ör. müşteri kodu, kullanıcı adı, parola, API anahtarı). */
  credentialFields: string[];
  /** Firmaya özel, gizli olmayan ayarlar. */
  settingFields: CargoSettingField[];
  /** Gerçek bir hesapla uçtan uca denendi mi (false: yalnız yayımlanmış belgeden yazıldı). */
  verified?: boolean;
  docsUrl?: string;
  /** Kargo kaydı açar; firmanın takip numarası ve (varsa) etiket dosyası döner. */
  createShipment(
    req: CargoShipmentRequest,
    ctx: { credentials: Record<string, string>; settings: Record<string, string>; environment: CargoEnvironment },
  ): Promise<{ trackingNo: string; labelRef?: string; label?: CargoLabel }>;
  /** Takip durumu sorgusu (firma destekliyorsa). */
  track?(
    trackingNo: string,
    ctx: { credentials: Record<string, string>; settings: Record<string, string>; environment: CargoEnvironment },
  ): Promise<{ status: CargoStatus; raw: string; at: string | null }>;
}

export const CARGO_PROVIDERS: Partial<Record<string, CargoProvider>> = { ...CARGO_ADAPTERS };

/** Kargo kaydı ön koşulları (firmadan bağımsız): gönderici adres/telefon, alıcı adres/telefon, en az bir kapalı koli. */
export async function cargoReadiness(db: Db, shipmentId: string): Promise<{ issues: ReadinessIssue[]; req: CargoShipmentRequest | null }> {
  const s = (
    await db.query(
      `select s.code, s.status,
              co.legal_name as "sName", co.name as "sCompany", co.phone as "sPhone", co.address_line as "sLine", co.district as "sDistrict",
              co.city as "sCity", co.postal_code as "sPostal", co.country as "sCountry", co.tax_no as "sTax",
              a.recipient as "rName", a.phone as "rPhone", a.line1 as "rLine1", a.line2 as "rLine2", a.district as "rDistrict",
              a.city as "rCity", a.postal_code as "rPostal", a.country as "rCountry", a.active as "rActive"
         from shipments s
         join companies co on co.id = s.company_id
         left join customer_addresses a on a.id = s.address_id
        where s.id = $1`,
      [shipmentId],
    )
  ).rows[0];
  if (!s) return { issues: [{ field: "shipment", message: "Sevkiyat bulunamadı" }], req: null };
  const pkgs = (await db.query(`select code, weight_kg::text as "weightKg" from packages where shipment_id = $1 and closed_at is not null order by seq`, [shipmentId])).rows;

  const issues: ReadinessIssue[] = [];
  const need = (ok: unknown, field: string, message: string) => { if (!ok) issues.push({ field, message }); };
  need(["preparing", "packed"].includes(s.status), "shipment.status", "Kargo kaydı yalnız sevk edilmeden önce açılır");
  need(s.sLine && s.sCity, "company.address", "Gönderici (şirket) adresi girilmemiş — e-belge sayfasındaki şirket bilgileri");
  need(s.sPhone, "company.phone", "Gönderici (şirket) telefonu girilmemiş");
  need(s.rLine1 && s.rCity && s.rActive, "customer.address", "Sevkiyatın aktif bir teslim adresi yok");
  need(s.rPhone, "customer.phone", "Alıcı adresinde telefon yok");
  need(pkgs.length > 0, "packages", "Kapatılmış koli yok");
  if (issues.length) return { issues, req: null };

  const weights = pkgs.map((p) => p.weightKg).filter((w): w is string => w !== null);
  return {
    issues,
    req: {
      shipmentCode: s.code,
      sender: { name: s.sName ?? s.sCompany, phone: s.sPhone, line1: s.sLine, line2: null, district: s.sDistrict, city: s.sCity, postalCode: s.sPostal, country: s.sCountry, taxNo: s.sTax },
      recipient: { name: s.rName, phone: s.rPhone, line1: s.rLine1, line2: s.rLine2, district: s.rDistrict, city: s.rCity, postalCode: s.rPostal, country: s.rCountry },
      packages: pkgs,
      totalWeightKg: weights.length === pkgs.length ? weights.reduce((a, w) => a + Number(w), 0).toFixed(3) : null,
    },
  };
}
