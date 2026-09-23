# Devam notu

Son güncelleme: 23.09.2026 — oturum 2 (üretim, son kalite, sevkiyat, iptal, kullanıcı yönetimi)

## Son doğrulanan durum

Bu oturumda gerçekten çalıştırılıp geçen komutlar:

| Komut | Sonuç |
|---|---|
| `pnpm test` (api) | 26/26 test geçti (acceptance 16, production 10), gerçek PostgreSQL 16 |
| `tsc --noEmit` (shared, api, web, mobile) | Hatasız |
| `vite build` (web) | Başarılı |
| `expo export --platform android` (mobile) | Derlendi; gerçek cihazda çalıştırılmadı |
| Playwright uçtan uca (web) | Ar-Ge devri → stok → satış → iş emri → malzeme çıkışı → operasyonlar → test (1 kaldı, yeniden işleme, tekrar test) → son kalite → kapanış → sevkiyat; hatasız |

## Gerçekten çalışan iş akışı

Oturum 1'dekilere ek olarak:

1. Kesin siparişin üretim ihtiyacından iş emri; revizyon ve BOM sürümü sabit; 6 adımlı rota (HAZ, SMT, LEH, PRG, TST kalite kapısı, MON).
2. Yayımda seri numaraları (`IE-000001-00001`), depo ve teknisyen görevleri.
3. Malzeme çıkışı: yalnızca sabit BOM kalemi, yalnızca kullanılabilir stoktaki lot, başka işe ayrılmamış miktar, ihtiyaç kadar. Rezervasyon tüketilir.
4. Operasyonlar: sıra zorunlu, duraklatma nedeni zorunlu, hazırlık malzeme tamamlanmadan kapanmaz, kalite kapısı açık cihaz varken kapanmaz.
5. Test: ölçüm değerleri, limit dışı "geçti" engeli, istasyon çalışma kimliğiyle tekrar ayıklama, başarısızlıkta uygunsuzluk + kalite görevi; yeniden işleme / hurda kararı; FPY ilk testten.
6. Son kalite serbest bırakma → revizyonlu bitmiş ürün lotu → satış satırına rezervasyon.
7. Sevkiyat: yalnızca satıra ayrılmış ve serbest bırakılmış stoktan; belge TASLAK.
8. İş emri kapanışı: çıkılan malzeme tüketim hareketiyle düşülür.
9. Sipariş iptali: rezervasyon bırakma, başlamamış ihtiyaç ve açık talep iptali, etki özeti.
10. Kullanıcı ekleme (geçici parola bir kez), rol atama, askıya alma, parola değiştirme; kendine yetki verme engeli.
11. Cihaz geçmişi: seri → iş emri, BOM sürümü, gerçek lotlar, test çalışmaları.
12. Mobil: Üretim sekmesi (iş emri, operasyon başlat/duraklat/tamamla, barkodla lot çıkışı, seri okutup test).

## Demo veya test modunda olanlar

- Dış bağlayıcıların hepsi **BAĞLANMADI** (distribütör, e-belge, kargo, test istasyonu, toplantı).
- Sevkiyat belgesi **TASLAK**; resmî irsaliye/fatura yok.
- Kullanıcı daveti e-postası yok; geçici parola ekranda bir kez gösterilir.
- Outbox işleyicisi yalnızca test modunda.

## Bilinen sorunlar ve sınırlar

- Termin hesabı (kapasite, vardiya, tatil) yok.
- Rota şablonu sabit; revizyon bazında rota düzenleme ekranı yok.
- Kontrol planı / test limit sürümü yönetimi yok; limitler test kaydıyla gelir (web ve mobilde örnek 3V3 3,2–3,4 V).
- Yanlış firmware ve süresi geçmiş test ekipmanı kontrolü (T12'nin kalanı) yok.
- Paketleme, etiket, adres, kısmi teslim, müşteri iadesi yok.
- Çevrimdışı mobil kuyruk yok.
- Kullanıcı ekranında askıya alma gerekçesi tarayıcı istemiyle alınıyor; satır içi alana çevrilmeli.

## Sıradaki uygulanabilir iş

1. W16: termin hesabı (iş merkezi kapasitesi, vardiya, tatil) ve müşteriye taahhüt tarihi.
2. W21/W22: kontrol planı ve test limit sürümü, ekipman kalibrasyonu, yanlış firmware kontrolü (T12'nin tamamı).
3. W13: mühendislik değişiklik talebi (ECR) ve açık işler için kontrollü geçiş kararı.
4. W23: paketleme operasyonu, teslim adresi, kısmi sevk, etiket.
5. W10: genel akış motoru (zaman aşımı, vekil, üst sorumluya bildirim).
