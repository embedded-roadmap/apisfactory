# Kapsam izleme — R01–R48

Durumlar: planlandı · geliştiriliyor · doğrulandı · entegrasyon bekliyor · tamamlandı.
“Tamamlandı” yalnızca promptun §35 tanımı karşılandığında kullanılır; bu oturumda hiçbir madde o düzeye ulaşmadı.

| Kod | Gereksinim | Paketler | Durum | Yapılan | Veri modeli | Kanıt | Engel / kalan |
|---|---|---|---|---|---|---|---|
| R01 | Yedi birim, teknisyen ve çok rollü kullanım | W04, W06 | geliştiriliyor | 10 rol şablonu, çoklu rol, kullanıcı ekleme, rol atama, askıya alma; kendi rolünü değiştirme engeli | memberships, roles, role_permissions | T18, yetki testleri | Vekâlet, MFA, alan izni ekranı yok |
| R02 | Organizasyon şeması ve yönetici yetkileri | W06, W26 | geliştiriliyor | Departman ağacı, yönetici, çoklu ve geçici üyelik, tarihsel görünüm; şema yetki vermez | departments, department_members | planning.test.ts, e2e | Vekâlet ve parasal limit W10'da eklendi; departman bazında yetki kapsamı yok |
| R03 | Ar-Ge ihtiyacının satın almaya aktarılması | W11, W18 | geliştiriliyor | Üretim ihtiyacından otomatik satın alma talebi | purchase_requests | T02 testi | Ar-Ge proje talebi (W11) yok |
| R04 | Alımın proje ve muhasebeyle bağlantısı | W18, W24 | planlandı | — | — | — | — |
| R05 | Devirde Ar-Ge maliyetinin hesaplanması | W11, W25 | planlandı | — | — | — | — |
| R06 | Devir tamamlanmadan kesin satış engeli | W13, W14 | doğrulandı | Devir onaysız ürüne kesin satış sunucuda reddedilir | product_revisions, handover_approvals | T01 testi, devir testleri | — |
| R07 | Üretimden Ar-Ge'ye revizyon talebi | W13, W20 | doğrulandı | Değişiklik talebi (ECR) iş emrinden/mobilden; "üretimi durdur" iş emrini bekletir; karar yetkili ve talebi açmayan kişiyle, açık iş emirleri için tek tek; BOM değişmez | change_requests, work_orders.hold_reason | quality.test.ts › ECR, e2e | Yeni revizyonun talebe bağlanması elle |
| R08 | Kesin satış öncesi termin ve üretim uygunluğu | W14, W16 | doğrulandı | Uygunluk önizlemesi + termin aralığı (malzeme hazır olma, iş merkezi yükü, açık iş kuyruğu, hafta sonu/tatil); temin süresi yoksa "hesaplanamadı"; taahhüt ayrı ve risk kabulü gerekçeli | sales_orders.estimate/promised_date, work_centers, holidays, items.lead_time_days | quality.test.ts › termin, e2e | Vardiya/çoklu hat, paralel operasyon yok |
| R09 | Onaylanan satıştan otomatik üretim/net alım ihtiyacı | W10, W16, W18 | doğrulandı | Onayda rezervasyon + üretim ihtiyacı + net alım talebi; tekrar korumalı | reservations, production_needs, purchase_requests | T02, T03, T04 testleri | — |
| R10 | DigiKey, Mouser, Farnell ve Octopart/Nexar sorguları | W03, W17 | entegrasyon bekliyor | Bağlayıcı durumu ekranda BAĞLANMADI | — | — | API lisans/erişim kararı (W03) |
| R11 | EOL, PCN, fiyat, stok ve lead time takibi | W17 | entegrasyon bekliyor | — | — | — | W17 |
| R12 | AI ile pin uyumlu alternatif araştırması | W29 | planlandı | — | — | — | — |
| R13 | Yetkili Ar-Ge veya üretim alternatif onayı | W06, W29 | planlandı | — | — | — | — |
| R14 | Onaylı alternatifin alım ve dizgiye uygulanması | W18, W20, W29 | planlandı | İş emri yalnızca sabitlenmiş BOM kalemlerinin çıkışına izin verir (yanlış parça engeli) | material_issues | T12 testi | AI alternatif ve onaylı alternatif kapsamı yok (W29) |
| R15 | Sipariş durumu, gecikme ve tedarikçi hatırlatmaları | W18 | planlandı | Talep onayı var; sipariş/teyit takibi yok | purchase_order_lines | — | W18 |
| R16 | Mal kabul ve teknisyen giriş kalite kontrolü | W19, W21 | doğrulandı | Mal kabul → giriş kontrol konumu → kalite kararı; kontrol öncesi kullanılamaz | goods_receipts, lots, inspections | T05 testi, e2e | Teknisyen kontrol listesi yok |
| R17 | Üretim ve ara kontroller | W20, W21 | geliştiriliyor | İş emri, 6 adımlı rota, sıra zorunluluğu, malzeme uzlaşması, kalite kapısı | work_orders, work_order_operations | Üretim testleri, e2e | Ara kontrol listeleri, rota düzenleme ekranı yok |
| R18 | Son kalite ret ve yeniden işleme döngüsü | W21, W22 | doğrulandı | Test sonucu, uygunsuzluk, yeniden işleme/hurda kararı, tekrar test; FPY ilk testle; sürümlü test planı, karar sunucuda | test_runs, nonconformances, devices, test_plans, test_limits | T09, quality.test.ts, e2e | Ara kontrol listeleri yok |
| R19 | Kaliteden paketleme ve depoya devir | W20, W23 | doğrulandı | Son kalite → bitmiş lot → satıra rezervasyon; seri/lot okutarak paketleme; kutu/aksesuar/etiket/son kontrol listesi; hazır bitmiş stoktan satış aynı kontrollerden geçer | devices, lots, packages, package_items | T10, shipping.test.ts, e2e | Paketleme iş merkezi olarak rotada değil |
| R20 | Adres, kargo etiketi, irsaliye ve fatura | W23, W24, W36 | geliştiriliyor | Müşteri teslim adresleri (düzenlenmez, pasife alınır), sevk anında adres kopyası, taşıyıcı ve takip no, tekrar korumalı sevk, irsaliye TASLAĞI ve Code128 koli/seri etiketi | customer_addresses, shipments | shipping.test.ts, e2e | Kargo API'si, e-irsaliye/e-fatura yok (W36) |
| R21 | Vadeli tahsilat ve müşteri/muhasebe hatırlatması | W24 | planlandı | — | — | — | — |
| R22 | Ürün maliyeti ve satış kârlılığı | W25 | geliştiriliyor | Lot maliyet defteri (açılış/mal kabul/fatura/elle/üretim), sürümlü politika, sürümlü ve deterministik iş emri maliyeti (malzeme + işçilik + genel gider), birim maliyet sağlam adede, sevk edilen satırda gelir/SMM/brüt kâr/marj | lot_costs, cost_policies, cost_runs | costing.test.ts, e2e | Dış hizmet (W32), kur (W24), resmî fatura/alacak kaydı yok |
| R23 | Kısmi teslim, iptal, iade, hurda ve karantina | W18–W24, W34 | geliştiriliyor | Kısmi kalite reddi, karantina, hurda, sipariş iptali; sipariş bazında kısmi teslim izni, sevkiyat iptali, teslim teyidi ve teslim sorunu | stock_moves, reservations, shipments | T05, iptal testi, shipping.test.ts, returns.test.ts | Müşteri iadesi var (W34); iade faturası/alacak belgesi resmî değil (W24/W36) |
| R24 | Geçmiş üretimlerin sisteme alınması | W09, W39 | geliştiriliyor | Açılış stoğu içe aktarımı dış etki üretmez, tekrar dosya reddedilir | import_jobs | T13 | Geçmiş üretim aktarımı yok (W39) |
| R25 | Birebir, grup ve kayıt bazlı mesajlaşma | W27 | planlandı | — | — | — | — |
| R26 | Sesli/görüntülü görüşme ve ekran paylaşımı | W28 | planlandı | — | — | — | — |
| R27 | Toplantı kaydı, transkript, not ve görev | W28, W26 | planlandı | — | — | — | — |
| R28 | Dosya, fotoğraf ve video paylaşımı | W08, W27 | planlandı | — | — | — | — |
| R29 | Görev, Gantt, bağımlılık ve kapasite | W16, W26 | geliştiriliyor | Kayda bağlı görev, öncelik, tarih, kontrol listesi, bağımlılık (döngü reddi), kilometre taşı, baz plan; Gantt (hafta sonu/tatil, iş emri, gerçekleşen, sürükleme yetkiyle) ve gecikme etkisi; müşteri taahhüdü değişmez | tasks, task_dependencies | planning.test.ts, e2e | Kaynak kapasitesi Gantt'ta gösterilmiyor, vardiya yok |
| R30 | Bütün birimlerde import/export ve rapor çıktısı | W09 ve bütün modüller | geliştiriliyor | BOM ve açılış stoğu import; stok CSV export (formül kaçışlı) | import_jobs | T13, BOM testi | Diğer modüller |
| R31 | Revizyon, üretim, işlem ve onay logları | W08, W13, W20 | geliştiriliyor | Değişmez olay defteri; revizyon, stok, onay, operasyon, test, yetki olayları | events, stock_moves, test_runs | Değişmezlik testi | Dosya/sürüm logu yok |
| R32 | Fire, yeniden işleme ve kâr analizi | W25, W30 | geliştiriliyor | Metrik sözlüğü v1: hurda, ilk testte başarı, yeniden işleme, komponent firesi, zamanında teslim, iade oranı; pay/payda/tanım/kapsam ve kaynak kayıtlar | — | costing.test.ts, e2e | Bütçe sapması (bütçe modülü yok), prototip/pilot/seri ayrımı yok |
| R33 | Her yönetici raporunda stratejik AI bölümü | W30 | planlandı | — | — | — | — |
| R34 | Haftalık, aylık, yıllık ekip performansı | W26, W25, W30 | geliştiriliyor | Kişi ve dönem bazında kapanan görev, zamanında oranı (dış gecikme hariç), süresi geçmiş, operasyon ve test sayıları; puan yok, tanımlar görünür | tasks, events, test_runs | planning.test.ts, e2e | Ürün karmaşıklığı/aşama ayrımı yok |
| R35 | AI önerisi onayı ve gerçekleşen etki takibi | W31 | planlandı | — | — | — | — |
| R36 | PCB/BOM/firmware/test sürümlerinin birlikte yönetimi | W12, W13, W20 | geliştiriliyor | İş emri BOM sürümü, test planı sürümü ve revizyon firmware'ini (sürüm + SHA-256) sabitler; devirdeki revizyonda firmware kilitli | bom_versions, test_plans, product_revisions.firmware_*, work_orders | T06, T12 | PCB dosya sürümü yok |
| R37 | Tedarik riskinin sipariş ve termine etkisi | W16, W18, W30 | planlandı | — | — | — | — |
| R38 | Sade teknisyen ve depo ekranları | W04, W19, W20 | geliştiriliyor | Mobil: işlerim, üretim (operasyon, barkodlu çıkış, test), mal kabul, kalite, stok sorgu | — | Android paketi derlendi | Cihazda kullanıcı testi yapılmadı |
| R39 | Hazır akışlarla hızlı şirket kurulumu | W10, W39 | planlandı | Seed ile varsayılan şirket şablonu | — | — | Kurulum sihirbazı yok |
| R40 | Fason üretici portalı ve dosya teyidi | W32 | planlandı | — | — | — | — |
| R41 | Otomatik test verisi ve ekipman uygunluğu | W22 | geliştiriliyor | Ölçüm, plan limitleri, tekrar ayıklama; ekipman + değişmez kalibrasyon kaydı; hizmet dışı/süresi geçmiş ekipmanla test engeli ve olay; ekipmandan etkilenen testler listesi | test_runs, equipment, calibration_records | T12, quality.test.ts | Test istasyonu API/CSV adaptörü yok |
| R42 | Üretim miktarı ve tedarik senaryoları | W35 | planlandı | — | — | — | — |
| R43 | MSL, raf ömrü, makara ve sahiplik | W33 | planlandı | Lot ve lot zinciri alanı (parent_lot_id) var | lots | — | MSL, raf ömrü, makara yok (W33) |
| R44 | Saha hatasının seri, lot ve revizyona bağlanması | W34 | planlandı | Cihaz geçmişi: seri → BOM sürümü, gerçek lotlar, testler | devices, material_issues | Üretim testi | Saha arızası kaydı yok (W34) |
| R45 | Veri kaynağı ve güncellik görünümü | W17, W38 | geliştiriliyor | Bağlayıcı durum ekranı; veri modu ayrımı | — | — | Gerçek veri kaynağı yok |
| R46 | Yedek, geri yükleme ve kesintide talimat erişimi | W37 | planlandı | — | — | — | — |
| R47 | Şirketin tam veri ve dosya çıkış paketi | W09, W42 | planlandı | — | — | — | W42 |
| R48 | Entegrasyonlu mali ve iletişim akışları | W28, W36 | planlandı | — | — | — | — |
