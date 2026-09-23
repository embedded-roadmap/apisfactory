# Devam notu

Son güncelleme: 23.09.2026 — oturum 3 (test planı, firmware, ekipman kalibrasyonu, değişiklik talebi, termin)

## Son doğrulanan durum

| Komut | Sonuç |
|---|---|
| `pnpm test` (api) | 40/40 test geçti (acceptance 16, production 10, quality 14), gerçek PostgreSQL 16 |
| `tsc --noEmit` (shared, api, web, mobile) | Hatasız |
| `vite build` (web) | Başarılı |
| `expo export --platform android` (mobile) | Derlendi; gerçek cihazda çalıştırılmadı |
| Playwright uçtan uca (web) | Firmware girişi → test planı oluştur/yayımla → devir → iş emri → yanlış firmware engeli → planla test (geçti/kaldı) → ECR ile iş emri bekletme → Ar-Ge kararı → satış termini (hesaplanamadı → temin süresi → aralık) → taahhüt risk uyarısı; sayfa hatası yok |

## Oturum 3'te eklenenler

1. **Test planı** (revizyon başına sürümlü, taslak → yayım; yayımlanan plan veri tabanında kilitli). İş emri açıldığı andaki plan sürümünü sabitler.
2. **Karar sunucuda**: zorunlu ölçüm eksikse ret; limit dışı → otomatik "kaldı"; istemcinin gönderdiği limit dikkate alınmaz.
3. **Firmware**: revizyonda sürüm + SHA-256; devirden sonra değiştirilemez; iş emri sabitler; farklı firmware ile test `wrong_firmware` ile reddedilir.
4. **Ekipman ve kalibrasyon**: değişmez kalibrasyon kaydı; hizmet dışı veya süresi geçmiş ekipmanla test reddedilir; ekipmandan etkilenen testler listelenir.
5. **Engellenen denemenin olayı** ayrı işlemde yazılır (işlem geri alınsa da kayıt kalır) — `lib/rejection.ts`.
6. **Değişiklik talebi (ECR)**: iş emrinden (web + mobil); "üretimi durdur" iş emrini bekletir; açık talep varken devam yok; karar `change.decide` ile, talebi açan kişi karar veremez; revizyonun bütün açık iş emirleri için karar zorunlu; kalıcı revizyon kararında Ar-Ge'ye görev; BOM değişmez.
7. **Bekletme / devam**: gerekçeli; beklemedeki işte malzeme çıkışı, operasyon, test ve serbest bırakma engelli.
8. **Termin**: malzeme hazır olma (stok / teyitli alım / temin süresi) + iş merkezi süresi (hazırlık + adet × birim süre ÷ günlük dakika) + açık iş kuyruğu; hafta sonu ve tatil atlanır; aralık olarak verilir; temin süresi tanımsızsa "hesaplanamadı".
9. **Taahhüt tarihi** tahminden ayrı; tahminden erken tarih risk kabulü + gerekçe ister; müşteriye mesaj gönderilmez.
10. Kalite & Ekipman sayfası (ekipman, kalibrasyon, iş merkezi kapasitesi, tatiller), Değişiklik talepleri sayfaları, satış siparişinde Termin paneli, ürün revizyonunda firmware ve test planı editörü.
11. Kullanıcı askıya alma gerekçesi artık satır içi alan (tarayıcı istemi kaldırıldı).
12. API: veri tabanı bağlantısı koparsa süreç çökmez (pool hata dinleyicisi).

## Demo veya test modunda olanlar

- Dış bağlayıcıların hepsi **BAĞLANMADI** (distribütör, e-belge, kargo, test istasyonu, toplantı).
- Sevkiyat belgesi **TASLAK**. Kullanıcı daveti e-postası yok. Outbox yalnızca test modunda.
- Demo ekipman: TST-01 (geçerli), DMM-01 (kalibrasyonu geçmiş). Demo komponent temin süresi 21 gün.

## Bilinen sorunlar ve sınırlar

- Termin: vardiya, paralel hat, operasyonların örtüşmesi yok; kesin siparişte malzeme durumu onay anındaki ayırmadan okunur.
- Test planı olmayan iş emrinde sonuç elle seçilir (geriye uyumluluk). Devir için test planı zorunlu değil — politika kararı gerekir.
- Test istasyonu API/CSV adaptörü yok; ölçüm elle veya mobil formdan girilir.
- Rota şablonu sabit; revizyon bazında rota düzenleme yok.
- Paketleme, etiket, adres, kısmi teslim, müşteri iadesi, çevrimdışı mobil kuyruk yok.

## Sıradaki uygulanabilir iş

1. W23: paketleme operasyonu, teslim adresi, kısmi sevk, etiket.
2. W22: test istasyonu CSV/API adaptörü (test modunda), ölçümün cihaz serisiyle eşleşmesi.
3. W10: genel akış motoru (zaman aşımı, vekil, üst sorumluya bildirim).
4. W20: revizyon bazında rota ve standart süre düzenleme; iş merkezi kapasitesinin rotadan okunması.
5. Politika: devre gönderimde test planı + firmware zorunluluğu (şirket ayarı).
