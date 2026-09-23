# Devam notu

Son güncelleme: 23.09.2026 — oturum 11 (devir politikası: test planı, firmware, SHA, rota zorunluluğu ve muafiyet)

## Son doğrulanan durum

| Komut | Sonuç |
|---|---|
| `pnpm test` (api) | 98/98 test geçti (acceptance 16, production 10, quality 14, shipping 9, returns 12, costing 9, planning 6, workflow 11, station 4, routing 4, handover 3), gerçek PostgreSQL 16 |
| `tsc --noEmit` (shared, api, web, mobile) | Hatasız |
| `vite build` (web) | Başarılı |
| `expo export --platform android` (mobile) | Derlendi; gerçek cihazda çalıştırılmadı |
| Playwright uçtan uca (oturum 3) | Firmware girişi → test planı oluştur/yayımla → devir → iş emri → yanlış firmware engeli → planla test (geçti/kaldı) → ECR ile iş emri bekletme → Ar-Ge kararı → satış termini (hesaplanamadı → temin süresi → aralık) → taahhüt risk uyarısı; sayfa hatası yok |
| Playwright uçtan uca (oturum 4) | Satış → iş emri → test → son kalite → sipariş ekranından sevkiyat hazırlığı → yanlış kod okutma engeli → 2 seri okutma → kontrol listesiyle paket kapatma → paketleme tamam → taşıyıcı + takip no ile sevk → irsaliye taslağı ve Code128 etiket; sipariş kısmi sevkte açık kalır; sayfa hatası yok |
| Playwright uçtan uca (oturum 5) | Satış: seri okut → müşteri/sevk/garanti bulunur → iade aç; depo teslim alır; kalite inceler (üretim hatası) → tamir + alacak belgesi talebi; teknisyen tamir + tekrar test; depo geri gönderir → kapandı; cihaz geçmişi sevk + iade + olaylar; sayfa hatası yok |
| Playwright uçtan uca (oturum 6) | Yönetici iş emri maliyetini hesaplar → lot maliyeti yok uyarısı; satın alma Depo & Lot ekranından 3 lota fatura maliyeti girer; yeniden hesap v2 (politika v1, birim maliyet); Maliyet & Metrikler: KPI satırı, ilk testte başarı kaynak kayıtları, kârlılık (fiyatsız satır "satış fiyatı yok"), politika sürümleri; sayfa hatası yok |
| Playwright uçtan uca (oturum 7) | Teknisyen günlük listede DEMO görevini açar → kontrol listesi eksik uyarısı → tedarikçi engeli (dış kaynaklı); yönetici baz planı dondurur, Gantt'ta çubuğu 5 gün sürükler, gerekçeyle kaydeder → ardıl çakışma uyarısı; organizasyonda alt birim ve geçici üye ekler; ekip performansı; sayfa hatası yok |
| Playwright uçtan uca (oturum 8) | Yönetici satın alma politikası v1 yayımlar (satın alma 1.000 TRY, yönetici sınırsız, 24 saat → yönetici) → kuru çalıştırma "onaylayamaz"; üretim sorumlusuna süreli vekâlet verir; Ar-Ge elle talep açar (tutar bilinmiyor); satın alma onayı `amount_unknown` ile engellenir ve yöneticiye görev açılır; vekil Günlük işler'de "vekâleten" işi görür ve onaylar (olayda adına); izleme ekranında yükseltme taraması; sayfa hatası yok |
| Playwright uçtan uca (oturum 9) | Kalite TST-01'e bağlayıcı tanımlar (Türkçe sütun adları, virgüllü ondalık, `SN:` öneki, mV/mA → V/A ölçek) ve API belirteci üretir; teknisyen CSV yükler → önizleme: 2 kaydedilecek (biri limit dışı kaldı), yanlış firmware reddi, bilinmeyen seri → onay; aynı dosya tekrar yüklenince mevcut yükleme açılır; istasyon API'si belirteçle üçüncü cihazı kaydeder; cihaz geçmişinde "istasyon CSV/API" kaynağı ve olayda `api` aktörü; sayfa hatası yok |
| Playwright uçtan uca (oturum 10) | Üretim sorumlusu Rotalar ekranında revizyon seçer (varsayılan şablon + 50 adet süre özeti) → taslak v1: THT operasyonunu siler, SMT birim süresini ve montaj talimatını girer, kaydeder, gerekçeyle yayımlar; açılan iş emri "rota v1 (sabit)", plan/gerçek süre ve talimatı gösterir; v2 (SMT yavaş) yayımlanınca v1 arşive geçer, açık iş emri v1'de kalır; sayfa hatası yok |
| Playwright uçtan uca (oturum 11) | Yönetici Akış & onay ekranında devir politikası v1 yayımlar (test planı + firmware + rota); Ar-Ge'nin devre gönderimi `handover_requirements` ile engellenir, ürün ekranında devir paketi kontrol listesi eksikleri gösterir; firmware ve test planı tamamlanır, yönetici rota için gerekçeli muafiyet verir → "hazır"; üç onayla yayımlanan revizyonda yayım anındaki kontrol listesi (politika v1, muafiyet ve veren) görünür; sayfa hatası yok |

