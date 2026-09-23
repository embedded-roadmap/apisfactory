# Devam notu

Son güncelleme: 23.09.2026 — oturum 5 (müşteri iadesi, garanti, saha arızası, cihaz geçmişi)

## Son doğrulanan durum

| Komut | Sonuç |
|---|---|
| `pnpm test` (api) | 61/61 test geçti (acceptance 16, production 10, quality 14, shipping 9, returns 12), gerçek PostgreSQL 16 |
| `tsc --noEmit` (shared, api, web, mobile) | Hatasız |
| `vite build` (web) | Başarılı |
| `expo export --platform android` (mobile) | Derlendi; gerçek cihazda çalıştırılmadı |
| Playwright uçtan uca (oturum 3) | Firmware girişi → test planı oluştur/yayımla → devir → iş emri → yanlış firmware engeli → planla test (geçti/kaldı) → ECR ile iş emri bekletme → Ar-Ge kararı → satış termini (hesaplanamadı → temin süresi → aralık) → taahhüt risk uyarısı; sayfa hatası yok |
| Playwright uçtan uca (oturum 4) | Satış → iş emri → test → son kalite → sipariş ekranından sevkiyat hazırlığı → yanlış kod okutma engeli → 2 seri okutma → kontrol listesiyle paket kapatma → paketleme tamam → taşıyıcı + takip no ile sevk → irsaliye taslağı ve Code128 etiket; sipariş kısmi sevkte açık kalır; sayfa hatası yok |
| Playwright uçtan uca (oturum 5) | Satış: seri okut → müşteri/sevk/garanti bulunur → iade aç; depo teslim alır; kalite inceler (üretim hatası) → tamir + alacak belgesi talebi; teknisyen tamir + tekrar test; depo geri gönderir → kapandı; cihaz geçmişi sevk + iade + olaylar; sayfa hatası yok |

## Oturum 5'te eklenenler (W34)

1. **İade açma** (satış, kalite): seri veya bitmiş ürün lotu okutulur; müşteri, sevkiyat, sipariş ve garanti sistemden bulunur. Müşteride olmayan cihaz, başka müşteri, aynı seri için ikinci açık iade, sevk edilenden fazla lot iadesi reddedilir. Garanti (ürünün garanti süresi, varsayılan 24 ay) açılışta hesaplanıp saklanır.
2. **Teslim alma** (depo, web + mobil "Mal kabul"): ürün yeni **İade kabul alanına (IAD)** girer; kullanılabilir stok değişmez; cihaz "iade geldi".
3. **İnceleme** (kalite): bulgu + kök neden (üretim, komponent, tasarım, firmware, müşteri hasarı, arıza bulunamadı, belirlenemedi). Tasarım/komponent/firmware/üretim bulgusunda tek tıkla Ar-Ge'ye değişiklik talebi.
4. **Karar**: olduğu gibi iade · tamir (teknisyen tamir + tekrar test; geçmezse yeniden karar) · değişim (serbest, pakette olmayan, başka işe ayrılmamış seri/lot; iade gelen karantinaya) · hurda · stoğa al (yalnızca "arıza bulunamadı" + tekrar test geçti).
5. **Alacak belgesi talebi**: garanti dışı veya müşteri hasarında açılamaz; açılırsa muhasebeye görev düşer (resmî belge yok).
6. **Geri gönderim**: müşterinin aktif adresi kopyalanır; taşıyıcı + takip no; tekrar istek ikinci stok hareketi oluşturmaz.
7. **Cihaz geçmişi sayfası** (`/devices/:seri`): ürün, BOM, iş emri, testler (plan, ekipman, firmware, ölçüm), malzeme lotları, sevkiyat (müşteri) ve iadeler, olaylar. İş emri ekranındaki seriler bu sayfaya bağlı.
8. Stok uygunluğunda "İade kabul" kovası; yeni izinler `rma.view`, `rma.create`, `rma.decide`.

## Oturum 4'te eklenenler (W23)

1. **Teslim adresleri**: müşteri başına çoklu adres, varsayılan; adres düzenlenmez, pasife alınır. Açık sevkiyatın adresi pasife alınamaz. Sevk anında adres belgeye kopyalanır.
2. **Sipariş teslim ayarı**: teslim adresi ve kısmi teslim izni. Kısmi teslim kapalıysa kalan miktarın tamamı tek sevkiyatta gider.
3. **Sevkiyat hazırlığı**: yalnızca satıra ayrılmış, son kaliteden geçmiş ve başka açık sevkiyatta olmayan miktar (T10). Tekrar gelen istek aynı sevkiyatı döner.
4. **Paketleme**: seri veya lot okutma; hurda/serbest bırakılmamış cihaz, bilinmeyen kod, başka siparişin lotu, fazla miktar, serili lotun lot olarak okutulması reddedilir ve olay kaydı kalır. Toplama listesi paketlenmemiş serileri gösterir.
5. **Paket kontrol listesi**: kutu, aksesuar/evrak, ürün/seri etiketi, son görsel kontrol; eksikse paket kapanmaz. Bütün paketler kapanıp bütün miktar paketlenmeden paketleme tamamlanmaz.
6. **Sevk**: taşıyıcı + takip no; stok bitmiş ürün deposundan düşer, rezervasyon tüketilir, okutulan seriler "sevk edildi" olur. Tekrar istek ikinci hareket oluşturmaz. Tüm satırlar gidince sipariş "sevk edildi".
7. **Teslim**: teslim edildi / teslim sorunu (hasar, teslim edilemedi, yanlış adres); sorunlu sevkiyat sonradan teslim edildi yapılabilir. Takip no sonradan girilebilir.
8. **İptal**: hazırlık/paketli sevkiyat iptal edilir (stok hareketi yok, seriler serbest kalır); sevk edilmiş sevkiyat iptal edilemez; açık sevkiyatı olan sipariş iptal edilemez.
9. **Yazdırma**: irsaliye TASLAĞI (resmî belge değildir filigranı) ve koli etiketi; sevkiyat, koli ve seri kodları Code128 barkod (bağımlılıksız üretici, python-barcode ile karşılaştırıldı).
10. Mobil: "Sevk" sekmesi — sevkiyat seçimi, paket seçimi, kamera ile okutma, kontrol listesi, paketleme tamamla, sevk.
11. Yeni izinler: `customer.address.manage` (satış), `shipment.deliver` (depo, satış).

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
- Kargo API'si, e-irsaliye/e-fatura yok (W36); belge TASLAK. Çevrimdışı mobil kuyruk yok.
- İade: tamir sonrası tekrar test yalnızca geçti/kaldı olarak girilir (test planı ölçümleri iade tamirine bağlanmadı). Karantinadaki iade ürününün sonraki analizi ve hurda/yeniden işleme kararı stok ekranından yapılmalı (ayrı akış yok). Geri gönderim sevkiyat listesinde ayrı satır olarak görünmez; iade kaydında izlenir.
- Paketleme rotada ayrı iş merkezi değil; sevkiyat modülünde yapılır.

## Sıradaki uygulanabilir iş

1. W25: tarihsel maliyet, marj ve metrik sözlüğü (hurda, FPY, yeniden işleme, iade oranı; formüller §18).
2. W22: test istasyonu CSV/API adaptörü (test modunda), ölçümün cihaz serisiyle eşleşmesi.
3. W10: genel akış motoru (zaman aşımı, vekil, üst sorumluya bildirim).
4. W20: revizyon bazında rota ve standart süre düzenleme; iş merkezi kapasitesinin rotadan okunması.
5. Politika: devre gönderimde test planı + firmware zorunluluğu (şirket ayarı).
