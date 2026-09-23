# Devam notu

Son güncelleme: 23.09.2026 — oturum 1 (F0/F1 + ilk dikey akış)

## Son doğrulanan durum

Aşağıdaki komutlar bu oturumda gerçekten çalıştırıldı ve geçti:

| Komut | Sonuç |
|---|---|
| `pnpm --filter @apisfactory/api test` | 16/16 test geçti (gerçek PostgreSQL 16, HTTP katmanı üzerinden) |
| `tsc --noEmit` (shared, api, web, mobile) | Hatasız |
| `vite build` (web) | Başarılı |
| `expo export --platform android` (mobile) | Android paketi derlendi (cihazda çalıştırılmadı) |
| Playwright uçtan uca akış (web) | Ar-Ge BOM içe aktarım → devir onayları → açılış stoğu → mal kabul → kısmi kalite kararı → satış kesinleştirme → satın alma listesi; hatasız tamamlandı |

## Gerçekten çalışan iş akışı

1. Giriş, oturum iptali, şirket seçimi; X-Company-Id üyeliği sunucuda doğrulanır.
2. Ürün → BOM CSV içe aktarım (kolon eşleştirme, önizleme, belirsiz MPN çözümü) → BOM yayımı → revizyon → Ar-Ge/üretim/kalite devir onayı → otomatik yayım.
3. Devir onaysız revizyona kesin sipariş sunucuda reddedilir (taslak korunur).
4. Açılış stoğu içe aktarımı (hareket olarak, tekrar dosya reddi).
5. Mal kabul → giriş kontrol konumu → kalite kararı (kabul/ret/kısmi) → kullanılabilir / karantina.
6. Satış siparişi → uygunluk önizlemesi → kesinleştirme: bitmiş stok rezervasyonu, üretim ihtiyacı (BOM sürümü sabit), net malzeme (stok + teyitli açık alım düşülerek), satın alma talebi, görevler.
7. Satın alma talebi onay/ret (dış gönderim yok).
8. Günlük iş listesi, kayıt geçmişi, olay defteri, stok CSV dışa aktarımı.
9. Mobil: işlerim, barkodlu mal kabul, giriş kalite kararı, lot/MPN stok sorgusu.

## Tamamlanan / ilerleyen kodlar

- Doğrulandı (testli): T01, T02, T03, T04, T05, T13, T18 ve ek kontroller (yayımlanmış BOM değişmezliği, negatif stok engeli, olay defteri değişmezliği, alan izni, oturum iptali, BOM farkı, belirsiz MPN).
- Geliştiriliyor: W06, W07, W08 (kısmi), W09 (kısmi), W10 (kısmi), W11 (kısmi), W12, W13 (kısmi), W14, W15, W16 (kısmi), W18 (kısmi), W19 (kısmi), W26 (yalnızca görev listesi).
- Ayrıntı: `docs/kapsam-izleme.md`, `docs/is-paketleri.md`, `docs/kabul-testleri.md`.

## Demo veya test modunda olanlar

- Bütün dış bağlayıcılar **BAĞLANMADI**: DigiKey, Mouser, Farnell, Nexar, e-Fatura/e-İrsaliye, kargo, test istasyonu, toplantı.
- Outbox işleyicisi yalnızca **test** modunda (konsola yazar, dışarı göndermez).
- Mobil uygulama Android paketi derlendi; gerçek cihaz/Expo Go denemesi yapılmadı.

## Bilinen sorunlar ve sınırlar

- Termin hesabı (kapasite, vardiya, tatil, test payı) yok; yalnızca malzeme ve stok değerlendirmesi var.
- Rezervasyon serbest bırakma, sipariş değişikliği/iptali akışı yok.
- Çevrimdışı mobil kuyruk yok; bağlantı yoksa işlem kaydedilmez ve kullanıcıya söylenir.
- Kullanıcı daveti/rol yönetimi ekranı yok (seed ile kuruluyor).
- MFA, anahtar rotasyonu, dosya depolama, arama altyapısı yok.
- Stok CSV dışa aktarımı var; diğer modüllerin export'u yok.

## Sıradaki uygulanabilir iş

1. W10: akış motorunu genelleştir (zaman aşımı, vekil, üst sorumluya bildirim, kuru çalıştırma).
2. W16: termin hesabı (iş merkezi, vardiya, tatil) ve müşteriye taahhüt tarihi akışı; rezervasyon bırakma ve sipariş değişikliği.
3. W06: kullanıcı daveti, rol/izin ekranı, vekâlet, MFA.
4. W20: iş emri, rota ve teknisyen ekranı (mobil) — gerçek lot tüketimi.
5. W03/W17: distribütör API erişim ve lisans denemeleri (karar listesindeki açık kalemlere bağlı).