## Oturum 11'de eklenenler (devir politikası)

1. **Devir politikası** (şirket ayarı, `/workflow` sayfasında, `workflow.manage`): yayımlanmış test planı, firmware sürümü, firmware SHA-256 (firmware zorunluluğu gerektirir), yayımlanmış rota zorunluluğu. Sürümlü ve değişmez (veri tabanı tetikleyicisi); yayımlanmış BOM her zaman zorunlu. Politika yoksa yalnız BOM.
2. **Kontrol**: devre göndermede ve son devir onayında (inceleme sırasında politika sıkılaşmış olabilir) yapılır; eksik madde `handover_requirements` ile reddedilir, ret olay defterine `handover.blocked` olarak yazılır, son onay kaydedilmez. Yeni politika yayımlanınca incelemedeki etkilenen revizyonlar listelenir.
3. **Muafiyet**: revizyon ve madde bazında, gerekçeli (≥10 karakter), yalnız zorunlu ve eksik maddeye, yayımlanmış revizyona verilmez; değişmez kayıt + olay.
4. **Devir paketi kontrol listesi** ürün ekranında (tamam / eksik / muaf, ayrıntı, muafiyet veren); yayımda o anki liste politika sürümü ve tur ile revizyona dondurulur.

## Oturum 10'da eklenenler (W20)

1. **Sürümlü rota** (`/production/routings`, düzenleme `capacity.manage`: yönetici, üretim): revizyon başına taslak → yayım (gerekçe zorunlu) → önceki sürüm arşiv. Operasyon: sıra, ad, iş merkezi, hazırlık dk, birim dk/adet, kalite kapısı, talimat. Yayımlanan rota veri tabanı tetikleyicisiyle de değişmez; revizyon başına tek taslak; taslaktan vazgeçilebilir; herhangi bir sürümden kopya.
2. **Kural**: en az bir operasyon, benzersiz sıra, tam olarak bir kalite kapısı (test ve son kalite akışı buna bağlı). Hatalar taslakta canlı gösterilir, yayım reddedilir.
3. **İş emri** açıldığında en son yayımlanan rotayı (yoksa varsayılan şablon + iş merkezi süreleri) kopyalar: operasyon, planlı hazırlık/birim süre, talimat, rota sürümü. Yeni sürüm açık işi değiştirmez; eski iş emirlerine migration ile o anki iş merkezi süreleri yazıldı.
4. **Termin**: kapasite yükü satırın revizyon rotasından; kuyruk açık iş emirlerine kopyalanan planlı sürelerden. Varsayımlarda hangi rota sürümünün kullanıldığı yazılır.
5. **Plan / gerçek**: iş emri operasyonlarında planlanan dk / gerçekleşen dk ve talimat (web + mobil); maliyet özetinde "rota planı … saat".
6. Süre özeti: adet için operasyon dakikası, kapasiteye göre gün, en uzun operasyon.

## Oturum 9'da eklenenler (W22)

