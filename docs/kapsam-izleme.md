# Kapsam izleme — R01–R48

Durumlar: planlandı · geliştiriliyor · doğrulandı · entegrasyon bekliyor · tamamlandı.
“Tamamlandı” yalnızca promptun §35 tanımı karşılandığında kullanılır; bu oturumda hiçbir madde o düzeye ulaşmadı.

| Kod | Gereksinim | Paketler | Durum | Yapılan | Veri modeli | Kanıt | Engel / kalan |
|---|---|---|---|---|---|---|---|
| R01 | Yedi birim, teknisyen ve çok rollü kullanım | W04, W06 | geliştiriliyor | 10 rol şablonu, çoklu rol, rol bazlı menü/iş listesi | memberships, roles, role_permissions | Web+mobil menü izne göre; T18 testi | Kullanıcı daveti ve rol ekranı yok |
| R02 | Organizasyon şeması ve yönetici yetkileri | W06, W26 | planlandı | Departman tablosu var; şema/ekran yok | departments | — | W26 |
| R03 | Ar-Ge ihtiyacının satın almaya aktarılması | W11, W18 | geliştiriliyor | Üretim ihtiyacından otomatik satın alma talebi | purchase_requests | T02 testi | Ar-Ge proje talebi (W11) yok |
| R04 | Alımın proje ve muhasebeyle bağlantısı | W18, W24 | planlandı | — | — | — | — |
| R05 | Devirde Ar-Ge maliyetinin hesaplanması | W11, W25 | planlandı | — | — | — | — |
| R06 | Devir tamamlanmadan kesin satış engeli | W13, W14 | doğrulandı | Devir onaysız ürüne kesin satış sunucuda reddedilir | product_revisions, handover_approvals | T01 testi, devir testleri | — |
| R07 | Üretimden Ar-Ge'ye revizyon talebi | W13, W20 | planlandı | — | — | — | W13/W20 |
| R08 | Kesin satış öncesi termin ve üretim uygunluğu | W14, W16 | geliştiriliyor | Uygunluk önizlemesi (stok, üretim, net malzeme) | — | T02 önizleme | Kapasite/termin hesabı yok (W16) |
| R09 | Onaylanan satıştan otomatik üretim/net alım ihtiyacı | W10, W16, W18 | doğrulandı | Onayda rezervasyon + üretim ihtiyacı + net alım talebi; tekrar korumalı | reservations, production_needs, purchase_requests | T02, T03, T04 testleri | — |
| R10 | DigiKey, Mouser, Farnell ve Octopart/Nexar sorguları | W03, W17 | entegrasyon bekliyor | Bağlayıcı durumu ekranda BAĞLANMADI | — | — | API lisans/erişim kararı (W03) |
| R11 | EOL, PCN, fiyat, stok ve lead time takibi | W17 | entegrasyon bekliyor | — | — | — | W17 |
| R12 | AI ile pin uyumlu alternatif araştırması | W29 | planlandı | — | — | — | — |
| R13 | Yetkili Ar-Ge veya üretim alternatif onayı | W06, W29 | planlandı | — | — | — | — |
| R14 | Onaylı alternatifin alım ve dizgiye uygulanması | W18, W20, W29 | planlandı | — | — | — | — |
| R15 | Sipariş durumu, gecikme ve tedarikçi hatırlatmaları | W18 | planlandı | Talep onayı var; sipariş/teyit takibi yok | purchase_order_lines | — | W18 |
| R16 | Mal kabul ve teknisyen giriş kalite kontrolü | W19, W21 | doğrulandı | Mal kabul → giriş kontrol konumu → kalite kararı; kontrol öncesi kullanılamaz | goods_receipts, lots, inspections | T05 testi, e2e | Teknisyen kontrol listesi yok |
| R17 | Üretim ve ara kontroller | W20, W21 | planlandı | — | — | — | — |
| R18 | Son kalite ret ve yeniden işleme döngüsü | W21, W22 | planlandı | — | — | — | — |
| R19 | Kaliteden paketleme ve depoya devir | W20, W23 | planlandı | — | — | — | — |
| R20 | Adres, kargo etiketi, irsaliye ve fatura | W23, W24, W36 | planlandı | — | — | — | — |
| R21 | Vadeli tahsilat ve müşteri/muhasebe hatırlatması | W24 | planlandı | — | — | — | — |
| R22 | Ürün maliyeti ve satış kârlılığı | W25 | planlandı | — | — | — | — |
| R23 | Kısmi teslim, iptal, iade, hurda ve karantina | W18–W24, W34 | geliştiriliyor | Kısmi kalite ret ve karantina | stock_moves, locations | T05 | Kısmi teslim, iptal, iade, hurda yok |
| R24 | Geçmiş üretimlerin sisteme alınması | W09, W39 | geliştiriliyor | Açılış stoğu içe aktarımı dış etki üretmez, tekrar dosya reddedilir | import_jobs | T13 | Geçmiş üretim aktarımı yok (W39) |
| R25 | Birebir, grup ve kayıt bazlı mesajlaşma | W27 | planlandı | — | — | — | — |
| R26 | Sesli/görüntülü görüşme ve ekran paylaşımı | W28 | planlandı | — | — | — | — |
| R27 | Toplantı kaydı, transkript, not ve görev | W28, W26 | planlandı | — | — | — | — |
| R28 | Dosya, fotoğraf ve video paylaşımı | W08, W27 | planlandı | — | — | — | — |
| R29 | Görev, Gantt, bağımlılık ve kapasite | W16, W26 | planlandı | — | — | — | — |
| R30 | Bütün birimlerde import/export ve rapor çıktısı | W09 ve bütün modüller | geliştiriliyor | BOM ve açılış stoğu import; stok CSV export (formül kaçışlı) | import_jobs | T13, BOM testi | Diğer modüller |
| R31 | Revizyon, üretim, işlem ve onay logları | W08, W13, W20 | geliştiriliyor | Değişmez olay defteri; revizyon, stok, onay olayları | events, stock_moves | Değişmezlik testi | Dosya/sürüm logu yok |
| R32 | Fire, yeniden işleme ve kâr analizi | W25, W30 | planlandı | — | — | — | — |
| R33 | Her yönetici raporunda stratejik AI bölümü | W30 | planlandı | — | — | — | — |
| R34 | Haftalık, aylık, yıllık ekip performansı | W26, W25, W30 | planlandı | — | — | — | — |
| R35 | AI önerisi onayı ve gerçekleşen etki takibi | W31 | planlandı | — | — | — | — |
| R36 | PCB/BOM/firmware/test sürümlerinin birlikte yönetimi | W12, W13, W20 | geliştiriliyor | BOM sürümü, yayım kilidi, fark görünümü; üretim ihtiyacı BOM sürümünü sabitler | bom_versions, bom_lines | BOM farkı testi, yayım kilidi testi | PCB/firmware/test sürümleri yok |
| R37 | Tedarik riskinin sipariş ve termine etkisi | W16, W18, W30 | planlandı | — | — | — | — |
| R38 | Sade teknisyen ve depo ekranları | W04, W19, W20 | geliştiriliyor | Mobil: mal kabul, kalite, stok sorgu; büyük dokunma alanları | — | Android paketi derlendi | Cihazda kullanıcı testi yapılmadı |
| R39 | Hazır akışlarla hızlı şirket kurulumu | W10, W39 | planlandı | Seed ile varsayılan şirket şablonu | — | — | Kurulum sihirbazı yok |
| R40 | Fason üretici portalı ve dosya teyidi | W32 | planlandı | — | — | — | — |
| R41 | Otomatik test verisi ve ekipman uygunluğu | W22 | planlandı | — | — | — | — |
| R42 | Üretim miktarı ve tedarik senaryoları | W35 | planlandı | — | — | — | — |
| R43 | MSL, raf ömrü, makara ve sahiplik | W33 | planlandı | Lot ve lot zinciri alanı (parent_lot_id) var | lots | — | MSL, raf ömrü, makara yok (W33) |
| R44 | Saha hatasının seri, lot ve revizyona bağlanması | W34 | planlandı | — | — | — | — |
| R45 | Veri kaynağı ve güncellik görünümü | W17, W38 | geliştiriliyor | Bağlayıcı durum ekranı; veri modu ayrımı | — | — | Gerçek veri kaynağı yok |
| R46 | Yedek, geri yükleme ve kesintide talimat erişimi | W37 | planlandı | — | — | — | — |
| R47 | Şirketin tam veri ve dosya çıkış paketi | W09, W42 | planlandı | — | — | — | W42 |
| R48 | Entegrasyonlu mali ve iletişim akışları | W28, W36 | planlandı | — | — | — | — |
