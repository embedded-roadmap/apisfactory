# Açık kararlar ve engeller

Bu kararlar olmadan ilgili özellik canlıya alınmaz. Bağımsız çekirdek ve test adaptörleri ilerlemeye devam eder.

## Verilmiş kararlar

| Karar | Tarih | Not |
|---|---|---|
| Marka: apisfactory, alan adı apisfactory.com | 23.09.2026 | Görsel dil tanıtım sitesiyle ortak |
| Mobil: React Native + Expo | 23.09.2026 | Barkod için expo-camera |
| Masaüstü: web uygulaması | 23.09.2026 | Kurulum paketi (Tauri/Electron) sonraya |
| Çekirdek: modüler tek uygulama + PostgreSQL RLS | 23.09.2026 | `docs/mimari.md` |

## Açık kararlar

| # | Karar | Etkilediği | Kim |
|---|---|---|---|
| K01 | Logo son hâli ve marka tescili | W02 | Ürün sahibi |
| K02 | Paket fiyatları ve sınırları (sitedeki `[FİYAT]`, `[X]`) | W42 | Ürün sahibi |
| K03 | Pilot şirket(ler), ürün aileleri, tesis sayısı | W39 | Ürün sahibi |
| K04 | İlk distribütörler ve API lisans kapsamı (çok müşterili gösterim, önbellek, tarihçe, AI işleme) | W03, W17 | Teknik lider, satın alma |
| K05 | Muhasebe / e-belge / kargo sağlayıcıları; ana kayıt sistemi | W24, W36 | Muhasebe |
| K06 | Toplantı / transkript sağlayıcısı, kayıt saklama süresi | W28 | Ürün sahibi |
| K07 | Veri barındırma bölgesi | W37 | Teknik lider |
| K08 | Bütçe, iskonto, alternatif onay ve satın alma parasal limitleri | W10, W18, W29 | Yönetim |
| K09 | Maliyet politikası (değerleme yöntemi, işçilik ücreti, genel gider, Ar-Ge payı) | W25 | Muhasebe |
| K10 | Test cihazı veri formatı, etiket yazıcı formatı | W22, W23 | Kalite, depo |
| K11 | Emniyet payı politikası (net ihtiyaçta şu an %0) | W16 | Üretim |
| K12 | KVKK aydınlatma metni, açık rıza ve saklama süreleri (site formu ve uygulama) | W37, site | Hukuk |
| K13 | Kendi talebini onaylama politikası (şu an otomasyon kaynaklı talepler için uygulanmıyor) | W06, W10 | Yönetim |

## Varsayımlar (geri alınabilir)

- Bitmiş ürün stoğu revizyonla girilir; revizyonsuz bitmiş ürün satışa uygun sayılmaz.
- Açık alım yalnızca teyit tarihi varsa ve ihtiyaç tarihine yetişiyorsa net ihtiyaçtan düşülür.
- BOM'da aynı kalem birden çok satırda ise ihtiyaçta birleştirilir; DNP satırlar ihtiyaca girmez.
- Malzeme brüt ihtiyacı 6 ondalığa yukarı yuvarlanır (eksik hesaplanmaz).
- Giriş kalite kararı tekildir; düzeltme ayrı uygunsuzluk süreciyle yapılacak (W21).