1. **Test istasyonu bağlayıcısı** (`/quality/station`, tanım `equipment.manage`): yalnızca "test istasyonu" türündeki ekipmana bağlanır; sütun eşlemesi (seri, çalışma kimliği, zaman, sonuç, firmware), ondalık ayırıcı, seri öneki silme, saat farkı, ölçüm sütunu → test planı limit adı + ölçek (mV → V). Mod **TEST** (gerçek istasyonla doğrulanmadı). Devre dışı bırakma gerekçeli ve olay kayıtlı.
2. **CSV yükleme** (`production.test.record`): önizleme gerçek kurallarla, işlem içinde çalıştırılıp geri alınarak hesaplanır (aynı dosyada aynı cihazın ikinci satırı dahil) — kaydedilecek / zaten kayıtlı / seri bulunamadı / okunamadı / reddedildi. Onayda satırlar güncel durumla yeniden değerlendirilir; reddedilen satır cihaz olay defterine yazılır. Aynı dosya (içerik özeti) ikinci kez yeni yükleme açmaz.
3. **İstasyon API'si** (`POST /api/station/runs`, `x-station-token`): kullanıcı oturumu yok; belirteç yalnızca bir kez gösterilir, özeti RLS'siz ayrı tabloda, uygulama rolü okuyamaz (dar kapsamlı fonksiyon). Yenisi eskisini geçersiz kılar. Aynı gönderim tekrarında yeni kayıt yok; aynı çalışma kimliği "zaten kayıtlı". Olay aktörü `api`.
4. **Ortak kural**: elle giriş, CSV ve API aynı `recordDeviceTest` fonksiyonundan geçer — firmware sabitleme, ekipman kalibrasyonu/hizmet durumu, plan limitleri (istasyonun kendi limiti dikkate alınmaz; istasyon "geçti" deyip plan limiti dışındaysa reddedilir), ilk test sonucu değişmez.
5. Test kaydı kaynağı (elle / istasyon CSV / istasyon API), istasyon ölçüm zamanı ve çalışma kimliği; cihaz geçmişinde rozet. Bağlantı durumunda test istasyonu "TEST".

## Oturum 8'de eklenenler (W10)

1. **Onay politikası** (`/workflow`, `workflow.manage`: yönetici): satın alma talebi, değişiklik talebi, iade kararı, giriş kalite, cihaz kalite kararı için sürümlü (değişmez) politika — kendi talebini onaylama, süre (saat), süre aşımında yükseltilecek rol, rol bazlı parasal limit (satın alma). Politika yoksa varsayılan: kendi talebini onaylama kapalı, limit yok. Teknik sistem yöneticisine limit/yükseltme verilemez. Kuru çalıştırma kayıt yazmaz.
2. **Parasal limit**: tahmini tutar = kalemin son lot maliyeti × miktar (yoksa "bilinmiyor", uydurulmaz). Limit aşımı / tutar bilinmiyor / para birimi farkı → onay reddedilir, yetkili üst role "limit üstü onay" görevi açılır, olay yazılır.
3. **Vekâlet** (`/workflow/delegations`): süreli (en çok 90 gün), kapsamlı (yalnızca devredilebilir onay izinleri ve vekâlet verenin sahip olduğu izinler), gerekçeli, iptal edilebilir. Vekâleten işlem olayda `on_behalf_of` taşır; vekâlet verenin kendi talebi de "kendi talebi" sayılır; limit vekâlet verenin rolünden alınır. Günlük işler'de "Vekâleten bekleyen işler".
4. **Zaman aşımı ve yükseltme**: sistem görevine politikadaki süreyle bitiş atanır; arka plan her dakika süresi geçenleri bir kez üst role yükseltir (görev + olay + test modunda bildirim kuyruğu). Asıl görev kapanınca yükseltme de kapanır.
5. **Elle müdahale** (`/workflow/monitor`): süresi geçen onaylar, açık yükseltmeler, görevi başka role aktarma (rolün izni yoksa reddedilir, gerekçeli), çıkış kutusu izleme — başarısız işi tekrar dene; sonucu bilinmeyen işi körlemesine tekrar göndermeden uzlaştır (gerçekleşti/gerçekleşmedi + not).
6. **Elle satın alma talebi** (Ar-Ge, üretim, kalite, satın alma): kalem, miktar, ihtiyaç tarihi, gerekçe; tekrar korumalı. Liste talep eden, not ve tahmini tutarı (maliyet görme yetkisiyle) gösterir.
7. Değişiklik talebi ve iade kararındaki "kendi talebini onaylama" kuralı artık politikadan okunur.

## Oturum 7'de eklenenler (W26)

