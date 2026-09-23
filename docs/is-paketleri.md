# İş paketleri — W01–W42

| Kod | Teslim | Bağımlılık | Kabul sahibi | Durum | Not |
|---|---|---|---|---|---|
| W01 | Kapsam sözlüğü, örnek veri, karar listesi | Başlangıç | Ürün sahibi | geliştiriliyor | Kapsam tabloları ve karar listesi docs/ altında |
| W02 | apisfactory marka uygulaması, ürün terminolojisi ve tanıtım sitesi hizalaması (marka kararı verildi) | W01 | Ürün sahibi | geliştiriliyor | Marka apisfactory; site ve uygulama aynı token'lar |
| W03 | API yetenek/lisans/kota ve erişim denemeleri | W01 | Teknik lider, satın alma | entegrasyon bekliyor | Hiçbir sağlayıcıyla erişim denenmedi |
| W04 | Ekran haritası, rol yolculukları ve UX | W01 | Bütün birimler | planlandı | — |
| W05 | Depo, ortamlar, dağıtım ve test hattı | W01 | Teknik lider | geliştiriliyor | pnpm monorepo, migration, docker-compose; CI hattı yok |
| W06 | Şirket, tesis, kimlik, rol, alan izinleri, vekâlet | W05 | Yönetim | geliştiriliyor | Kullanıcı ekleme, rol atama, askıya alma, parola değiştirme, kendi yetkisini değiştirme engeli; vekâlet/MFA yok |
| W07 | Ortak veri sözlüğü, kimlikler ve ilişkiler | W01, W05 | Teknik lider | geliştiriliyor | Ortak kimlikler, MPN ayrımı, sabit hassasiyetli miktar |
| W08 | Dosya/sürüm, arama, indirme ve log altyapısı | W06, W07 | Ar-Ge, yönetim | geliştiriliyor | Olay defteri var; dosya/sürüm deposu ve arama yok |
| W09 | Import/export, önizleme ve hata dosyası | W06, W07 | Bütün birimler | geliştiriliyor | Önizlemeli CSV import (BOM, açılış stoğu), stok export |
| W10 | Akış, onay, zaman aşımı, tekrar koruması | W06, W07 | Yönetim | geliştiriliyor | Sürümlü onay politikası (kendi talebi, rol limiti, süre, yükseltme), süreli vekâlet, zaman aşımı taraması, görev aktarma, outbox uzlaştırma; görsel akış tasarımcısı ve çok seviyeli yükseltme yok |
| W11 | Ar-Ge proje, bütçe, talep ve gider | W07, W09, W10 | Ar-Ge, muhasebe | geliştiriliyor | Yok (yalnızca ürün/revizyon); proje, bütçe, gider sonraki adım |
| W12 | Ürün, BOM, varyant, CAD ve fark görünümü | W08, W09 | Ar-Ge | geliştiriliyor | Ürün, BOM sürümü, CSV/Altium/KiCad kolon eşleştirme, fark |
| W13 | Teknik devir, revizyon ve etki | W10, W12 | Ar-Ge, üretim, kalite | geliştiriliyor | Üç birim devir onayı; ECR, iş emri bekletme, açık iş kararları; firmware kilidi |
| W14 | Müşteri, teklif, sipariş ve satış engeli | W13 | Satış | geliştiriliyor | Müşteri, taslak/kesin sipariş, devir engeli |
| W15 | Stok, lot, sahiplik, rezervasyon ve hareket | W07, W09 | Depo | geliştiriliyor | Lot, konum tipi, hareket defteri, rezervasyon, negatif stok engeli |
| W16 | Net ihtiyaç, kapasite ve termin | W12, W14, W15 | Üretim, satış | geliştiriliyor | Net ihtiyaç, iptal; termin aralığı (malzeme + iş merkezi + kuyruk + tatil), taahhüt; Gantt yok |
| W17 | Distribütör veri adaptörleri ve güncellik | W03, W12 | Satın alma | geliştiriliyor | Bağlayıcı çerçevesi (5 distribütör), TEST (sentetik, işaretli) ve fiyat dosyası modları, önbellek + kaynak + zaman damgası, günlük kota ve çağrı kaydı, BOM tedarik görünümü, RFQ otomatik teklif; gerçek API yok |
| W18 | Teklif, alım, teyit ve gecikme | W10, W15, W17 | Satın alma | geliştiriliyor | Tedarikçi, RFQ + teklif karşılaştırma, gerekçeli seçim, sipariş (test gönderimi), değişmez teyit + kayma etkisi, takip taraması, mal kabul bağlantısı; gerçek gönderim ve distribütör API'si yok |
| W19 | Mal kabul, karantina, kontrol ve iade | W15, W18 | Depo, kalite | geliştiriliyor | Mal kabul, giriş kalite, karantina; iade yok |
| W20 | İş emri, rota, teknisyen ve tüketim | W13, W16, W19 | Üretim | geliştiriliyor | İş emri, revizyon bazında sürümlü rota + standart süre (iş emrine sabitlenir, termin/kuyruk bundan), sıra, malzeme çıkışı (yanlış parça, karantina, başka işe ayrılmış engeli), teknisyen web+mobil, plan/gerçek süre, tüketim |
| W21 | Kalite reçetesi, uygunsuzluk ve yeniden işleme | W19, W20 | Kalite | geliştiriliyor | Sürümlü test planı, sunucu kararı, uygunsuzluk, yeniden işleme/hurda, son kalite; ara kontrol listesi yok |
| W22 | Test istasyonu ve ekipman uygunluğu | W13, W21 | Kalite, Ar-Ge | geliştiriliyor | Ekipman, kalibrasyon, engel + olay, etkilenen testler; istasyon adaptörü (CSV önizle/onayla + belirteçli API, TEST modu), seri eşleme, ölçek, tekrar koruması |
| W23 | Paketleme, etiket, sevkiyat ve adres | W14, W20, W21 | Depo, satış | doğrulandı | Adres, hazırlık, okutmalı paketleme + kontrol listesi, kısmi sevk, takip no, teslim/sorun, taslak irsaliye ve Code128 etiket (web + mobil) |
| W24 | Fatura eşleştirme, ödeme, tahsilat ve vade | W18, W19, W23 | Muhasebe | geliştiriliyor | Tedarikçi faturası, üç yönlü eşleştirme (kalite kabulüyle), sürümlü tolerans, görev ayrılıklı fark onayı, faturadan lot maliyeti, ödeme kaydı (ödeme yapılmaz), yaşlandırma ve ödeme planı; müşteri faturası (sevkiyattan, değişmez), tahsilat kaydı, alacak yaşlandırma, kredi limiti/gecikme engeli ve gerekçeli serbest bırakma; e-belge yok |
| W25 | Tarihsel maliyet, marj ve metrik sözlüğü | W11, W20, W21, W24 | Muhasebe, yönetim | geliştiriliyor | Lot maliyeti, sürümlü politika ve maliyet hesabı, kârlılık, metrik sözlüğü + kaynaklar; bütçe, kur, dış hizmet yok |
| W26 | Görev, Gantt, takvim ve organizasyon | W06, W10, W16 | Birim yöneticileri | geliştiriliyor | Günlük liste (sistem + planlı görev), planlı görev, bağımlılık, baz plan, Gantt (sürükleme + etki), organizasyon şeması, ekip performansı (web; mobilde görev ilerletme) |
| W27 | Mesaj, grup, kayıt konuşması ve medya | W06, W08 | Bütün birimler | geliştiriliyor | Kayda bağlı konuşma, yetkili bahsetme, okundu, değişmez mesaj + gerekçeli geri çekme, dosya/fotoğraf eki (3 dosya/mesaj, DB'de), serbest grup kanalı; video yok |
| W28 | Görüşme, kayıt, transkript ve not | W27, W03 | Ürün sahibi | geliştiriliyor | Toplantı: gündem, katılım, tutanak, karar/aksiyon → görev, değişmez kapanış; görüşme/kayıt/transkript bağlayıcısı yok |
| W29 | Alternatif AI, kanıt ve teknik onay | W13, W17, W21 | Ar-Ge, üretim | geliştiriliyor | Kural tabanlı aday (AI değil), gerekçe + kanıt, Ar-Ge + üretim ayrı onay (öneren onaylayamaz), geri alma, iş emrinde izlenebilir alternatif çıkışı (web+mobil), tedarik görünümünde öneri, kanıt konuşması (datasheet eki) |
| W30 | Yönetici raporu ve stratejik AI | W25, W08 | Yönetim | planlandı | — |
| W31 | AI önerisini göreve alma ve etki ölçme | W10, W26, W30 | Yönetim | planlandı | — |
| W32 | Fason portalı, dosya ve malzeme teyidi | W13, W15, W18, W20 | Üretim, satın alma | planlandı | — |
| W33 | MSL, raf ömrü, ambalaj ve koşul | W15, W19 | Depo, kalite | tamamlandı | Kalemde isteğe bağlı MSL/kullanım süresi/raf ömrü/saklama koşulu/FIFO-FEFO, lotta elle üretim-SKT, paket açılış kaydı, sıralı+durumlu lot listesi, web depo paneli, mobil lot sorgu uyarısı |
| W34 | İade, saha arızası ve cihaz geçmişi | W21, W23, W24 | Kalite, satış | geliştiriliyor | Seri/lot iadesi, garanti hesabı, iade kabul alanı, inceleme + kök neden + ECR, tamir/değişim/hurda/stoğa al/olduğu gibi iade, geri gönderim, cihaz geçmişi (web + mobil teslim alma); alacak belgesi yalnızca muhasebe görevi |
| W35 | Senaryo, maliyet/termin kıyası ve uygulama | W16, W25, W29 | Yönetim | tamamlandı | Baz plan kopyası üzerinde ne-olurdu hesabı (adet/kritik parça gecikmesi/onaylı alternatif/fason/ek vardiya), kaynak veri zamanı+varsayım+hesap kaydı, web senaryo sayfası; gerçek uygulama adımı (senaryoyu göreve/değişikliğe çevirme) yok |
| W36 | Muhasebe/e-belge ve kargo adaptörleri | W03, W23, W24 | Muhasebe, depo | geliştiriliyor | E-belge (6 sağlayıcı) ve kargo (6 firma) bağlayıcı çerçevesi, yalnız TEST modu (sentetik ETTN/takip no, işaretli), kesilmiş faturadan e-belge gönderimi, paketlenmiş sevkiyattan kargo etiketi, değişmez dispatch kaydı; gerçek entegrasyon yok |
| W37 | Güvenlik, şirket ayrımı, yedek ve kesinti | W05, W06, W08 | Teknik lider | geliştiriliyor | RLS şirket ayrımı, oturum iptali; yedek/kurtarma yok |
| W38 | Kota, maliyet, izleme ve operasyon panoları | W17, W28, W29, W30 | Teknik lider | geliştiriliyor | Bağlayıcı operasyon panosu: distribütör kota/önbellek isabeti, e-belge/kargo gönderim sayısı, 7 günlük hata, son etkinlik; yeni veri kaynağı yok |
| W39 | Tarihsel veri geçişi, uzlaşma ve pilot | W09, W20, W25, W37 | Pilot şirket | planlandı | — |
| W40 | Uçtan uca test, yük ve hata dayanıklılığı | İlgili bütün paketler | QA | planlandı | — |
| W41 | Eğitim, yardım, canlı geçiş ve destek | W39, W40 | Ürün sahibi | planlandı | — |
| W42 | Abonelik, faturalama ve şirket yaşam döngüsü | W06, W38 | Ürün sahibi, muhasebe | planlandı | — |
