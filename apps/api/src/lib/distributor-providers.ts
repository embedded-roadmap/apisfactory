/**
 * Distribütör API adaptörleri (DigiKey, Mouser, Farnell, Nexar/Octopart, LCSC...). Her distribütörün kimlik doğrulaması
 * (OAuth2 istemci kimliği, API anahtarı), istek biçimi ve yanıt alanları farklıdır; adaptör bunları firmadan bağımsız
 * bir teklif biçimine (DistributorOffer) çevirir. Önbellek, günlük kota, çağrı kaydı ve fiyat görünürlüğü ortaktır
 * (modules/distributors.ts). Oturum 41 devamı: DigiKey, Mouser, element14 adaptörleri yayımlanmış belgelerden yazıldı
 * (lib/distributor-adapters.ts) ama gerçek hesapla DOĞRULANMADI — `verified: false`, ekranda öyle gösterilir. Adaptörü
 * olmayan distribütör 'live' moda alınamaz; canlı mod ayrıca W03 yazılı lisans teyidi ister.
 *
 * Lisans notu: çoğu distribütör API'si sonuçların üçüncü taraf bir üründe gösterilmesi için ayrı ticari kullanım
 * şartı koyar — her şirket kendi geliştirici hesabını ve şartlarını kendisi onaylar.
 */

import { DISTRIBUTOR_ADAPTERS } from "./distributor-adapters";

export type DistributorEnvironment = "sandbox" | "production";

export type DistributorOffer = {
  sku: string | null;
  manufacturer: string | null;
  stock: number | null;
  moq: number | null;
  multiple: number | null;
  leadTimeDays: number | null;
  lifecycle: "active" | "nrnd" | "eol" | "obsolete" | "unknown";
  currency: string;
  breaks: { qty: number; price: number }[];
  /** Kaynağın izlenebilirliği: ürün sayfası bağlantısı veya distribütörün ürün kimliği. */
  sourceRef: string;
};

export interface DistributorProvider {
  credentialFields: string[];
  /** Gerçek bir hesapla uçtan uca denendi mi (false: yalnız yayımlanmış belgeden yazıldı). */
  verified?: boolean;
  /** Adaptörün dayandığı resmi belge. */
  docsUrl?: string;
  /** Tek MPN sorgusu; katalogda yoksa null. Hata fırlatırsa çağrı 'error' olarak kaydedilir, önbellek korunur. */
  lookup(
    mpn: string,
    ctx: { credentials: Record<string, string>; environment: DistributorEnvironment; currency: string; manufacturer: string | null },
  ): Promise<DistributorOffer | null>;
}

export const DISTRIBUTOR_PROVIDERS: Partial<Record<string, DistributorProvider>> = { ...DISTRIBUTOR_ADAPTERS };