1. **Planlı görevler** (`task.manage`: yönetici, üretim, Ar-Ge, kalite): başlık, açıklama, sorumlu kişi/rol, departman, öncelik, başlangıç/bitiş, kilometre taşı, kontrol listesi; ürün, sipariş, iş emri, değişiklik talebi, iade, sevkiyata bağlanabilir.
2. **Durum**: açık → sürüyor → engelli/tamamlandı; sorumlu kişi de ilerletebilir. Kapanış için kontrol listesi ve öncüllerin tamamı gerekir. Engel kategorisi zorunlu; tedarikçi/müşteri kaynaklıysa "dış gecikme" işaretlenir. Sistem görevleri elle kapatılamaz.
3. **Bağımlılık**: bitiş→başlangıç, gecikme günü; döngüsel bağımlılık reddedilir.
4. **Baz plan ve tarih değişikliği**: baz planı olan görevin tarihi gerekçesiz değişmez; değişiklik ardıl çakışmalarını ve bağlı siparişin müşteri taahhüdüne etkisini döner — taahhüt ve başka görev değişmez.
5. **Gantt** (`/planning/gantt`): görev + iş emri çubukları, baz plan çizgisi, gerçekleşen bitiş, kilometre taşı, bağımlılık okları (çakışma kırmızı), hafta sonu/tatil gölgesi, bugün çizgisi, sürükleyerek taşıma/bitiş uzatma (yetkiyle, gerekçe onayıyla), tablo görünümü.
6. **Organizasyon** (`/planning/org`): departman/ekip ağacı, yönetici, çoklu ve geçici üyelik, bitirme (silinmez), tarihe göre geçmiş yapı; döngü engeli; şema yetki vermez.
7. **Ekip performansı** (`/planning/team`, `team.report.view`): kişi bazında kapanan görev, zamanında, iç/dış gecikme, zamanında oranı (dış gecikme paydadan çıkar), süresi geçmiş açık, operasyon ve test kaydı sayısı; haftalık/aylık kovalar; tanımlar ve "puan yok" notu.
8. Günlük işler: sistem + planlı görevler, öncelik, bitiş, gecikti ve liste ilerlemesi; mobil "İşlerim"de planlı görev: kontrol listesi, başla, engel, tamamla.
9. DEMO: departman yöneticileri/üyeleri ve bağımlı üç görev (biri kilometre taşı).

## Oturum 6'da eklenenler (W25)

1. **Lot maliyet defteri** (değişmez): açılış içe aktarımı (maliyet sütunu, yetkiyle), mal kabul (yetkiyle), fatura/elle giriş (satın alma, muhasebe), üretim (iş emri maliyetinden). Güncel değer en son kayıt; geçmiş üzerine yazılmaz.
2. **Maliyet politikası** (değişmez sürümler, geçerlilik tarihi): para birimi, işçilik saat ücreti, saat başı genel gider, malzemenin %'si genel gider; değerleme lot bazında gerçek maliyet; hurda sağlam adetlere yüklenir. Gelecek tarihli sürüm bugünkü hesabı etkilemez.
3. **İş emri maliyeti** (sürümlü, deterministik): malzeme (çıkılan lot × güncel lot maliyeti) + işçilik (operasyon süresi × ücret) + genel gider + dış hizmet (yok). Birim maliyet = toplam / sağlam adet; sağlam 0 ise hesaplanamaz + toplam kayıp. Eksikler (politika, lot maliyeti, kur, süre kaydı, tamamlanmamış iş) listelenir ve "Eksik" işaretlenir. Aynı girdi yeni sürüm açmaz; geç gelen fatura yeni sürüm açar, eski sürüm değişmez. Yalnızca eksiksiz hesap bitmiş ürün lotuna maliyet yazar.
4. **Satış kârlılığı**: yalnızca sevk edilen miktar; gelir = adet × sipariş fiyatı; SMM = sevk edilen lotun güncel maliyeti; brüt kâr/marj, para birimi bazında toplam; eksik satır sayısı; iadeler ayrı gösterilir (resmî alacak kaydı yok). `field.cost.view` + `field.price.view` gerekir.
5. **Metrik sözlüğü v1** (`/api/metrics/definitions`): hurda, ilk testte başarı, yeniden işleme, komponent firesi, zamanında teslim, iade oranı, bütçe sapması. Her değer pay/payda/tanım/kapsamla; payda sıfırsa "hesaplanamaz"; kaynak kayıtlar `/api/metrics/:key/sources`.
6. Web: **Maliyet & Metrikler** sayfası (KPI satırı + kaynaklar, kârlılık, politika), iş emrinde Maliyet paneli (sürüm seçimi, kalemler, eksikler), Depo & Lot'ta lot maliyet geçmişi ve giriş.
7. Yeni izinler: `cost.manage` (muhasebe, yönetici), `lot.cost.record` (satın alma, muhasebe), `report.view` (yönetici, muhasebe, üretim, kalite, satış). DEMO şirkette örnek politika v1.

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

- Dış bağlayıcıların hepsi **BAĞLANMADI** (distribütör, e-belge, kargo, toplantı). Test istasyonu adaptörü **TEST** modunda (gerçek istasyon çıktısıyla doğrulanmadı).
- Sevkiyat belgesi **TASLAK**. Kullanıcı daveti e-postası yok. Outbox yalnızca test modunda.
- Demo ekipman: TST-01 (geçerli), DMM-01 (kalibrasyonu geçmiş). Demo komponent temin süresi 21 gün.

## Bilinen sorunlar ve sınırlar

- Termin: vardiya, paralel hat, operasyonların örtüşmesi yok; kesin siparişte malzeme durumu onay anındaki ayırmadan okunur.
- Test planı olmayan iş emrinde sonuç elle seçilir (geriye uyumluluk). Devirde test planı/firmware/rota zorunluluğu şirketin devir politikasıyla (oturum 11) belirlenir.
- Test istasyonu: yalnızca düz CSV ve JSON satır biçimi (istasyona özgü log/XML ayrıştırıcı yok); klasör izleme/otomatik çekme yok (istasyon API'ye göndermeli ya da dosya elle yüklenmeli); istasyon operatörü kullanıcıyla eşlenmiyor; bağlayıcı eşlemesi sürümlü değil (değişiklik olayda before/after ile). Belirteç için oran sınırı yok.
- Rota: operasyonlar sıralı (paralel operasyon, örtüşme, alternatif iş merkezi yok); süreler elle girilir (gerçekleşen süreden öneri yok); rota devirde yalnız devir politikası isterse zorunlu (yoksa varsayılan şablon). Kapasite takvimi iş merkezi bazında günlük dakika; vardiya yok.
- Kargo API'si, e-irsaliye/e-fatura yok (W36); belge TASLAK. Çevrimdışı mobil kuyruk yok.
- İade: tamir sonrası tekrar test yalnızca geçti/kaldı olarak girilir (test planı ölçümleri iade tamirine bağlanmadı). Karantinadaki iade ürününün sonraki analizi ve hurda/yeniden işleme kararı stok ekranından yapılmalı (ayrı akış yok). Geri gönderim sevkiyat listesinde ayrı satır olarak görünmez; iade kaydında izlenir.
- Paketleme rotada ayrı iş merkezi değil; sevkiyat modülünde yapılır.
- Planlama: Gantt'ta kaynak kapasitesi ve vardiya yok; iş emri çubukları salt okunur; mesajlaşma/toplantı (W27/W28) yok.
- Akış: politika yalnızca beş onay türü için; satın alma dışındaki türlerde parasal limit yok. Yükseltme tek seviye (üst rolün de süresi dolarsa ikinci yükseltme yok). Bildirim yalnızca çıkış kutusunda (e-posta/anlık bildirim bağlanmadı). Vekâlet mobilde gösterilmiyor. Tahmini tutar son lot maliyetinden; tedarikçi teklifi/fiyat listesi yok (W18).
- Maliyet: kur dönüşümü yok (farklı para birimli satır "hesaplanamadı"); dış hizmet (fason) maliyeti yok; iade tamiri ve iade hurdası maliyete yansımıyor; bütçe modülü yok; prototip/pilot/seri ayrımı ve ekip performansı raporu (W26) yok. İşçilik yalnızca operasyon başlat/tamamla süresinden; hızlı tıklanan operasyon süre biriktirmez (uyarı olarak eksik listesine düşer). Mobilde maliyet ekranı yok (ofis işi).

## Sıradaki uygulanabilir iş

1. W27/W28: iç mesajlaşma (kayda bağlı konuşma, bahsetme) ve toplantı kararlarının göreve dönüşmesi.
2. W20 devamı: gerçekleşen operasyon sürelerinden standart süre önerisi (sapma raporu), paralel operasyon.
3. W22 devamı: istasyon PC'si için klasör izleyen küçük ajan, operatör eşlemesi.
4. W18: teklif, satın alma siparişi, teyit ve gecikme takibi (test bağlayıcısıyla).
