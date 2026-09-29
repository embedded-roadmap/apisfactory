# Devam notu

Son güncelleme: 28.09.2026 — oturum 41: 6 dış bağımlılık maddesinin hepsinin kod tarafı uygulandı (1 e-fatura hazırlığı, 2 kargo adaptör yapısı, 3 AI yorum — Anthropic, 4 distribütör canlı API altyapısı, 5 takvim senkronu, 6 iyzico abonelik tahsilatı); hepsi gerçek sağlayıcı hesabı/erişimi bekliyor. İlk kısım: **madde 2 (kargo) farklı firmalara uyarlanabilir adaptör yapısı** ve **madde 1 (e-fatura) sağlayıcıdan bağımsız kısmı** uygulandı, otomatik testleri geçti ve yerel dev sunucusunda tarayıcıyla doğrulandı — gerçek entegratör adaptörü sağlayıcı seçimi bekliyor (bkz. "Oturum 41"). Önceki durum: oturum 40 devamı (kullanıcının "Hangi paketler kaldı" sorusuna verilen yanıt üzerine "tamam mantıklı olandan devam et" talimatı; kullanıcının 2026-09-26 "devam talimatları" belgesi, bkz. proje dokümanı `claude/devam-talimatlari-2026-09.md`; en son: **R46 — yedek, geri yükleme ve kesintide talimat erişimi** uygulandı, otomatik testleri geçti (backup-restore.test.ts dahil) ve gerçek dev sunucusunda doğrulandı (bkz. aşağıda); öncesinde R39 — hazır akışlarla hızlı şirket kurulumu uygulandı, otomatik testleri geçti ve gerçek dev sunucusunda doğrulandı; öncesinde R37 — tedarik riskinin sipariş ve termine etkisi uygulandı, otomatik testleri geçti ve gerçek dev sunucusunda doğrulandı; öncesinde R04 — Ar-Ge alımının proje ve muhasebeyle bağlantısı uygulandı, otomatik testleri geçti ve gerçek dev sunucusunda doğrulandı; öncesinde R21 — vadeli tahsilat/hatırlatma kuralı uygulandı, otomatik testleri geçti ve gerçek dev sunucusunda doğrulandı; öncesinde R44 — saha arızasının fiziksel iade akışından ayrılması uygulandı ve doğrulandı; öncesinde W42 — SaaS abonelik ve şirket yaşam döngüsü, kapsamı kullanıcı kararıyla daraltılmış olarak uygulandı; öncesinde W39 devamı — tarihsel üretim (iş emri) geçişi — **W39'un tüm sub-kalemleri tamamlanmıştı**. R47 (şirketin tam veri/dosya çıkış paketi) de bu oturumda beklemeden çıkarılıp commit edildi, otomatik testleri geçti ve tam paket 279/279 — bkz. aşağıda. Bu ikisiyle birlikte kalan tüm "planlandı" maddeler dış bağımlılık (sağlayıcı/entegratör seçimi ve erişimi) bekliyor; kullanıcı bunları sırayla ilerletmeyi istedi.)

## Kapsam eşleştirme ve durum matrisi (talimat §0/§12 — 2026-09-26)

Ana promptun 18 (maliyet), 20 (iletişim), 23 (AI), 30 (test), 32 (işletim) bölümleri ile iş
paketlerinin dürüst durumu. Durumlar: geliştirilmedi / uygulandı / otomatik testleri geçti /
sağlayıcı test ortamında doğrulandı / canlıda doğrulandı / dış bağımlılık bekliyor.

| İş | Durum | Not |
|---|---|---|
| §18 Maliyet motoru (deterministik) | **otomatik testleri geçti** | `costing.ts`, sürümlü politika, malzeme+işçilik+genel gider+dış hizmet; `costing.test.ts` 10 test. Kur dönüşümü, bütçe modülü, iade tamiri/hurda maliyeti **geliştirilmedi**. |
| §20 Görev/Gantt/organizasyon | **otomatik testleri geçti** | `planning.ts`, baz plan, sürükle-bırak Gantt; kaynak kapasitesi/vardiya **geliştirilmedi**. |
| §20 Mesaj/kanal/dosya (foto/PDF/video) | **otomatik testleri geçti** | `collaboration.ts`; küçük dosyalar hâlâ bytea (`content`), video artık nesne depolamada (`object_key`). Gerçek MP4/WebM ile uçtan uca doğrulandı (bkz. aşağıda). |
| §20 Toplantı sesli/görüntülü/kayıt/transkript | **geliştirilmedi** | Yalnızca statik .ics daveti var (oturum 31); gerçek görüşme/kayıt/transkript dış sağlayıcı gerektirir. |
| §20/W28 Takvim canlı senkron | **uygulandı, otomatik testleri geçti (sahte HTTP); OAuth uygulama kaydı bekliyor** | Oturum 41: Google Calendar + Microsoft Graph, kullanıcı başına şifreli OAuth bağlantısı, uygulama→takvim (outbox) ve takvim→uygulama artımlı senkron (syncToken / delta). Gerçek hesapla doğrulama için platform işletmecisi OAuth uygulamasını kaydetmeli — bkz. "Oturum 41 devamı — madde 5". |
| §23/W30 Yönetici raporu + stratejik AI | **otomatik testleri geçti, gerçek tarayıcıda doğrulandı (yerel)** | `report-findings.ts` + `reports.ts`: 8 alan (fire/rework, kârlılık, tedarikçi, stok, kapasite/termin, revizyon etkisi, proje bütçesi, tahsilat) kural tabanlı hesaplanır; `report_findings.cause_type` CHECK kısıtı 'confirmed' değerini asla kabul etmez. `reports.test.ts` 13 test; web'de `/reports/executive` gerçek tarayıcı + yerel Postgres dev veritabanında uçtan uca çalıştırıldı (bkz. oturum 38). **AI (LLM) yorum katmanı oturum 41'de uygulandı (Anthropic Claude, otomatik testleri geçti — sahte istemciyle); gerçek anahtarla canlı doğrulama bekliyor**; anahtar yokken `ai_status='unavailable'` dürüstçe işaretleniyor. |
| W31 Öneri→görev→etki | **otomatik testleri geçti** | Öneri→inceleme→onay/red/erteleme→görev→ölçüm→bağımsız doğrulama→kapatma/yeniden açma akışının tamamı `reports.test.ts` içinde uçtan uca test edildi (aynı bulgudan ikinci öneri açılmaması, ölçen kişinin kendi ölçümünü doğrulayamaması dahil). Canlı pilot verisiyle henüz denenmedi. |
| W33 MSL/kurutma altyapısı | **otomatik testleri geçti, gerçek tarayıcıda doğrulandı (yerel)** | Oturum 22: MSL, kullanım süresi, raf ömrü, lot SKT, paket açılışı (`storage.ts`, 5 test). Oturum 39: sürümlü kurutma (bake-out) reçetesi + gerçek çevrim kaydı eklendi (bkz. aşağıda) — JEDEC J-STD-033 tablosu hâlâ **sabit kodlanmadı** (bilinçli tasarım kararı, aşağıda gerekçesi var), şirketin kendi tanımladığı kaynağa dayalı reçete var. |
| W36 E-belge/kargo bağlayıcı | **uygulandı (TEST modu), otomatik testleri geçti; e-belge canlı altyapısı hazır, gerçek entegratör adaptörü dış bağımlılık bekliyor** | TEST çağrıları `dispatch.ts`'te. Oturum 41: sağlayıcıdan bağımsız e-belge ön koşulları eklendi — şirket/müşteri vergi kimliği (VKN/TCKN kontrol hanesi), şirket başına şifreli entegratör erişim bilgisi, hazırlık denetimi, adaptör kayıt defteri ve 'live' mod kapısı (adaptörü olmayan sağlayıcı canlıya alınamaz). **Hiçbir gerçek entegratör adaptörü yok** — sağlayıcı seçimi bekleniyor (bkz. aşağıda "Oturum 41"). Oturum 41 devamı: kargo için firmalara uyarlanabilir adaptör yapısı eklendi (madde 2) — gerçek firma adaptörü yok. |
| W03 API erişim matrisi | **matris dokümanı yazıldı (masa başı), erişim denemesi yapılmadı** | `docs/w03-distributor-erisim-matrisi.md` (oturum 41): 5 sağlayıcı için teknik yetenek + §27 sekiz izin matrisi, kaynaklı. Önemli bulgu: Mouser ve Farnell kamuya açık şartları önbelleği/saklamayı yasaklıyor — mevcut TTL önbelleği, teklif tarihçesi ve tedarik riski taraması bu iki sağlayıcıda yazılı izin olmadan canlı açılmamalı. DigiKey çok müşterili kullanım için yazılı teyit ister. |
| W39 Tarihsel veri geçişi | **uygulandı, otomatik testleri geçti, gerçek tarayıcıda doğrulandı (yerel)** | BOM ve stok import sihirbazı vardı; oturum 39 devamında aynı desenle müşteri/tedarikçi ana veri içe aktarımı (upsert), tüm import türleri için kaynak-hedef uzlaşma göstergesi, açık satış siparişi tarihsel geçişi, açık tedarikçi borcu (AP) tarihsel geçişi, açık satın alma siparişi tarihsel geçişi, açık alacak (AR) tarihsel geçişi ve tarihsel üretim (iş emri) geçişi eklendi (bkz. aşağıda). **W39'un tüm sub-kalemleri artık tamamlandı.** |
| W40 Uçtan uca/yük/dayanıklılık | **kısmen uygulandı, otomatik testleri geçti** | 26 test dosyasında iş kuralı/yetki/RLS testleri var (204/204) — bunlar fonksiyonel kabul testidir. Oturum 39 devamında `apps/api/scripts/loadtest.mjs` (autocannon, `pnpm --filter @apisfactory/api loadtest`) eklendi ve gerçek yerel API + Postgres'e karşı çalıştırıldı: 20 eşzamanlı bağlantı × 20 sn ile `GET /api/items` (ort. 427 istek/sn, ort. gecikme 46 ms, p99 89 ms), `GET /api/stock/balances` (ort. 388 istek/sn, ort. 51 ms, p99 80 ms), `GET /api/imports` (ort. 456 istek/sn, ort. 43 ms, p99 71 ms) — üçünde de 0 hata/0 zaman aşımı. **Bu, prompt'taki 100.000 komponent/1M kayıt/100 eşzamanlı kullanıcı hedefinin tam ölçekli bir testi değildir** (sandbox disk/süre bütçesi elvermiyor; demo veri seti küçük) — yalnızca gerçek ölçülmüş, düşük ölçekli bir taban çizgisi. Gerçek ölçekli yük testi ve dayanıklılık (uzun süreli/kesinti senaryoları) hâlâ **geliştirilmedi**. |
| W41 Eğitim/destek | **uygulandı, gerçek tarayıcıda doğrulandı (yerel)** | `/help` sayfası: rol bazlı görev rehberleri (8 rol), örnek eğitim şirketi notu, `DEFAULT_ROLES`'ten otomatik üretilen yetki matrisi, içe/dışa aktarma ve video/dosya rehberi, AI önerisi inceleme rehberi, hatalı işlem düzeltme rehberi, destek talebi öncelik/sorumlu/eskalasyon tablosu, canlı geçiş kontrol listesi (bkz. aşağıda). Otomatik test yok (yeni API yüzeyi eklemeyen, salt içerik/frontend işi); doğrulama gerçek tarayıcı ekran görüntüsüyle yapıldı. |
| W42 SaaS/abonelik yaşam döngüsü | **uygulandı, otomatik testleri geçti, gerçek tarayıcıda doğrulandı (yerel)** | Kullanıcı kararı (2026-09-27): şirketler arası (cross-tenant) yeni bir yetki sınırı **AÇILMADI** — her şirket yalnızca kendi aboneliğini kendi mevcut rolleriyle (manager, accounting; admin yalnızca görüntüler) yönetir. Durum makinesi (deneme→aktif→gecikmiş→kısıtlı→iptal, iptal kalıcı), paket değişikliği, kullanım sayaçları (aktif kullanıcı, bileşen — canlı hesaplanır, otomatik kısıtlama tetiklemez), idempotent ödeme kaydı (gerçek ödeme sağlayıcısı yok, yalnız kayıt), kısıtlama yalnızca 2 uçta (`POST /api/sales-orders`, `POST /api/rfqs/:id/award`) zorlanır. `subscription.test.ts` 6 test; `/subscription` sayfası ve kısıtlamanın gerçekte satış siparişi oluşturmayı engellediği DEMO ortamında gerçek tarayıcıyla doğrulandı (bkz. aşağıda). Platform operatörü ekranı **geliştirilmedi** (bilinçli kapsam sınırlaması). **Oturum 41:** iyzico Abonelik ile ücret tahsilatı eklendi (otomatik testleri geçti — sahte HTTP; iyzico sandbox doğrulaması hesap bekliyor) — bkz. "Oturum 41 devamı — madde 6". |
| R44 Saha arızası — fiziksel iade akışından ayrım | **otomatik testleri geçti, gerçek (canlı) dev sunucusunda doğrulandı** | `rmas.kind='field_failure'` şemada W34'ten beri vardı ama akış hiç ayrışmamıştı — her iade zorunlu fiziksel teslim alma + fiziksel stok hareketi üreten kararlardan geçiyordu; saha arızasında cihaz müşteride kaldığı için bu UYDURMA hareket üretiyordu. Düzeltme: teslim alma adımı saha arızasında `not_applicable` ile reddedilir; inceleme "open"dan doğrudan yapılır; karar yalnızca iki hareketsiz sonuçla sınırlıdır — `logged_no_action` (kayda geçer, hareket yok) ve `escalated_to_rma` (gerçek bir `return` kaydı açar, orijinali ona bağlar). Migration 043. `field-failure.test.ts` (4 test) + `returns.test.ts`'deki daha önce yanlış `field_failure` etiketli bir senaryo `return`e düzeltildi; tam paket 248/248. **Gerçek dev sunucusunda** (yerel Postgres + canlı API, mock değil) uçtan uca akış (üretim→sevkiyat→saha arızası→teslim alma reddi→inceleme→her iki yeni karar) curl ile ve tarayıcı ekran görüntüsüyle doğrulandı (bkz. aşağıda). Serisiz (lot bazlı) saha arızası senaryosu ayrıca test edilmedi. |
| R46 Yedek, geri yükleme ve kesintide talimat erişimi | **otomatik testleri geçti, gerçek (canlı) dev sunucusunda doğrulandı** | (A) Kesintide erişim: `/help`'ten indirilen çevrimdışı kopya (rol rehberi, destek politikası, atanmış açık işler) `localStorage`'a yazılır; `/offline` hiçbir ağ isteği yapmadan bu kopyadan render eder. (B) Şifreli yedek/geri yükleme: `backup.mjs` her şirket için `app.company_id` ayarlayıp uygulamanın KENDİ RLS sınırı içinde dışa yazar (apis_owner'a BYPASSRLS verme denemesi güvenlik sınıflandırıcısı tarafından reddedildi — bkz. aşağıdaki ayrıntılı bölüm); `openssl aes-256-cbc` ile şifrelenir. `restore.mjs`: gerçek `migrate.ts` ile şema kurar, RLS'siz geçici tabloya COPY + RLS'ye tabi `INSERT...SELECT` ile yükler, TÜM FK kısıtlarını yükleme öncesi kaldırıp sonra aynı tanımla ekler (migration-sırası ve döngüsel FK sorunlarını tek mekanizmayla çözer), `subscription_plans` id'lerini kod eşlemesiyle yeniden bağlar, 9 iş kuralı tetikleyicisini geçici devre dışı bırakır. `test/backup-restore.test.ts`: gerçek backup+restore+ikinci gerçek API sunucusuyla gerçek giriş/RLS ("yetki") doğrulaması | `offline.test.ts` (3/3) + `backup-restore.test.ts` (1/1), tam paket **279/279**; gerçek dev sunucusunda Playwright ile `/help`→indir→`/offline` (API canlıyken VE tüm `/api/**` kesilmişken) doğrulandı; ayrıca manuel bir restore-drill (5 gerçek şirket, 111 tablo, 2066 satır) `GEÇTİ` sonucu verdi — bkz. aşağıdaki ayrıntılı bölüm. |
| R47 Şirketin tam veri/dosya çıkış paketi | **otomatik testleri geçti, gerçek (canlı) dev sunucusunda doğrulandı** | `GET /api/company/export`: tüm şirket-kapsamlı tabloları `information_schema`'dan otomatik keşfeder, JSON döker, veri sözlüğü çıkarır, gerçek dosya eklerini (mesaj/fason) ZIP'e ekler, kullanıcı kimliklerini (parola hariç) `kullanicilar.json`'a yazar, dışa aktarımı denetim olayına kaydeder. `company-export.test.ts` 4/4; migration 042 uygulandı; tam paket **279/279**. Önceki oturumda kullanıcı "Şimdilik kalsın" demişti; bu oturumda beklemeden çıkarılması istendi — R46 ile aynı commit turunda `35279b1` ile commit edildi. |
| R21 Vadeli tahsilat ve müşteri/muhasebe hatırlatması | **otomatik testleri geçti, gerçek (canlı) dev sunucusunda doğrulandı** | Şirket başına tek kural (etkin, en az gecikme günü, sıklık günü, alıcı, şablon, azami hatırlatma = durdurma koşulu); tarama yalnızca `status='issued'` faturaları seçer, satır kilidiyle gönderimden hemen önce açık bakiyeyi yeniden doğrular (ödenmiş faturaya asla gitmez); sıklık limiti + azami sayıda otomatik durdurma + elle duraklat/devam; gerçek e-posta yok — outbox test bağlayıcısına yazılır, e-posta yoksa `emailMissing:true` ile açıkça işaretlenir; her gönderim `reminder.sent` olay geçmişine yazılır; otomatik tarama mevcut 60 sn'lik outbox döngüsüne eklendi. `collections.test.ts` 6/6, tam paket 254/254; gerçek dev sunucusunda sıfırdan ürün→devir→sipariş→sevkiyat→fatura akışıyla 10 gün gecikmiş gerçek bir fatura oluşturulup kural kaydedildi, "şimdi çalıştır" ile hatırlatma gerçekten gönderildi (iç görev + outbox), elle duraklat/devam denendi — tarayıcı ekran görüntüsü ve `/api/history` ile doğrulandı (bkz. aşağıda). Gerçek e-posta/SMS entegrasyonu **dış bağımlılık bekliyor** (proje genelindeki outbox test-bağlayıcı deseniyle tutarlı). |
| R39 Hazır akışlarla hızlı şirket kurulumu | **otomatik testleri geçti, gerçek (canlı) dev sunucusunda doğrulandı** | Önceden yalnızca `db/seed.ts` migration/seed betiğiyle mümkün olan şirket oluşturmaya kimliksiz bir kendi-kendine kayıt ucu (`POST /api/setup/company`) eklendi — gerçek `createCompany`/`createUser` ile hazır departman/rol/iş merkezi şablonu ve 30 günlük deneme aboneliği uygulanır, kurucu admin+manager rolüyle otomatik oturum açar; mükerrer kod/e-posta reddedilir. `GET /api/setup/status` gerçek satır sayılarından bir "Başlangıç" kontrol listesi döner. Web'de giriş ekranına "Yeni şirket oluştur" bağlantısı ve kimlik doğrulamalı `/onboarding` sayfası eklendi (§25 grubu — mevcut `/admin`, `/imports`, `/products`, `/help` ekranlarına yönlendirir, hiçbiri yeniden icat edilmedi). `setup.test.ts` (5/5), tam paket **275/275**; canlı dev sunucusunda `curl` + gerçek Playwright tarayıcısıyla uçtan uca doğrulandı (bkz. aşağıda). |
| R37 Tedarik riskinin sipariş ve termine etkisi | **otomatik testleri geçti, gerçek (canlı) dev sunucusunda doğrulandı** | Şirket bazında yapılandırılabilir eşikler (stok düşüşü %, fiyat artışı %, temin uzaması gün) ve tarama sıklığıyla 5 risk tipi izlenir: kaynakta stok yok, yaşam döngüsü riski (tek anlık görüntüden — TEST bağlayıcısında da gerçek sinyal verir), stok düşüşü/fiyat artışı/temin süresi uzaması (iki anlık görüntü karşılaştırması, mevcut `part_offers` geçmişi üzerinden — W17'den beri var, yeni mekanizma gerekmedi). Her risk kartı: kaynak + veri tazeliği, etkilenen kalem, açık talep/sipariş adedi, ihtiyaç tarihi, onaylı alternatif var mı, önerilen aksiyon, sorumlu rol. Dedup (kısmi tekil indeks) + otomatik kapama (yeniden taramada eşik altında kalan risk otomatik `resolved`) + kritik risk purchasing/rd görevine yükseltme, outbox worker'a entegre. **Dürüstlük notu**: TEST bağlayıcısı MPN'den deterministik türediği için (aynı MPN her zaman aynı değeri verir) iki-anlık-görüntü riskleri saf TEST modunda kendiliğinden tetiklenmez — fabrikasyon veri enjekte etmek yerine, gerçek `price_file` yeniden yükleme mekanizması (zaten var olan, gerçek bir özellik) ile canlı doğrulandı; UI'da bu sınır açıkça belirtiliyor. `supply-risk.test.ts` (7/7), tam paket **270/270**. |
| R04 Ar-Ge alımının proje ve muhasebeyle bağlantısı | **otomatik testleri geçti, gerçek (canlı) dev sunucusunda doğrulandı** | Yeni `rd_projects` (kod, ad, maliyet merkezi, bütçe/para birimi, sahip, durum) ve `project_cost_allocations` (elle, gerekçeli, **değiştirilemez/silinemez** ortak gider kaydı — `forbid_mutation()` tetikleyicisi) tabloları; `purchase_requests.project_id`/`cost_center` yeni sütunlar (migration 045). Satın alma talebi bir projeye bağlanınca **önce mevcut serbest stoktan karşılama** değerlendirilir (`freeQty()`, `sales.ts`'ten dışa açıldı) — yalnızca kalan miktar satın almaya yönlendirilir; proje yoksa (elle/üretim ihtiyacı talepleri) eski davranış bit bit aynı kalır (stok-netleştirme yalnızca `projectId` verildiğinde devreye girer — `workflow.test.ts`'in stoklu bir kaleme karşı ~10 kesin miktar varsayımını bozmamak için bilinçli kapsam sınırlaması). Muhasebe her giderin projesini gerçek `purchase_order_lines.purchase_request_id → purchase_requests.project_id` zincirinden görür (UYDURULMUŞ/tahmini bir bağlantı değil); proje detay ekranı sipariş edilen + teslim alınan + elle bölüştürülen ortak gider toplamını **para birimine göre ayrı** gösterir (kur dönüşümü yok, projenin genelindeki alacak/borç yaşlandırma deseniyle tutarlı). Yönetici raporunun `project_budget` alanı (`report-findings.ts`) eskiden kalıcı `insufficient_data` saplamasıydı — artık açık, bütçesi tanımlı projeler için gerçek harcama/bütçe oranı hesaplar, `causeType` her zaman `hypothesis` (asla `confirmed` — migration 033 CHECK kısıtı). `rd-projects.test.ts` (9 test) + `workflow.test.ts` üzerinde sıfır regresyon; tam paket **263/263**. |

## Dışarıdan beklenen girdiler (gizli değer yazılmaz — yalnız ne gerektiği)

| Sağlayıcı/konu | Gerekli erişim | Güvenli yapılandırma yeri | Bekleyen doğrulama |
|---|---|---|---|
| E-fatura özel entegratörü (Uyumsoft/Foriba/Logo/Paraşüt/Nesbilgi/GİB Portalı) | API kullanıcı/parola veya sertifika (sağlayıcıya göre değişir) — **her şirketin kendi sözleşmesi** | Şirket başına: e-belge bağlayıcıları ekranında şifreli kayıt (`einvoice_connectors.credentials_enc`). Platform düzeyinde yalnız şifreleme anahtarı: `CONNECTOR_SECRET_KEY` (sunucu tarafı secret store) | Sağlayıcı seçimi → adaptör geliştirme → sağlayıcı test ortamında gerçek e-fatura gönderimi ve gerçek ETTN |
| Kargo firması (her şirketin kendi anlaşmalısı) | API anahtarı/müşteri kodu (firmaya göre değişir — adaptör tanımlar) | Şirket başına: kargo bağlayıcıları ekranında şifreli kayıt (`cargo_connectors.credentials_enc`); platform düzeyinde yalnız `CONNECTOR_SECRET_KEY` | Firma seçimi → adaptör → firmanın test ortamında gerçek etiket/takip |
| Google Calendar OAuth | Google Cloud Console'da uygulama kaydı (client id/secret) — platform işletmecisi tarafından; kod hazır (oturum 41) | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `OAUTH_REDIRECT_BASE` | Gerçek hesapla OAuth akışı ve artımlı senkron |
| Microsoft 365/Outlook OAuth | Microsoft Entra ID uygulama kaydı; kod hazır (oturum 41) | `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET`, `MS_OAUTH_TENANT`, `OAUTH_REDIRECT_BASE` | Gerçek hesapla OAuth akışı ve delta sorgu |
| Distribütör API'leri (DigiKey/Mouser/Farnell/Nexar/LCSC) | Her şirketin kendi geliştirici hesabı + ticari kullanım şartı onayı | Şirket başına: Distribütörler ekranında şifreli kayıt (`distributor_connectors.credentials_enc`); platform düzeyinde yalnız `CONNECTOR_SECRET_KEY` | İlk distribütör seçimi → adaptör → gerçek MPN sorgusu (stok/fiyat/temin) |
| Ödeme sağlayıcısı (W42 — abonelik ücreti tahsilatı) | **iyzico seçildi** (oturum 41); kod hazır — iyzico üye işyeri hesabı + Abonelik eklentisi + USD/EUR tahsilat izni bekleniyor | `IYZICO_API_KEY`, `IYZICO_SECRET_KEY`, `IYZICO_BASE_URL`, `PUBLIC_API_BASE` (platform düzeyi); fiyat/plan referansları `subscription_prices` | Sandbox'ta test kartıyla gerçek abonelik başlatma, bildirim ve otomatik durum güncellemesi |
| AI/LLM sağlayıcısı (W30 yorum katmanı) | **Anthropic Claude seçildi** (oturum 41); kod hazır — yalnız API anahtarı bekleniyor | `ANTHROPIC_API_KEY` (+ isteğe bağlı `AI_MODEL`, varsayılan `claude-opus-5`) — yerelde `apps/api/.env`, sunucuda secret store | Gerçek anahtarla canlı yorum üretimi ve `ai_status='generated'` doğrulaması |

## Oturum 41 — dış bağımlılık maddesi 1: e-fatura için sağlayıcıdan bağımsız hazırlık

**Bağlam:** kullanıcı `docs/dis-bagimlilik-promptu.md`'deki 6 maddenin sırayla ilerletilmesini istedi. Madde 1'de
sağlayıcı kararı henüz yok ("ne seçmem gerektiğine dair fikrim yok"). Kod incelemesinde, hangi entegratör seçilirse
seçilsin e-belgenin **zorunlu** girdilerinin sistemde hiç olmadığı görüldü: şirketin ve müşterinin VKN/TCKN'si, vergi
dairesi ve resmi unvanı tutulmuyordu. Bu yüzden önce sağlayıcıdan bağımsız kısım yapıldı.

**Mimari karar — erişim bilgisi şirket başına, ortam değişkeninde değil:** bağlayıcılar zaten şirket başına
(`company_id`, RLS). Her şirket kendi entegratörüyle sözleşme yapar; tek bir platform `EINVOICE_API_KEY`'i çok
kiracılı yapıyla çelişirdi. Erişim bilgisi bağlayıcı satırında AES-256-GCM ile şifreli tutulur; platformun tek sırrı
şifreleme anahtarıdır (`CONNECTOR_SECRET_KEY`). `dis-bagimlilik-promptu.md`'deki ortam değişkeni önerisi buna göre
güncellendi.

**Yapılanlar:**
1. Migration 048: `companies` (resmi unvan, VKN/TCKN, vergi dairesi, adres, ilçe, il, posta kodu, ülke), `customers`
   (resmi unvan, VKN/TCKN, vergi dairesi); `einvoice_connectors` 'live' modu + ortam (sandbox/production) + şifreli
   erişim bilgisi; `einvoice_connectors_live_ready` CHECK kısıtı (erişim bilgisi + ortam olmadan canlı mod DB'de de
   imkânsız); `customer_invoices.document_mode` 'live'.
2. `lib/tax-id.ts`: VKN ve TCKN kontrol hanesi doğrulaması. `lib/secrets.ts`: AES-256-GCM (anahtar yoksa sunucu açılır,
   yalnız erişim bilgisi işlemleri 503 ile reddedilir).
3. `lib/einvoice-providers.ts`: adaptör arayüzü + **bilerek boş** kayıt defteri + `einvoiceReadiness()` (satıcı/alıcı
   vergi kimliği, adres, satır; e-Fatura'da alıcı VKN/TCKN zorunlu, e-Arşiv'de değil).
4. Uçlar: `GET/POST /api/company/tax-profile` (yazma `org.manage`), `GET/POST /api/customers/:id/tax-identity`
   (yazma `receivable.manage`), `POST /api/einvoice-connectors/:id/credentials` (yanıt ve olay kaydı yalnız alan
   ADLARINI içerir), `GET /api/customer-invoices/:id/einvoice-readiness`. Mod değişikliği 'live' için adaptör ve erişim
   bilgisi ister (`adapter_not_available` / `credentials_missing`). `send-einvoice` canlı modda hazırlık denetimini
   zorunlu kılar, adaptörün döndürdüğü ETTN'yi kaydeder.
5. Şirket çıkış paketi (R47) `*_enc` sütunlarını dışlar; manifest notu güncellendi.
6. Web: e-belge bağlayıcıları sayfasına şirket vergi kimliği, müşteri vergi kimliği kartları, gerçek bağlantı/erişim
   bilgisi sütunları ve yalnız-yazılır erişim bilgisi formu; fatura sayfasında hazırlık eksikleri ve CANLI belge
   durumu. `ErrorNotice` artık sunucunun alan bazlı doğrulama hatalarını (`fieldErrors`) listeliyor — uygulama genelinde
   "Girdi doğrulanamadı" mesajının hangi alan için olduğu artık görünüyor.

**Doğrulama durumu (dürüst):**
- `einvoice-live.test.ts` 11/11 (vergi kimliği birim testleri, şifreleme gidiş-dönüş + bozulma tespiti, yetki, RLS,
  hazırlık, canlı mod kapısı, DB kısıtı, çıkış paketinde sır olmaması). Canlı gönderim akışı yalnız testte kayıt
  defterine eklenen **SAHTE** bir adaptörle sınandı — bu gerçek bir entegratöre karşı doğrulama DEĞİLDİR.
- Gerçek tarayıcıda (yerel dev sunucusu + Docker Postgres): geçersiz VKN'nin alan hatasıyla reddi, geçerli profilin
  kaydı ve yenilemede kalıcılığı, muhasebe rolüyle erişim bilgisi kaydı ve değerin sayfada/API yanıtında hiç
  görünmemesi doğrulandı. Demo veride fatura olmadığı için fatura sayfasındaki hazırlık uyarısı tarayıcıda
  görülmedi (otomatik testle doğrulandı).
- (Sonradan düzeltildi — bkz. "Oturum 41 devamı — yedek betikleri platformdan bağımsız".) O an Windows'ta
  `backup-restore.test.ts` Linux'a özgü `sudo -u postgres` çağrısı nedeniyle çalışmıyordu.

**Kalan (dış bağımlılık):** entegratör seçimi → o sağlayıcının adaptörü (`EINVOICE_PROVIDERS[key]`) → sağlayıcı test
ortamında gerçek gönderim ve gerçek ETTN. Yüksek hacimde canlı çağrının outbox'a taşınması (şu an fatura satırı
kilitliyken senkron çağrılıyor — çift gönderimi engeller ama bağlantıyı meşgul eder).

## Oturum 41 devamı — dış bağımlılık maddesi 2: farklı kargo firmalarına uyarlanabilir kargo altyapısı

**Bağlam:** kullanıcı "madde 2 farklı kargo firmalarına uyarlanabilir olsun" dedi; kargo firması henüz seçilmedi.

**Tasarım:** firmalar arasında değişenler — erişim bilgisi alanları, gizli olmayan firma ayarları (servis/ödeme tipi),
etiket biçimi (PDF/ZPL/PNG), takip durum kodları — `CargoProvider` adaptör arayüzünde (`lib/cargo-providers.ts`).
Ortak olanlar: şirket başına şifreli erişim bilgisi (madde 1 ile aynı `lib/connector-credentials.ts`'e taşındı —
e-belge ve kargo tek kod yolunu paylaşıyor), `settings` (adaptör tanımlıysa alan/seçenek/zorunluluk doğrulaması;
değilse serbest), `cargoReadiness()`, etiket dosyasının nesne depolamada saklanması + indirme ucu, firmadan bağımsız
7 durumlu takip (`cargo_status` + ham `cargo_status_raw`), durum değişiminin olay kaydı.

**Yapılanlar:** migration 049; uçlar `POST /api/cargo-connectors/:id/credentials`, `POST /api/cargo-connectors/:id/settings`,
`GET /api/shipments/:id/cargo-readiness`, `GET /api/shipments/:id/cargo-label-file`, `POST /api/shipments/:id/cargo-track`;
`cargo-label` canlı modda adaptöre gider (hazırlık zorunlu). Şirket profiline telefon (kargo göndericisi). Sevkiyat
detayı etiket modu/dosyası/takip durumunu döner. Web: kargo bağlayıcıları sayfası (gerçek bağlantı, erişim bilgisi,
ayar sütunları; ayar ve erişim bilgisi formları), sevkiyat sayfasında hazırlık uyarısı, kargo kaydı kartı (etiket
indir, takip güncelle), TEST/CANLI rozeti. Ortak ekran parçaları `components/Connectors.tsx`'e taşındı.

**Ayrıca düzeltildi:** API sunucusu `.env` dosyasını HİÇ okumuyordu (`.env.example` "kopyalayıp .env yapın" diyordu ama
yükleyen kod yoktu). `config.ts` artık `apps/api/.env`'i Node'un yerleşik `util.parseEnv`'i ile yükler; ortamda
tanımlı değişkenin üzerine yazmaz; testlerde (VITEST) okunmaz.

**Doğrulama:** `cargo-live.test.ts` 9/9 — iki farklı SAHTE adaptör (firma 1: PDF etiket, takipsiz, müşteri kodu+parola,
seçenekli servis tipi; firma 2: ZPL etiket, takip sorgusu, tek API anahtarı) aynı ortak istekle çalıştı; ayar
doğrulaması, canlı mod kapısı, DB kısıtı, RLS, olay kaydında sır olmaması. Bu, gerçek bir kargo firmasına karşı
doğrulama DEĞİLDİR. Gerçek tarayıcıda (yerel): kargo bağlayıcıları sayfası, erişim bilgisinin API sunucusu ortam
değişkeni verilmeden — yalnız `.env`'den okunan anahtarla — kaydedilmesi doğrulandı.

**Kalan (dış bağımlılık):** kargo firması seçimi → o firmanın adaptörü → firmanın test ortamında gerçek etiket/takip.

## Oturum 41 devamı — dış bağımlılık maddesi 3: AI yorum katmanı (Anthropic Claude)

**Karar:** kullanıcı sağlayıcı olarak Anthropic Claude'u seçti; anahtar kullanıcı tarafından `apps/api/.env`'e eklenecek.

**Yapılanlar:** `@anthropic-ai/sdk` bağımlılığı; `lib/ai-narrative.ts` — `claude-opus-5` (`AI_MODEL` ile değişir),
JSON şemalı yapılandırılmış çıktı + uygulama tarafında Zod doğrulaması, `fallbacks: "default"` (beta
`server-side-fallback-2026-07-01`: güvenlik sınıflandırıcısı reddederse sunucu tarafında önerilen modele geçer; yanıtı
gerçekte üreten model `ai_model`'e yazılır), ret/kesik/bozuk yanıt ve SDK hata sınıfları için açık hata kodları.
Sistem istemi: yalnız verilen kanıta dayan, sayı uydurma, nedenleri doğrulanmış gibi sunma, eylem seçeneklerinin dışına
çıkma. Migration 050: `ai_model`, `ai_generated_at`, `ai_generated_by` + `generated` için tamlık kısıtı.
`POST /api/reports/findings/narrate` (en fazla 20 bulgu; sağlayıcı çağrısı DB işlemi dışında — uzun sürebilir; yazma
yalnız hâlâ `unavailable` olanlara, yarış korumalı; yorum bir kez üretilir; olay kaydı), `GET /api/reports/ai-status`;
yetki `report.suggestion.decide` (maliyet doğurur). Web: bekleyen karar listesinde "N bulgu için AI yorumu üret" ve
"AI yorumu — varsayım içerir" etiketli gösterim; anahtar yoksa "AI yorumu kapalı" notu.

**Doğrulama:** `ai-narrative.test.ts` 6/6 — gerçek API ÇAĞRILMADAN (`aiDeps.create` sahte): yapılandırılmamış durumda 503,
yetki, giden istek (model, fallbacks, betas, şema, sistem istemi kuralları), sayısal alanların değişmemesi, uydurma id'nin
yok sayılması, yedek model adının kaydı, tekrar çağrıda sağlayıcının hiç çağrılmaması, ret/kesik/bozuk yanıt, DB kısıtı.
Test ortamında `ANTHROPIC_API_KEY` açıkça boş (makinede anahtar olsa bile testler gerçek API'ye gitmez). Gerçek
tarayıcıda (yerel): anahtarsız durumda "AI yorumu kapalı" notu doğrulandı. **Gerçek anahtarla canlı doğrulama
bekliyor** — not: demo veride tüm alanlar "yeterli veri yok" olduğundan karar bekleyen bulgu çıkmıyor; canlı deneme
için gerçekçi veri (ör. fire/kalite kaydı olan bir dönem) gerekir.

## Oturum 41 devamı — dış bağımlılık maddesi 4: distribütör canlı API altyapısı

**Karar:** kullanıcı "istediği distribütörü seçebilsinler" dedi. Bağlayıcılar zaten şirket başınaydı (her şirket
modunu kendi seçiyordu); eksik olan gerçek API yoluydu.

**Yapılanlar:** migration 051 (`live` modu, ortam, şifreli erişim bilgisi, `distributor_connectors_live_ready`;
`part_offers.source` için `api`); `lib/distributor-providers.ts` — `DistributorProvider.lookup(mpn, ctx)` →
ortak `DistributorOffer`; bilerek boş kayıt defteri. `offersFor` canlı modda adaptörü çağırır — TEST ile aynı
önbellek/yenileme/kota mantığı; hata olursa `error` çağrı kaydı + önbellekteki teklif + genel uyarı (hata ayrıntısı —
erişim bilgisi içerebilir — kullanıcıya/kayda yazılmaz). `POST /api/distributors/:id/credentials`; mod değişikliğinde
canlı kapı. `assertLiveAllowed` üç bağlayıcı türü için `lib/connector-credentials.ts`'te ortak. `/api/integrations`
canlı modu "CANLI" gösterir (önceden her şeyi "test" sayıyordu). Web: Distribütörler sayfasında "Gerçek API" sütunu,
CANLI API seçeneği (adaptör/erişim bilgisi yoksa pasif, nedenini yazar), erişim bilgisi formu, ticari kullanım notu.

**Doğrulama:** `distributor-live.test.ts` 7/7 — iki farklı SAHTE adaptör (OAuth istemci kimliği + USD; API anahtarı +
EUR) ortak biçime çevrildi; birim fiyat kırılımı, taze önbellekte yeniden çağrılmama, yenilemede kota, hata anında
önbellek koruması ve sır sızmaması, DB kısıtı, entegrasyon özeti, RLS. Mevcut `distributors.test.ts` ve
`supply-risk.test.ts` değişmeden geçti. Gerçek tarayıcıda (yerel): sayfa, CANLI seçeneğinin gerekçeli pasif durumu ve
erişim bilgisi formu doğrulandı. Gerçek distribütöre karşı doğrulama DEĞİL.

**Kalan (dış bağımlılık):** ilk distribütör seçimi + geliştirici hesabı → adaptör → gerçek MPN sorgusu. Not: hata
veren çağrılar yerel kotadan düşülmüyor (distribütör tarafında yine de sayılabilir).

## Oturum 41 devamı — madde 5: takvim canlı senkronu (Google Calendar / Microsoft 365)

**Mimari:** OAuth istemcisi platform düzeyinde (ortam değişkenleri); her kullanıcı kendi hesabını yetkilendirir,
token'ı `calendar_connections.token_enc`'te şifreli (şirket çıkış paketi `*_enc`'i zaten dışlar). Toplantı,
DÜZENLEYENİN bağlı takvimine etkinlik olarak yazılır ve katılımcılar etkinliğe davetli eklenir — davet e-postalarını
sağlayıcı gönderir (her katılımcının ayrıca bağlanması gerekmez). Eşleme `calendar_event_links` (toplantı ↔ etkinlik).

**Akışlar:**
- Bağlanma: `POST /api/calendar/connect/:provider` → imzalı (10 dk, HS256, sağlayıcıya bağlı) `state` ile yetkilendirme
  adresi; `GET /api/calendar/oauth/callback/:provider` (herkese açık; kimlik state'ten) kodu token'a çevirir, hesap
  e-postasını alır (Google id_token / Graph `/me`), web'e `?calendar=connected|denied|error` ile döner. Bozuk/başka
  sağlayıcıya ait state reddedilir.
- Uygulama → takvim: toplantı oluşturma/güncelleme/katılımcı/iptal `calendar.push` outbox işi bırakır; işçi
  `pushMeeting` ile oluşturur (POST), günceller (PATCH), iptal eder (Google DELETE `sendUpdates=all`, Graph
  `/cancel` yorumlu). Bağlantı yoksa atlanır. Elle: `POST /api/meetings/:id/calendar-push`.
- Takvim → uygulama: işçinin dakikalık döngüsü ve `POST /api/calendar/sync`; Google `syncToken` (410 → tam senkron),
  Graph `calendarView/delta` (sayfalı, `@removed`, `Prefer: outlook.timezone="UTC"`). Yalnız bağlı etkinlikler; planlı
  toplantıda saat/süre/başlık değişikliği uygulanır (olay kaydı `source: calendar`), silinen etkinlik toplantıyı
  "Takvimden iptal edildi (sağlayıcı)" gerekçesiyle iptal eder. Kapanmış toplantı değişmez. Kendi yaptığımız
  değişiklik geri geldiğinde değerler aynı olduğu için no-op (döngü yok).
- Token: süresi dolmadan 60 sn önce yenilenir, yenisi şifreli saklanır; `invalid_grant`/401 → bağlantı `error`,
  kullanıcıya "yeniden bağlayın". Sağlayıcı hata gövdesi (token/e-posta içerebilir) hata mesajına konmaz.

**Doğrulama:** `calendar.test.ts` 15/15 — sahte HTTP ile giden isteklerin uç nokta/yöntem/gövde/yetki başlığı ve
yanıt işlenişi (yapılandırılmamış → 503, yetkilendirme adresi, state güvenliği, token değişimi ve şifreli saklama,
kişisel görünürlük, oluştur/PATCH/atla, artımlı senkron + 410, token yenileme, takvimden iptal, invalid_grant, Graph
delta sayfalama/`@removed`/UTC, iptal bildirimi, bağlantı kesme, RLS). Mevcut `collaboration.test.ts` değişmeden geçti.
Gerçek tarayıcıda (yerel): "Takvim bağlantım" kartı, yapılandırılmamış durum ve dönüş bildirimi doğrulandı.
**Gerçek Google/Microsoft hesabıyla doğrulanmadı** — OAuth uygulama kaydı gerekiyor. Uç noktalar belgelenmiş API'lere
göre yazıldı; ilk gerçek bağlantıda küçük uyarlamalar gerekebilir.

**Bilinen sınırlar:** yalnız düzenleyenin takvimine yazılır (katılımcının kendi bağlantısına ayrı etkinlik açılmaz —
sağlayıcı daveti yeterli); takvimden eklenen katılımcılar uygulamaya yansımaz; toplantı süresi 5–600 dk dışına
çıkan takvim değişikliği uygulanmaz. Gerçek görüşme/kayıt/transkript hâlâ yok (ayrı dış bağımlılık).

## Oturum 41 devamı — madde 6: abonelik ücreti tahsilatı (iyzico Abonelik)

**Kullanıcı kararları (2026-09-28):** iyzico; paket başına aylık + yıllık, USD/EUR; ödeme alınamazsa / deneme ödeme
yöntemi eklenmeden biterse otomatik 'gecikmiş' + 14 gün ek süre → otomatik 'kısıtlı'; resmi faturayı muhasebe elle keser.

**Doğrulanan iyzico ayrıntıları (docs.iyzico.com, 2026-09-28):** IYZWSv2 = hex(HMAC-SHA256(secret, randomKey + uriPath
+ body)), `Authorization: IYZWSv2 base64("apiKey:…&randomKey:…&signature:…")`, `x-iyzi-rnd`; uç noktalar
`POST /v2/subscription/checkoutform/initialize`, `GET /v2/subscription/checkoutform/{token}`,
`GET /v2/subscription/subscriptions/{ref}` (subscriptionStatus ACTIVE|PENDING|UNPAID|UPGRADED|CANCELED|EXPIRED; orders[].
orderStatus WAITING|SUCCESS|FAILED), `POST …/{ref}/cancel`; ödeme planı currencyCode TRY|USD|EUR. **Webhook imza
biçimi erişilen belgede yoktu** → tasarım: bildirim içeriğine güvenilmez, yalnız abonelik referansı alınır ve gerçek
durum iyzico API'sinden geri okunur (+ işçide günlük mutabakat). Böylece sahte bildirim durumu değiştiremez.

**Yapılanlar:** migration 053 — `subscription_prices` (plan × dönem × para birimi, tutar, iyzico plan referansı;
platform referans verisi, tutarlar tohumlanmadı), `subscription_checkouts` (iyzico token → şirket; form içeriği,
30 dk geçerli, tamamlanınca silinir), `subscription_payments` (sipariş referansıyla tekil; başarılı → `to_invoice`,
başarısız → `not_applicable`; fatura no ile `invoiced`), şirkette iyzico abonelik/müşteri referansı, fiyat, ek süre
bitişi, son mutabakat; oturumsuz uçlar için şirketi token/referansla bulan fonksiyonlar + yalnız eşleşen satırı
gösteren dar `billing_lookup` seçim politikası (FORCE RLS sahip rolü de kapsadığı için security definer tek başına
yetmedi; BYPASSRLS verilmedi). `subscription.ts`: durum geçişi ortak `transitionSubscription`'a çıkarıldı, grafiğe
`trial → delinquent` eklendi, kalıcı iptalde iyzico tekrarlı ödemesi durdurulur. `billing.ts`: fiyatlar/durum,
ödeme formu başlatma (kart bilgisi iyzico'da), form sayfası (tahmin edilemez token, tek kullanımlık), iyzico dönüşü
(sonuç API'den okunur → şirkete bağla → aktif → ilk tahsilat), bildirim, elle senkron, tahsilat listesi, fatura
işaretleme. İşçi: deneme bitişi → gecikmiş (ek süre deneme bitişinden sayılır), ek süre bitişi → kısıtlı, günlük
mutabakat. Web: "Ödeme (iyzico)" kartı (fiyat seçimi, fatura bilgileri, ek süre uyarısı, durumu yenile), "Tahsilatlar
ve fatura" (kesilecek fatura uyarısı, fatura no ile işaretleme).

**Doğrulama:** `billing.test.ts` 13/13 — sahte iyzico HTTP ile: imza algoritmasının bağımsız hesapla eşleşmesi, yetki,
plansız fiyat / yapılandırılmamış sağlayıcı, giden checkout isteği (imza, plan, müşteri, dönüş adresi, kart alanı yok),
form sayfası ve tek kullanımlığı, dönüşte bağlama + aktif + tahsilat, tekrar dönüşte çift kayıt olmaması, tanınmayan
token, bildirimde "başarılı" yazsa bile API'den okunan başarısız tahsilatla gecikmiş + 14 gün, tanınmayan referans,
iyzico hatasında 503, ek süre bitince kısıtlı + satış siparişi engeli, yeniden başarılı tahsilatta aktif, deneme bitişi,
fatura işaretleme ve tekrar/başarısız reddi, RLS, iptalde iyzico cancel. `subscription.test.ts` geçiş grafiği
beklentisi `trial → delinquent` için güncellendi. Gerçek tarayıcıda (yerel): kart, yapılandırılmamış durum, fiyat
tablosu ve dönüş bildirimi doğrulandı. **iyzico sandbox'ında gerçek test kartıyla doğrulanmadı.**

**Bilinen sınırlar:** paket/dönem değişikliği iyzico'da yükseltme olarak yapılmıyor (mevcut abonelik varken yeni ödeme
formu açılmaz; değişiklik için iptal + yeni abonelik veya ileride iyzico upgrade uç noktası); fiyat/plan referansları
platform işletmecisi ekranı olmadığından SQL ile girilir; iyzico'nun bildirim imzası doğrulanmıyor (bilinçli —
geri okuma ile gereksiz); yerelde bildirim almak için dışarıdan erişilebilir adres (tünel) gerekir.

## Oturum 41 devamı — yedek/geri yükleme betikleri platformdan bağımsız (R46 düzeltmesi)

**Sorun:** `backup.mjs` / `restore.mjs` psql (`\copy`), bash (`cp`, `find`, `tail | wc`), GNU tar, openssl ve pnpm komut
satırı araçlarını çağırıyordu. Windows'ta psql/pnpm yoktu ve Node'dan çağrılan `bash` WSL'e (`C:\Windows\System32\bash.exe`)
gidiyordu; Git Bash'teki GNU tar `C:` sürücü harfini uzak sunucu sanıyordu. Yani yalnız test değil, yedekleme
özelliğinin kendisi Windows'ta çalışmıyordu. Kullanıcı kararı: betikleri platformdan bağımsız yap.

**Yapılanlar:** COPY aynı SQL ile `pg-copy-streams` üzerinden (tek bağlantı, şirket bağlamı tablo başına); arşiv `tar`
paketiyle (aynı .tar.gz); şifreleme Node crypto ile `openssl enc -aes-256-cbc -pbkdf2 -salt` biçiminde ("Salted__" +
8 bayt tuz, PBKDF2-HMAC-SHA256 10000 tur → anahtar+IV); dosya kopyalama `fs.cp`; CSV satır sayımı `tail -n +2 | wc -l`
ile aynı anlam (eski manifest toplamlarıyla uzlaşma bozulmasın); şema uygulaması `node --import tsx`; `import.meta.url`
yolları `fileURLToPath`. Geri yüklemede `restoredRows`/`planIdRemap` kapsam hatası (yeniden düzenleme sırasında
oluşabilirdi) önlendi. Test: yönetici işlemleri `TEST_ADMIN_DATABASE_URL` (varsayılan docker `postgres`) ile; bağlanılamazsa
Linux'ta eski `sudo psql` yolu; giriş sondası `node --import tsx`.

**Doğrulama:** Windows'ta `backup-restore.test.ts` ilk kez GEÇTİ (gerçek yedek → gerçek hedef veritabanı, 208/208 satır,
ikinci API süreciyle gerçek giriş + RLS). Yeni `backup-crypto.test.ts` (3): Node gidiş-dönüşü + yanlış anahtar, openssl ↔
Node çapraz uyumluluk (openssl varsa), arşiv/kopyalama/sayım. Türkçe karakterli anahtarla iki yön **Linux openssl'e
(Docker, OpenSSL 3.5.7) karşı elle doğrulandı** — Linux'ta alınmış eski yedekler açılabilir. Windows'ta openssl.exe'ye
ASCII dışı argüman kod sayfası yüzünden farklı iletildiğinden çapraz test orada ASCII anahtar kullanır. `pnpm backup` komut
satırından Windows'ta gerçek dev veritabanıyla çalıştırıldı (2 şirket, 492 satır). Tam test paketinin tamamı Linux
konteynerinde koşturulmadı; Linux'a özgü tek risk olan şifreleme uyumu ayrıca doğrulandı, diğer parçalar saf JS.

## Oturum 40 — R46: yedek, geri yükleme ve kesintide talimat erişimi

**Bağlam:** "Hangi paketler kaldı" sorusuna verilen yanıt üzerine kullanıcı "tamam mantıklı olandan devam et" dedi. `docs/kapsam-izleme.md`'deki kalan "planlandı" satırları tekrar tarandı: R05/R12/R26/R48 dış bağımlılık veya ayrı bir mühendislik-zaman-izleme altyapısı gerektiriyordu, R47 kullanıcı talimatıyla zaten beklemedeydi. R46 (W37 §28: "Yedekleme/geri yükleme ve kesintide talimat erişimi") tek dış bağımlılığı olmayan, tam belirtilmiş kalan kalemdi — bu yüzden seçildi.

**Bölüm A — Kesintide talimat erişimi** (küçük, önce tamamlandı): `/help` sayfasına "Çevrimdışı kopya indir ve sakla" butonu eklendi — rol rehberi, destek politikası ve kullanıcıya atanmış açık işleri gerçek `GET` uçlarından çekip tek bir JSON olarak `localStorage`'a yazar. Yeni `/offline` sayfası bu kayıtlı kopyadan, **hiçbir ağ isteği yapmadan** render eder. `offline.test.ts` (3/3): kopyalama, kayıtlı kopyadan render, kayıt yokken doğru uyarı mesajı.

**Bölüm B — Şifreli yedekleme ve geri yükleme** (asıl iş, çoğu oturum bu bölümde geçti):

1. **Tasarım kararı ve reddedilen kestirme yol:** İlk tasarımda `apis_owner`'a Postgres `BYPASSRLS` niteliği vermek düşünüldü (yedek/geri yükleme script'inin her şirketin RLS sınırını aşarak tüm veriye tek seferde erişmesi için). Bu migration denemesi **Claude Code'un otomatik-mod güvenlik sınıflandırıcısı tarafından `[Security Weaken]` gerekçesiyle reddedildi**. Bu reddi bir engel değil, doğru bir uyarı olarak kabul edip tasarım RLS'yi hiç atlamayacak şekilde yeniden kuruldu: `backup.mjs` her şirket için gerçek `set_config('app.company_id', ...)` ayarlayıp uygulamanın **kendi RLS politikaları içinden** dışa `COPY ... TO` ile yazıyor (COPY TO, filtrelenmiş bir SELECT gibi davrandığından RLS ile sorunsuz çalışıyor); global tablolar (`users`, `companies`, referans olarak `subscription_plans`) ayrı, kısıtsız dışa aktarılıyor. Dışa aktarılan tar arşivi `openssl aes-256-cbc` ile şifreleniyor. Oturum boyunca eklenen HER düzeltme (aşağıdaki 4 madde) de aynı ilkeye bağlı kalınarak tasarlandı: hiçbiri RLS politikasını değiştirmiyor veya yeni bir rol ayrıcalığı istemiyor; hepsi tablo SAHİBİNİN normal DDL/DML işlemleri (geçici tablo, kısıt ekle/kaldır, tetikleyici devre dışı/etkin).

2. **`COPY FROM` + RLS çakışması (gerçek hatadan keşfedildi):** Geri yüklemede `sites` tablosuna COPY denendiğinde `ERROR: COPY FROM not supported with row-level security` alındı — PostgreSQL, FORCE RLS uygulanan hiçbir tabloda COPY FROM'a izin vermiyor, tablo sahibi dahil (COPY TO'dan farklı olarak). Çözüm: her şirket-kapsamlı tablo için `create temp table _restore_stage (like <tablo> including all)` (geçici tablolarda RLS politikası hiç yok, COPY FROM serbest) → CSV bu geçici tabloya COPY edilir → gerçek tabloya normal bir `INSERT ... SELECT` yapılır (normal INSERT, COPY'nin aksine RLS'nin `WITH CHECK`ini uygular — bu yüzden yalnızca `app.company_id` ile eşleşen satırlar gerçekten yazılabiliyor, gerçek bir RLS-saygılı geri yükleme).

3. **Identity sütun çakışması:** İkinci şirket geri yüklenirken `outbox_pkey` üzerinde `duplicate key` hatası alındı — `outbox.id` gibi 7 tablonun (`connector_calls`, `document_dispatches`, `events`, `lot_costs`, `outbox`, `stock_moves`, `subscription_events`) `GENERATED ALWAYS AS IDENTITY` sütunlarında, geçmiş oturumların seed script'lerinden kalma bir alışkanlıkla farklı demo şirketler arasında örtüşen açık id değerleri var (gerçek üretimde tek sürekli bir identity sırası şirketler arası asla çakışmaz — bu ortamın tarihsel bir kalıntısı, gerçek bir üretim riski değil). `information_schema` üzerinden bu 7 tablonun id sütununun hiçbirinin başka bir tablodan FK ile referans alınmadığı doğrulandı, bu yüzden geri yüklemede bu sütunlar için id'yi atlayıp veritabanının yeni bir değer üretmesine izin vermek güvenli — `identityColumnInfo()` bu tabloları tespit ediyor, `copyCsvIntoTable()` FK-referanslı olmayan identity sütununu INSERT'ten çıkarıyor.

4. **İş kuralı "guard" tetikleyicileri:** `bom_lines` geri yüklenirken `ERROR: bom_published: yayımlanmış BOM sürümü değiştirilemez` alındı — RLS'yle ilgisi olmayan, "yayımlandıktan sonra değiştirilemez" iş kuralı tetikleyicileri (proje genelinde 9 tane, `%_guard` adlandırma deseniyle: `bom_lines_guard`, `customer_invoice_lines_guard`, `customer_invoices_guard`, `meeting_items_guard`, `meeting_participants_guard`, `meetings_guard`, `messages_guard`, `routing_operations_guard`, `test_limits_guard`) INSERT'te de tetikleniyor ve zaten geçerli tarihsel veriyi yeniden yazan geri yüklemeyi engelliyor. Çözüm: veri yüklemeden önce tümü `ALTER TABLE ... DISABLE TRIGGER`, yükleme bitince `ENABLE TRIGGER` — `pg_dump`/`pg_restore`'un kısıtları erteleme yaklaşımıyla aynı, standart ve iyi bilinen bir toplu-yükleme deseni; RLS/güvenlikle ilgisi yok.

5. **Yabancı anahtar sırası ve döngü:** `purchase_order_lines` → `purchase_orders` FK'sinde hata alındı; projenin migration-dosya-sırasına dayalı tablo oluşturma sezgisi (`tableCreationOrder()`) `purchase_order_lines`in migration 002'de, ama gerçek referans hedefi `purchase_orders`ın migration 019'da (sonraki bir yeniden tasarım) olduğunu hesaba katmıyordu. Bu düzeltildikten sonra da başka bir FK hatası çıktı — kaynağı `rfqs.awarded_quote_fk` ↔ `rfq_quotes.rfq_id` arasındaki **gerçek bir döngüsel referans** olduğu doğrulandı; hiçbir statik topolojik sıralama bunu tek geçişte çözemez. Nihai çözüm: sıralama problemini tamamen ortadan kaldırmak — geri yüklenecek TÜM tablolardaki TÜM FK kısıtları, tam tanımları `pg_get_constraintdef()` ile kayıt altına alınıp veri yüklemeden önce kaldırılıyor; veri herhangi bir sırayla yükleniyor; tüm kısıtlar (subscription_plans eşlemesi dahil, veri tamamen yerine oturduktan sonra) aynı tanımla yeniden ekleniyor. Bu, `pg_dump`/`pg_restore`'un kendi standart yaklaşımıyla (önce veri, sonra kısıt/indeks) örtüşüyor ve şema gelecekte değişse bile sağlam kalıyor.

6. **`subscription_plans` id eşlemesi:** Bu tablo migration 041 ile şema-tohumlu (id `gen_random_uuid()` varsayılanıyla, açık id verilmeden) — her yeni hedef veritabanında migration yeniden çalıştığında aynı plan `code`ları için tamamen farklı UUID'ler üretiliyor. Çözüm: yedekte `subscription_plans` yalnızca arama amaçlı (id, code) olarak taşınıyor; geri yüklemede hedefin kendi migration'ı tarafından yeniden tohumlanan tablodan code→yeniId haritası, yedekten eskiId→code haritası çıkarılıp birleştiriliyor; `companies.subscription_plan_id`, `subscription_events.from_plan_id`, `subscription_events.to_plan_id` bu eşlemeyle güncelleniyor; eşlenemeyen (hedefte artık var olmayan kod) değerler FK yeniden eklenmeden önce dürüstçe NULL'a çekilip `orphanedPlanRefs` sayacıyla raporlanıyor — sessizce atılmıyor.

7. **Test (`backup-restore.test.ts`, 1 test):** Gerçek `backup.mjs`/`restore.mjs` script'lerini, gerçek bir KAYNAK ve gerçek, izole bir HEDEF Postgres veritabanına karşı uçtan uca çalıştırıyor — hiçbir adım mock'lanmadı. "Kayıt" (satır sayısı uzlaşması + backup öncesi oluşturulan gerçek bir görevin başlığıyla hedefte bulunması) ve "dosya" (gerçek bir ek dosyanın sha256 bütünlüğü) doğrulamasına ek olarak, `restore.mjs`'in kendi başlığında bıraktığı "yetki doğrulaması ayrıca test/backup-restore.test.ts'de gerçek bir ikinci API sunucusuyla yapılır" notunu karşılayan bir "yetki" bacağı eklendi: yeni `restore-login-probe.mts`, **ayrı bir Node/tsx alt süreci** olarak (bu projenin `config.ts`/`pool.ts`'i ortam değişkenlerini süreç başına bir kez okuduğundan, aynı süreçte iki farklı veritabanına bağlı iki `buildApp()` örneği aynı anda var olamıyor) restore edilmiş hedefe bağlanıp backup öncesi oluşturulan gerçek kullanıcıyla GERÇEKTEN giriş yapıyor, `/api/me` çağırıyor, doğru (ve TEK) şirkete üye olduğunu doğruluyor.

8. **Doğrulama:** `offline.test.ts` (3/3) + `backup-restore.test.ts` (1/1), tam paket **279/279** (0 regresyon). `pnpm exec tsc --noEmit` (api + web) temiz. Gerçek dev sunucusunda Playwright ile: `/help`'ten çevrimdışı kopya indirilip `/offline`'a gidildi (API ayaktayken doğru render edildi), ardından `page.route("**/api/**", route => route.abort(...))` ile **gerçek bir bağlantı kesintisi simüle edilip** sayfa yeniden yüklendi — sıfır ağ isteğiyle önbellekteki gerçek verilerden (görevler, 8 rol rehberi) doğru render ettiği ham sayfa metninden doğrulandı. Ayrıca manuel bir restore-drill script'i ile gerçek 5 şirket / 111 tablo / 2066 satırlık bir yedek alınıp ayrı bir hedef veritabanına geri yüklendi: `374 foreign key kısıtı kaldırıldı` → veri yüklendi → `374 foreign key kısıtı yeniden eklendi` → satır sayıları birebir eşleşti (2066=2066) → gerçek bir video ekinin sha256'sı doğrulandı → **GEÇTİ** (36.5 sn).

9. **RPO/RTO dürüstlük notu (W37 spesifikasyonuyla tutarlı):** W37'nin "başlangıç değerlendirme hedefi RPO en fazla 1 saat, RTO en fazla 4 saat" ifadesi ölçülmeden bir hizmet taahhüdü değildir. Bu oturumda ölçülen gerçek rakamlar — yedek alma ~28 sn, geri yükleme tatbikatı ~36.5 sn — bu geliştirme/sandbox ölçekli ortam için gerçek, ölçülmüş bir taban çizgisidir; W40'taki yük testi dürüstlük deseniyle aynı şekilde, üretim ölçeğinde (100.000+ bileşen, çok daha büyük veri hacmi) bu sürelerin doğrusal ölçeklenmeyeceği açıkça not edilir — üretim ölçeğinde gerçek bir ölçüm henüz **geliştirilmedi**.

10. **Bilinçli olarak kapsam dışı / kalan:** gerçek bir bulut nesne depolama sağlayıcısına (S3/benzeri) otomatik/zamanlanmış yedek yükleme yok (yedekler yerel diske yazılıyor — `BACKUP_DIR`); yedek rotasyonu/saklama süresi politikası (eski yedeklerin otomatik silinmesi) yok; coğrafi olarak ayrı bir DR (felaket kurtarma) bölgesi kapsam dışı — bunların hepsi gerçek bir bulut sağlayıcısı seçimi (dış bağımlılık) gerektiriyor.

## Oturum 39/40 devamı — R39: hazır akışlarla hızlı şirket kurulumu

**Bağlam:** kullanıcının "Kalan işlere devam et" talimatı (devam-talimatlari-2026-09.md'nin standart yönlendirmesi) üzerine, R37'nin tamamlanmasının ardından bırakılan "Sıradaki uygulanabilir iş" listesindeki öneri izlenerek R39 seçildi — dış bağımlılığı yok, ana talimatın §25 "Başlangıç" ekran grubuyla ("Şirket kurulumu, kullanıcı daveti, birimler, roller, veri yükleme, ilk üretim rehberi") somut şekilde tanımlı.

**Keşfedilen boşluk:** şirket oluşturmanın uygulamada GERÇEK bir yolu yoktu — yalnızca `db/seed.ts` migration/seed betiği, ayrıcalıklı `apis_owner` bağlantısıyla (RLS'yi atlayarak) çalışıyordu. Kullanıcı daveti (`/admin`), veri yükleme (`/imports`), ilk ürün (`/products`) ve ilk üretim rehberi (`/help`) zaten çalışan ekranlar olduğundan, R39'un gerçek/eksik kısmı yalnızca "kendi kendine şirket + ilk yönetici oluşturma" ve "gerçek ilerlemeyi gösteren bir başlangıç kontrol listesi" olarak kapsandı — dört mevcut ekran yeniden icat edilmedi (uydurma iş üretilmedi).

**RLS hata ayıklaması (asıl teknik zorluk):** `POST /api/setup/company` ilk sürümü her zaman `403` (RLS ihlali) döndürdü. `companies` tablosundaki tek politika (`company_visibility`, yalnızca `using(...)`) SELECT/UPDATE/DELETE/INSERT'in tümüne uygulanıp INSERT için de aynı "zaten üye olunan şirket" koşulunu WITH CHECK olarak dayatıyordu — yeni şirketin ilk INSERT'i yapısal olarak imkânsızdı (kısır döngü: üye olmak için şirket, şirket için üye gerekiyordu). Migration 047 ile INSERT'e özel, koşulsuz ayrı bir izin politikası (`company_self_signup_insert`, permissive, OR ile birleşir) eklendi — ama hata sürdü. Doğrudan `psql` ile ve bir deneme (scratch) tabloyla izole edilen kök neden: **`INSERT ... RETURNING`, dönen satırın SELECT-görünürlük politikalarını da (INSERT'in kendi WITH CHECK'inden bağımsız olarak) karşılamasını ister** — yeni şirket satırı henüz `company_visibility`'nin USING koşulunu karşılamadığından (üyelik yok, `app.company_id` atanmamış), `RETURNING id` bu ayrı SELECT-görünürlük kontrolünü tetikliyordu. Çözüm: `createCompany()` artık `id`'yi veritabanı varsayılanına (`gen_random_uuid()` + `RETURNING`) bırakmak yerine istemci tarafında `randomUUID()` ile üretip açıkça INSERT ediyor — `RETURNING` hiç gerekmiyor. Ayrıca kod okurken `users` tablosuna doğrudan INSERT'in migration 003 tarafından `apis_app` rolünden REVOKE edildiği fark edildi (proaktif); `createUser()` var olan `admin_ensure_user()` SECURITY DEFINER fonksiyonunu kullanacak şekilde yazıldı (aynı desen `admin.ts`'teki kullanıcı davetinde zaten vardı) — ikinci bir RLS/yetki hatası önceden önlendi.

**Uygulanan:** `POST /api/setup/company` (public/kimliksiz uç, `auth/login`'deki `public:true` deseniyle) — şirket adı/kodu + ilk yönetici adı/e-posta/parola alır (zod ile doğrular: kod 2-20 karakter büyük harf/rakam/tire), `createCompany`+`createUser`'ı (artık hem seed betiğinden hem uygulama havuzundan çağrılabilir ortak `Queryable` arayüzüyle) çağırıp hazır departman/rol/iş merkezi/konum şablonunu ve 30 günlük deneme aboneliğini (W42) uygular, kurucuyu `admin`+`manager` rolüyle üye yapar, `auth.ts`'teki login akışıyla aynı `signToken`+`sessions` deseniyle doğrudan oturum açtırır. Mükerrer şirket kodu → 409 `duplicate_code`; mükerrer yönetici e-postası → 409 `existing_account` (hangi parolanın geçerli sayılacağı uydurulmaz, kullanıcı "giriş yap"a yönlendirilir). `GET /api/setup/status` (kimlik doğrulamalı) gerçek satır sayılarından (`memberCount`, `departmentCount`, `importCount`, `productCount`, iş emri var mı) bir kontrol listesi döner — hiçbir adım sahte "tamamlandı" göstermez.

**Web:** `apps/web/src/pages/Setup.tsx` — `CompanySetupPage` (giriş ekranından "Yeni şirket oluştur" ile açılır, gerçek `POST /api/setup/company` çağrısı yapar, başarıda `auth.set(...)` ile otomatik oturum açar) ve `OnboardingPage` (`/onboarding`, kimlik doğrulamalı; `GET /api/setup/status`'tan okuduğu gerçek ilerlemeyi beş kartla gösterir, her kart ilgili mevcut ekrana — `/admin`, `/imports`, `/products`, `/help` — bağlantı verir). `App.tsx`'e `showSetup` durumu (router'sız giriş ekranı geçişi, `CompanyPicker` ile aynı desen) ve `/onboarding` route'u eklendi; `nav.onboarding` çeviri anahtarı (`packages/shared/src/i18n.ts`, TR: "Başlangıç", EN: "Getting started") eklendi.

**Doğrulama:** `setup.test.ts` (5/5 otomatik geçti — başarılı kurulum+oturum+rol+izin+şablon+abonelik, mükerrer kod reddi, mükerrer e-posta reddi, RLS ile şirketler arası tam izolasyon, geçersiz kod formatı reddi), tam paket **275/275** (0 regresyon, R47'nin hâlâ commit edilmemiş 4 testi dahil). `pnpm exec tsc --noEmit` (api + web) temiz, `vite build` başarılı. Gerçek (canlı) dev sunucusunda: `curl` ile `POST /api/setup/company` gerçek bir şirket+oturum döndürdü; ardından Playwright ile gerçek bir Chromium tarayıcısında (mock değil — dev ortamındaki Claude tarayıcı bağlantısı yalnızca kullanıcının kendi bilgisayarına eriştiğinden ve dev sunucuları bu bulut kapsayıcısında çalıştığından, uçtan uca doğrulama bu oturumda kurulan geçici bir Playwright betiğiyle yapıldı) giriş ekranından "Yeni şirket oluştur"a tıklanıp form dolduruldu, gönderildi, uygulamaya gerçekten otomatik giriş yapıldığı (sol menüde tüm ekranlar, "admin, manager" rolü) ve "Başlangıç" bağlantısına tıklanınca `/onboarding`'in gerçek ilerlemeyi (7/7 departman tamamlandı, 1 üye/0 içe aktarma/0 ürün bekliyor — tam olarak yeni kurulan şirketin gerçek durumu) gösterdiği ekran görüntüleriyle kanıtlandı.

**Bilinçli olarak kapsam dışı bırakılanlar:** e-posta doğrulama/hoş geldin e-postası (W39 kapsamında ayrı bir gereksinim değil, gerçek e-posta sağlayıcısı zaten dış bağımlılık); var olan bir şirkete ikinci bir kullanıcının davetle katılması (bu zaten `admin.ts`'te çalışıyor, R39'un kapsamı yeni şirket kurmak); kurulum sihirbazının kendi içinde adım adım (multi-step wizard) UI'ı — tek form + ayrı bir başlangıç kontrol listesi sayfası tercih edildi, çünkü asıl adımlar (davet/veri/ürün/rehber) zaten kendi ekranlarında var ve yeniden sarmalamak uydurma karmaşıklık eklerdi.

## Oturum 39/40 devamı — R37: tedarik riskinin sipariş ve termine etkisi

**Bağlam:** kullanıcı yine "devam et" dedi. `docs/kapsam-izleme.md`'deki "planlandı" satırları ana talimatın §10 bölümüyle karşılaştırıldı; dış bağımlılık/erişim kararı gerektirenler (R10/R11/R12/R26/R48) ve engineering-zaman altyapısı olmayan R05 elendi. R37 seçildi çünkü §10'da somut, tam belirtilmiş bir risk-kartı tanımı var (ne değişti? hangi kaynaktan? veri ne kadar taze? hangi proje/sipariş/üretim etkileniyor? ihtiyaç tarihine kaç adet açık? onaylı alternatif var mı? önerilen aksiyon/sorumlu/tarih nedir?) ve mevcut W17 (distribütör bağlayıcı) altyapısı üzerine sıfır yeni dış bağımlılıkla kurulabilecek durumdaydı.

1. **Tasarım öncesi kritik bir dürüstlük sorunu tespit edildi ve çözüldü:** Kod yazılmadan önce, mevcut TEST distribütör bağlayıcısının (`distributors.ts`'teki `syntheticOffer()`) MPN'den SHA-256 hash ile **deterministik** türediği fark edildi — aynı MPN + bağlayıcı her zaman aynı stok/fiyat/temin süresini verir. Bu, iki-anlık-görüntü karşılaştırmasına dayanan risk tiplerinin (stok düşüşü, fiyat artışı, temin uzaması) saf TEST tekrar taramalarında **hiçbir zaman tetiklenemeyeceği** anlamına geliyordu — çünkü gerçekten hiçbir şey değişmiyor. Bunu "düzeltmek" için sahte bir tarihsel değişkenlik enjekte etmek, projenin "gerçekleşmeyen bir hareketi asla uydurma" ilkesini doğrudan ihlal ederdi. Çözüm: risk tiplerini mimari olarak ikiye ayırmak — (a) **tek anlık görüntülü** riskler (kaynakta stok yok, yaşam döngüsü riski) gerçek, MPN'e göre değişen TEST verisinden dürüstçe tespit edilebilir; (b) **iki anlık görüntülü** riskler yalnızca gerçek, zaten var olan `price_file` bağlayıcı modu (zaman içinde güncellenmiş bir CSV fiyat listesinin yeniden yüklenmesi) üzerinden dürüstçe gösterilebilir. Bu gerekçe kodda (migration başlığı) ve UI'da (`SupplyRisk.tsx`'teki `notice info`) açıkça belgelendi.
2. **Şema (migration 046)**: `supply_risk_settings` (company_id PK, `enabled`, `stock_drop_pct` varsayılan %50, `price_increase_pct` varsayılan %20, `lead_time_increase_days` varsayılan 10 gün, `scan_frequency_hours` varsayılan 24, `last_scanned_at`) ve `supply_risks` (id, company_id, item_id, connector_id, `risk_type` CHECK 5 değer, `severity` CHECK warning/critical, `status` CHECK open/resolved, `previous_snapshot`/`current_snapshot` jsonb, `change_summary`, `source_fetched_at`, `open_request_qty`, `open_po_qty`, `earliest_need_date`, `has_approved_alternate`, `recommended_action`, `responsible_role`, `detected_at`, `resolved_at`, `resolved_reason`, `escalated_task_opened`). Dedup için kısmi tekil indeks: `unique (company_id, item_id, risk_type) where status = 'open'`, `ON CONFLICT ... DO UPDATE` ile birleştirilmiş. RLS standart desenle (`force row level security` dahil), izinler mevcut `role_permissions` retrofit döngüsüyle (R04'teki aynı desen) `purchasing`/`manager` rollerine geriye dönük eklendi.
3. **Tarama mantığı (`supply-risk.ts`, `runSupplyRiskScan`)**: `part_offers` tablosundaki (W17'den beri var, her yenileme/yükleme yeni satır ekler — güncelleme değil, dolayısıyla zaten tarihsel anlık görüntü) en son iki kayıt karşılaştırılır. Her kalem için: kaynakta hiçbir bağlayıcıda stok yoksa `no_source_stock`; yaşam döngüsü `eol`/`nrnd` ise `lifecycle_risk`; önceki/şimdiki anlık görüntü arasında eşiği aşan stok düşüşü/fiyat artışı/temin uzaması varsa ilgili tip. Açık talep (`purchase_requests`) ve açık sipariş (`purchase_order_lines`) miktarları, en yakın ihtiyaç tarihi ve onaylı alternatif (`item_alternates`, karar `approved`) gerçek verilerden hesaplanır — hiçbiri tahmin/varsayım değil. Kritik + açık talep/sipariş varsa purchasing'e (yaşam döngüsü riskinde rd'ye) görev açılır (`openTask()`, idempotent upsert). Her taramadan sonra, önceki taramada açık olup bu turda yeniden tetiklenmeyen riskler otomatik `resolved` (`resolved_reason='otomatik: yeniden taramada eşik altında kaldı'`) olur ve açık görevleri kapatılır.
4. **API (5 uç)**: `GET/POST /api/supply-risk-settings` (görüntüleme `purchase.view`, düzenleme yeni `supply.risk.manage`), `POST /api/supply-risks/scan` (elle tetikleme, `force:true`), `GET /api/supply-risks?status=open|resolved|all`, `GET /api/supply-risks/:id`, `POST /api/supply-risks/:id/resolve` (gerekçe zorunlu, min 3 karakter). Yeni izin `supply.risk.manage` — `purchasing` ve `manager` rollerine varsayılan olarak eklendi.
5. **Otomasyon**: `runSupplyRiskScan()` mevcut `worker/outbox.ts`'nin 60 saniyelik `escalate()` döngüsüne eklendi (aynı yerde çalışan `runEscalations()`/`runPoFollowups()`/`runCollectionReminders()` ile birlikte) — tarama sıklığı ayarına göre kendiliğinden çalışır, elle "şimdi tara" ile de zorlanabilir.
6. **Web** (`/purchasing/supply-risk`, yeni 7. sekme `Procurement.tsx`'te): ayarlar formu (eşikler, tarama sıklığı, etkin/pasif, "Şimdi tara" butonu, tarama özeti), açık/çözüldü/tümü filtreli risk kartı listesi (her kart: kalem, MPN/üretici, önem/durum rozetleri, değişim özeti, kaynak tazeliği, açık talep/sipariş/ihtiyaç tarihi/alternatif/sorumlu, önerilen aksiyon, manuel çözme formu), ve TEST-determinizm dürüstlük notu.
7. **Testler** (`supply-risk.test.ts`, 7 test): ayarlar varsayılanı + yetki (rd görüntüler, sales düzenleyemez, purchasing düzenler); gerçek açık satın alma talebiyle `no_source_stock` tespiti + kritik önem + purchasing'e eskalasyon; `lifecycle_risk` tespiti + rd'ye eskalasyon + gerçek `/api/alternates` propose/decide akışıyla onaylı alternatifin önerilen aksiyon metnini değiştirmesi; teknisyen rolünün 403 alması (purchase.view yok); `stock_drop` iki-anlık-görüntü karşılaştırması (eşik altı tetiklenmiyor, eşik üstü tetikleniyor, yeniden taramada dedup, iyileşmede otomatik `resolved` + gerekçe `/otomatik/` eşleşiyor); manuel çözme ucu (yetkisiz 403, kısa gerekçe 400, geçerli 200 + bağlı görevin kapanması). `pnpm --filter @apisfactory/api exec tsc --noEmit` ve web tsc temiz; tam paket **270/270** (yeni 7 + önceki 263, sıfır regresyon).
8. **Doğrulama — gerçek (canlı) dev sunucusu**: yerel Postgres + `tsx watch` API + Vite web başlatıldı, migration 046 gerçekten uygulandı. DigiKey bağlayıcısı TEST moduna, Farnell `price_file` moduna alındı; `CMP-LDO-01` (DemoPower DP3301-33) için gerçek bir CSV fiyat listesi **iki kez sırayla** yeniden yüklendi (ikinci yüklemede stok/fiyat/temin süresi kasıtlı olarak değiştirilmiş gerçek bir dosya — fabrikasyon veritabanı satırı değil, gerçek dosya yükleme akışı); iki gerçek açık satın alma talebi oluşturuldu. `POST /api/supply-risks/scan` çalıştırıldı: `{scanned:7, detected:4, resolved:0, escalated:4}` döndü. `GET /api/supply-risks?status=open` ile 4 risk tipinin (kaynakta stok yok — gerçek bir DEMO kalemin deterministik TEST anlık görüntüsünde stok=0 çıkması, stok düşüşü %90, fiyat artışı %50, temin süresi +15 gün) doğru değişim özetleriyle ve kritik önemle (gerçek açık talep + yakın ihtiyaç tarihi nedeniyle) göründüğü doğrulandı; `GET /api/tasks/mine` ile gerçek eskalasyon görevlerinin purchasing/rd'ye açıldığı görüldü; yeniden tarama ile dedup (aynı sayıda risk, tekrar açılmıyor) doğrulandı; bir riskin manuel çözülüp bağlı görevin `done` durumuna geçtiği doğrulandı. Son olarak **gerçek tarayıcıda** (yerel Chromium, Playwright) `/purchasing/supply-risk` ekran görüntüsüyle doğrulandı — ayarlar paneli (eşikler, son tarama zamanı, "Şimdi tara"), 3 açık risk kartı (temin süresi uzaması, fiyat artışı, stok düşüşü — hepsi kritik rozetli, gerçek değişim özeti, kaynak tarihli, açık talep/sipariş/ihtiyaç tarihi/alternatif/sorumlu alanlarıyla, çözme formu) ve üstteki dürüstlük notu doğru render edildi. Dev sunucuları iş bitince durduruldu.
9. **Bilinçli olarak kapsam dışı**: gerçek distribütör API'si hâlâ yok (R10/R11 dış bağımlılık bekliyor — bu turda değişmedi); tarama özetindeki `escalated` sayacı her turda dokunulan (idempotent olarak güncellenen) kritik risk sayısını gösterir, yalnızca "bu turda yeni yükseltilen" değil — davranışsal olarak doğru (görev güncel kalır) ama alan adının ima ettiğinden farklı bir anlam taşıyabilir, ileride netleştirilebilir küçük bir dokümantasyon notu.

## Oturum 39 devamı — R44: saha arızasının fiziksel iade akışından ayrılması

**Bağlam:** kullanıcı R47'yi (şirket veri çıkış paketi) "şimdilik kalsın" diyerek beklemeye aldıktan sonra, kapsam izleme dokümanı taranarak (`claude/apisfactory_Ana_Gelistirme_Promptu.md`, `docs/kapsam-izleme.md`) engellenmemiş, gerçek bir sonraki iş arandı. R44 satırı "planlandı" ve notu "Saha arızası kaydı yok (W34)" diyordu — ama `returns.ts` (W34, oturum 5) okunduğunda `rmas.kind` sütununun `'field_failure'` değerini migration 011'den beri desteklediği, sadece **akışın hiç ayrışmadığı** görüldü: her iade türü (return/warranty/field_failure fark etmeksizin) aynı zorunlu "teslim al → incele → karar (5 fiziksel sonuçtan biri, hepsi stok hareketi üretir)" akışından geçiyordu. Saha arızasında cihaz müşteride kalır, fiziksel olarak geri gelmez — bu yüzden eski akış saha arızası için ya imkânsız bir durum (bulunmayan konumdan stok hareketi) ya da **UYDURMA bir "iade kabul edildi" hareketi** üretiyordu. Bu, oturum boyunca tekrarlanan "gerçekleşmeyen veri/hareket asla uydurulmaz" ilkesine doğrudan aykırı, gerçek ve somut bir açık; yeni bir özellik değil, mevcut modülün düzeltilmesiydi.

1. **Akış (migration 043 + `returns.ts`)**:
   - Saha arızası açılışında (`POST /api/rmas`) depoya "teslim al" görevi değil, doğrudan kaliteye "incele" görevi açılır.
   - `POST /api/rmas/:id/receive` saha arızasında `not_applicable` hatasıyla reddedilir ("cihaz müşteride kalır; doğrudan inceleme yapılır").
   - `POST /api/rmas/:id/inspect` saha arızasında `open` durumundan doğrudan yapılabilir (normal akışta `received` şartı aranır).
   - `POST /api/rmas/:id/decide`: saha arızasında yalnızca iki yeni, **hareketsiz** sonuç kabul edilir — `logged_no_action` (uzaktan/yerinde çözüldü, stok/cihaz hareketi yok, kayıt kapanır) ve `escalated_to_rma` (müşteri cihazı göndermeyi kabul ederse gerçek bir `kind='return'` kaydı açılır, müşteri/cihaz/lot/miktar/sevkiyat/garanti bilgileri kopyalanır, orijinal saha arızası `escalated_rma_id` ile buna bağlanıp kapatılır — yükseltilen kayıt normal fiziksel akışla devam eder). Klasik 5 fiziksel sonuç (olduğu gibi iade/tamir/değişim/hurda/stoğa al) saha arızasında `field_failure_disposition` ile reddedilir; yeni iki sonuç da fiziksel iadelerde aynı hatayla reddedilir.
   - Migration 043: `rmas_disposition_check` kısıtına iki yeni değer eklendi, `escalated_rma_id` (self-referencing FK) sütunu eklendi.
2. **Aynı işlem içinde tutarlılık**: yükseltme, orijinal kaydı yeni satır eklenmeden önce `closed` işaretler (aksi halde `rmas_one_open_per_device` kısıtına takılır — aynı cihaz için iki "açık" RMA aynı anda var olamaz); genel karar güncellemesi zaten durumu tekrar `closed` yazdığı için sorun teşkil etmez.
3. **Web** (`Returns.tsx`): karar `<select>` seçenekleri türe göre filtrelenir (saha arızasında yalnızca 2 yeni seçenek, fiziksel iadede yalnızca 5 klasik seçenek); "Teslim al" butonu saha arızasında gizlenir, yerine bilgi notu gösterilir; inceleme formu saha arızasında `open` durumunda da açılır; yükseltilen kayda tıklanabilir bağlantı ("Karar: Gerçek iadeye yükselt ... IAD-000004'e yükseltildi") gösterilir.
4. **Testler**: yeni `field-failure.test.ts` (4 test) — teslim almanın reddi + cihaz durumunun değişmediği, `open`dan doğrudan inceleme, 5 fiziksel sonucun saha arızasında reddi, `logged_no_action`'ın stok/cihaz hareketi üretmediği (öncesi/sonrası stok durumu birebir eşit), `escalated_to_rma`'nın yeni kaydı açıp bağladığı ve yükseltilen kaydın normal teslim alma akışına girebildiği. `returns.test.ts`'de daha önce **yanlışlıkla `field_failure` ile etiketlenmiş** bir test (aslında müşteri-hasarı + teslim al + olduğu gibi iade senaryosunu sınıyordu, bu düzeltmeyle artık saha arızasında geçersiz olurdu) `kind: "return"`e düzeltildi — bu, düzeltmenin kendisinin daha önce fark edilmemiş bir test kusurunu da ortaya çıkardığının kanıtı.
5. **Doğrulama**: migration 043 dev veritabanına uygulandı; `pnpm -r exec tsc --noEmit` (API + web) temiz; `vite build` temiz; tam test paketi **248/248** geçti (sınıflandırıcı engeli bu turda yaşanmadı). Ayrıca **gerçek dev sunucusu** (yerel `tsx watch` API + Vite web, aynı yerel Postgres, mock/test harness değil) başlatılıp gerçek bir ürün/BOM/revizyon/iş emri/sevkiyat üretildi, ardından curl ile: saha arızası açıldı → teslim alma denemesi `not_applicable` ile reddedildi (cihaz durumu "shipped" kaldı) → inceleme `open`dan yapıldı → `logged_no_action` ile kapatıldı (cihaz durumu hâlâ "shipped", hiçbir stok hareketi oluşmadı) — ikinci bir saha arızasında `escalated_to_rma` denendi, yeni `IAD-000004` (`kind: return`) kaydı gerçekten açıldı ve orijinale bağlandı. Gerçek tarayıcıda (yerel Chromium, Playwright) `/returns` listesi ve ilgili kayıtların ayrıntı sayfaları (yeni disposition etiketleri, yükseltme bağlantısı) ekran görüntüsüyle doğrulandı. Sunucular iş bitince durduruldu.
6. **Bilinçli olarak kapsam dışı / kalan**: serisiz (lot bazlı) saha arızası senaryosu ayrıca test edilmedi (kod yolu seri/lot ayrımı yapmıyor, aynı `rma.kind` kontrolü her ikisinde de geçerli, ama açık bir test yok); yükseltilen kayıt sonrası iki RMA'nın işlem geçmişi ayrı tutuluyor, birleşik bir zaman çizelgesi yok (her ikisi de birbirine bağlantı ile erişilebilir, veri kaybı yok).

## Oturum 39 devamı — R21: vadeli tahsilat ve müşteri/muhasebe hatırlatması

**Bağlam:** R44 teslim edildikten sonra kullanıcı yine "devam et" dedi. `docs/kapsam-izleme.md`'deki tüm "planlandı" satırları tarandı ve ana talimat dokümanıyla (§17) karşılaştırıldı; dış bağımlılık gerektirenler (R12 AI, R26 sesli/görüntülü, R48 entegrasyonlar) elendi. R21 seçildi çünkü mevcut alacak (AR) modülünün (`receivables.ts` — yaşlandırma, kredi riski) üzerine, mevcut outbox/görev/olay altyapısıyla sıfır yeni dış bağımlılıkla kurulabilecek, kendi kendine yeten bir otomasyon özelliğiydi.

1. **Tasarım** (`collections.ts`, migration 044): `procurement.ts`'deki `runPoFollowups()` deseni izlendi — periyodik, şirket başına çalışan bir tarama fonksiyonu (`runCollectionReminders`), `worker/outbox.ts`'nin mevcut 60 saniyelik `escalate()` döngüsüne eklendi (aynı yerde çalışan `runEscalations()`/`runPoFollowups()` ile birlikte). Şirket başına **tek kural** (`collection_reminder_rules.company_id` unique, `on conflict` upsert) — promptun tekil "tanımlı kuralla" ifadesiyle uyumlu, versiyonlu/çoklu kural sistemi kurulmadı (bilinçli basitleştirme).
2. **"Gönderimden hemen önce yeniden doğrulama" (prompt §17)**: tek bir sorguda `for update of ci skip locked` ile satır kilitlenip seçilir, ardından döngü içinde açık bakiye (`gross - received`) yeniden hesaplanıp `<= 0.005` ise atlanır — bu, seçim anı ile gönderim anı arasında bir tahsilat kaydı girilmiş olma ihtimaline karşı yapısal bir korumadır.
3. **"Ödenmiş faturaya asla gitmez" (prompt §17)**: yapısal olarak garanti edilir — taban sorgu yalnızca `status='issued'` seçer (taslak/ödenmiş/iptal hariç), üstüne döngü içindeki açık bakiye kontrolü ikinci bir güvenlik katmanıdır.
4. **"Durdurma koşulu" (prompt §17)**: iki mekanizma — (a) otomatik: `max_reminders`'a ulaşınca `reminders_paused=true` + otomatik gerekçe; (b) elle: `POST /api/customer-invoices/:id/reminders/pause` ile muhasebe gerekçeyle duraklatıp devam ettirebilir (ör. müşteri itirazı) — projenin genelindeki "uyuşmazlık açık inceleme olmadan kapatılmasın" ilkesiyle tutarlı.
5. **Alıcı**: "muhasebe" ise mevcut `openTask()` upsert deseniyle (`po_followup` ile aynı) iç görev açılır (`kind='ar_reminder'`); "müşteri" ise gerçek e-posta gönderimi yok — mevcut outbox test bağlayıcısına (`enqueue()`) `mode:'test'` ile yazılır, müşterinin `billing_email`'i tanımlı değilse `emailMissing:true` ile **açıkça** işaretlenir (sessizce başarılı gösterilmez — projenin "mock'u gerçek entegrasyon gibi göstermeme" ilkesi). `customers.billing_email` bu iş için yeni eklenen bir sütun; küçük, amaca özel bir uç (`POST /api/customers/:id/billing-email`) ile okunup yazılır — tam müşteri düzenleme özelliği kurulmadı.
6. **Denetim/görünürlük**: yeni bir "hatırlatma listesi" ekranı kurulmadı — mevcut genel `History` bileşeni zaten `customer_invoice` olaylarını gösterdiğinden, `reminder.sent`/`reminder.paused`/`reminder.resumed` olayları otomatik olarak fatura detay sayfasındaki işlem geçmişinde görünür.
7. **İzinler**: yeni bir izin eklenmedi — mevcut `receivable.view`/`receivable.manage` kullanıldı (muhasebe rolünde ikisi de var; satış/yönetici yalnızca görüntüler).
8. **Web** (`Receivables.tsx`): `CustomerInvoicePage`'de fatura `issued` durumundayken "Tahsilat hatırlatması" paneli (gönderim sayısı, son gönderim, duraklat/devam formu); `ReceivablesAgingPage`'de "Tahsilat hatırlatma kuralı" kartı (etkin/pasif, gecikme/sıklık/azami sayı, alıcı, şablon, "Kuralı kaydet" ve "Şimdi çalıştır" butonları) ve kredi formuna fatura e-postası alanı eklendi.
9. **Testler** (`collections.test.ts`, 6 test): kural varsayılanı + yetki (satışın kural değiştirememesi); kural kaydı; vadesi geçmiş faturaya hatırlatma + iç görev + `reminder.sent` olayı + sıklık limiti (hemen tekrar taramada gönderilmemesi) + azami sayıda (2) otomatik durdurma + durdurulduktan sonra bir daha gönderilmemesi (tümü `last_reminder_at`'i elle geriye alarak, gerçek zaman beklemeden simüle edildi); ödenmiş faturaya asla gitmemesi; elle duraklat/devam ettirme (yetki dahil); alıcı "müşteri" iken outbox'a yazma + `billing_email` yoksa `emailMissing` + `billing_email` varsa gerçek e-posta ve doğru şablon render'ı. `pnpm --filter @apisfactory/api exec tsc --noEmit` ve web tsc temiz; tam paket **254/254** geçti (yeni 6 test + mevcut 248, `field-failure.test.ts`'deki daha önce fark edilmemiş bir tip hatası da bu turda düzeltildi — bkz. aşağıda).
10. **Karşılaşılan ve düzeltilen hata**: ilk testte `GET /api/receivables/reminder-rule` 500 döndü. Kök neden: `loadRule()`'daki `select id, ...` sorgusu, `collection_reminder_rules r left join users u` içinde hem `r.id` hem `u.id` var olduğu için "column reference id is ambiguous" hatası veriyordu — logger açık gerçek bir debug script'iyle (`tsx`, doğrudan `buildApp`) kesin hata mesajı görülüp `r.id`/`r.company_id` şeklinde nitelendi. Ayrıca `field-failure.test.ts`'deki yerel `deviceStatus` yardımcı fonksiyonunun parametre tipi (`string` yerine `string | undefined` olmalıydı, `returns.test.ts`'deki eşdeğeriyle tutarsızdı) düzeltildi — bu, önceden commit edilmiş R44'te (`376dc7c`) fark edilmemiş, gerçek bir tip hatasıydı.
11. **Doğrulama — gerçek (canlı) dev sunucusu**: yerel Postgres + `tsx watch` API + Vite web başlatıldı (mock/test harness değil). DEMO şirketinde sıfırdan bir ürün oluşturulup BOM içe aktarılıp yayımlandı, revizyon rd/üretim/kalite onaylarından geçirilip yayımlandı (`released`); gerçek bir satış siparişi verilip kesinleştirildi, sevkiyat kaydı ve kalemi eklendi, sevkiyattan fatura kesilip **40 gün önceki bir tarihle** (`invoiceDate`) resmileştirildi — API bunu doğru şekilde `overdue:true`, 10 gün gecikmiş olarak hesapladı. Ardından: kural `{enabled:true, minOverdueDays:1, frequencyDays:7, recipient:'both', maxReminders:3}` ile kaydedildi; `POST /api/receivables/reminders/run` **gerçekten** çalıştırılıp `sent:2` döndü (yeni fatura + ortamda zaten duran eski bir gecikmiş test faturası, ikisi de doğru seçildi); faturanın `reminderCount`, `lastReminderAt` gerçekten güncellendi; muhasebe rolüne gerçek bir `ar_reminder` görevi açıldığı `GET /api/tasks` ile, `reminder.sent` olayının gerçekten kaydedildiği `GET /api/history/...` ile, outbox'a gerçekten yazıldığı (doğru render edilmiş mesaj, `emailMissing:true` çünkü `billing_email` henüz tanımlı değildi) doğrudan veritabanı sorgusuyla doğrulandı. Ardından `billing_email` gerçekten kaydedildi, elle duraklatma/devam ettirme uçları gerçekten çağrılıp (`reminders_paused` alanı ve gerekçesi doğru güncellendi, tekrar taramada `sent:0` döndüğü doğrulandı) devam ettirildi. Son olarak **gerçek tarayıcıda** (yerel Chromium, Playwright ile) `/receivables/aging` (kural kartı, kaydedilmiş değerlerle) ve `/receivables/:id` (hatırlatma paneli + tam işlem geçmişi: `draft_created → issued → reminder.sent → reminder.paused → reminder.resumed`, gerekçeleriyle) ekran görüntüsüyle doğrulandı. Dev sunucuları iş bitince durduruldu.
12. **Bilinçli olarak kapsam dışı / dış bağımlılık bekliyor**: gerçek e-posta/SMS gönderimi yok (proje genelindeki outbox test-bağlayıcı deseniyle tutarlı — sağlayıcı seçilip bağlanınca eklenecek); tek kural/şirket (kanal veya müşteri bazlı farklılaştırılmış kural yok); sıklık gün bazlı, saat/iş günü hassasiyeti yok.

## Oturum 39 devamı — R04: Ar-Ge alımının proje ve muhasebeyle bağlantısı

**Bağlam:** kullanıcı "devam et" dedi. `docs/kapsam-izleme.md`'deki "planlandı" satırları ana talimatın §3 bölümüyle karşılaştırıldı; dış bağımlılık gerektirenler (R12 AI, R26 sesli/görüntülü, R48 entegrasyonlar) elendi. R04 seçildi çünkü mevcut satın alma talebi akışının (`workflow.ts`) ve stok uygunluğu hesabının (`sales.ts`'teki `freeQty()`) üzerine, sıfır yeni dış bağımlılıkla kurulabilecek, promptun §3 metnindeki beş somut gereksinimi (proje/MPN-veya-tanımlı-genel-ihtiyaç, miktar, gerekçe, ihtiyaç tarihi, maliyet merkezi; önce stoktan karşılama; muhasebe izlenebilirliği; ortak gider paylaştırma) doğrudan karşılayan bir özellikti. R05 (Ar-Ge maliyetinin devir anında görünmesi) bilinçli olarak bu turdan **ayrı bırakıldı** — mühendislik-zamanı takibi hiçbir yerde yok, ayrı bir iş paketi gerektirir.

1. **Tasarım** (`rd-projects.ts`, migration 045): yeni `rd_projects` tablosu (kod `PRJ-######`, ad, maliyet merkezi, bütçe tutarı + para birimi — ikisi de opsiyonel, bütçesiz proje de açılabilir, sahip, durum `open`/`closed`, kapatma gerekçesi) ve `project_cost_allocations` (proje, tutar, para birimi, açıklama, kaynak referansı, **zorunlu** gerekçe, kim/ne zaman). `purchase_requests`e `project_id` (FK, nullable) ve `cost_center` (nullable) sütunları eklendi — mevcut `source_type`/`source_id` alanları (zaten `rd_project` değerini destekliyordu ama hiç kullanılmıyordu) kasıtlı olarak **kullanılmadı**: `unique(company_id, source_type, source_id, item_id)` kısıtı aynı proje+kalem için tekrar talebi engelleyecekti.
2. **"Önce mevcut stoktan karşılama" (prompt §3)**: `POST /api/purchase-requests`e `projectId` verildiğinde, mevcut `freeQty()` (kullanılabilir konum bakiyesi eksi aktif rezervasyonlar) ile serbest stok okunur; `min(istenen, serbest)` kadarı "stoktan karşılandı" sayılır, yalnızca kalan miktar (`istenen - karşılanan`) satın alma talebine dönüşür. Kalan sıfırsa **hiç satın alma talebi açılmaz** — yalnızca `material_request.covered_by_stock` olay kaydı düşer ve `covered:true` ile açıkça bildirilir (uydurma bir "0 miktarlık talep" oluşturulmaz). **`projectId` verilmezse davranış eskisiyle bit bit aynı kalır** — bu, `workflow.test.ts`'in stoklu bir kaleme (`costedItem`) karşı kesin miktar/tahmin varsayan ~10 testini bozmamak için bilinçli bir kapsam sınırlamasıydı; stok-netleştirme yalnızca proje bağlandığında devreye giriyor.
3. **"Proje, MPN veya tanımlı genel ihtiyaç" (prompt §3)**: şema değişikliği gerekmedi — `items.mpn`/`items.manufacturer` zaten nullable'dı ve `POST /api/items` zaten MPN'siz genel kalem oluşturmayı destekliyordu; R04 yalnızca bu mevcut yeteneği projeyle ilişkilendirdi.
4. **Muhasebe izlenebilirliği (prompt §3)**: `loadProject()` (`rd-projects.ts`), migration 019'dan beri var olan gerçek `purchase_order_lines.purchase_request_id` bağını `purchase_requests.project_id` ile birleştirerek projeye bağlı **gerçek** sipariş edilen/teslim alınan tutarı hesaplar — hiçbir tahmini/kestirimsel bağlantı yok. Toplamlar, projenin genelindeki alacak/borç yaşlandırma desenindeki gibi **para birimine göre ayrı** tutulur, asla dönüştürülmez.
5. **Ortak gider paylaştırma (prompt §3 "ortak alım ve giderler paylaştırılsın")**: otomatik/oransal bir bölüştürme algoritması **bilinçli olarak kurulmadı** — bu, insanın vermesi gereken bir kararı UYDURMAK olurdu (projenin "gerçekleşmeyen bir kararı asla uydurma" ilkesi, R21/R44'te de görülen desen). Bunun yerine muhasebe (`cost.manage` izni) elle, gerekçeli bir kayıt ekler; bu kayıt **değiştirilemez ve silinemez** (`forbid_mutation()` veritabanı tetikleyicisi — audit-log benzeri, kalıcı bir defter).
6. **İzinler**: `rd.project.manage` (Ar-Ge, yönetici), `rd.project.view` (Ar-Ge, yönetici, muhasebe) — `packages/shared/src/permissions.ts`, mevcut şirketlerin varsayılan rollerine retrofit migration döngüsüyle eklendi (R47/W42'de kullanılan aynı desen).
7. **Web**: yeni `/rd-projects` (liste + oluşturma) ve `/rd-projects/:id` (bütçe durumu, para birimine göre harcama tablosu, bağlı satın alma talepleri, ortak gider ekleme formu, kapatma) sayfaları; `Purchasing.tsx`de talep listesine "Proje / maliyet merkezi" sütunu ve yeni talep formuna proje seçici + maliyet merkezi alanı eklendi (proje seçilince maliyet merkezinin projeden miras alınacağı belirtiliyor).
8. **Testler** (`rd-projects.test.ts`, 9 test): proje CRUD + yetki; stok-netleştirme (kısmi/tam/hiç); gerçek harcama izlenebilirliği (RFQ→teklif→ödül zincirinden); elle ortak gider ekleme; proje kapatma; kapalı projede yeni talep/gider reddi; yönetici raporu bağlantısı (açıkken `hypothesis`, kapandıktan sonra `insufficient_data`'ya döner — rapor yalnızca `status='open'` projeleri sayar). `pnpm --filter @apisfactory/api exec tsc --noEmit` ve web tsc temiz; tam paket **263/263** (yeni 9 test + önceki 254, sıfır regresyon).
9. **Karşılaşılan ve düzeltilen hatalar**: (a) `rd-projects.ts`de `type Db = Parameters<typeof loadProject>[0]` ile döngüsel bir ileri-referans yazılmıştı — `import type { Db } from "../db/pool"` ile düzeltildi. (b) `loadProject()`de aynı R21'deki gibi bir "ambiguous column" hatası — `select id, ...`, `rd_projects p left join users u` içinde hem `p.id` hem `u.id` olduğundan — yine logger açık bir `tsx` debug script'iyle kesin hata görülüp tüm sütunlar `p.` ile nitelendi. (c) test dosyasında üç küçük hata: `/api/reports/generate`'in `finding` metnini doğrudan döndürmediği (ayrı `GET /api/reports/findings/:id` çağrısı eklendi), `reason` alanının `min(3)` doğrulamasından önce reddedilen 1 karakterlik bir test girdisi, ve rapor-bağlantısı testinin proje kapatıldıktan sonra çalıştığı için yanlış sonuç bekleyen bir sıralama hatası (testler yeniden sıralanarak düzeltildi).
10. **Doğrulama — gerçek (canlı) dev sunucusu**: yerel Postgres + `tsx watch` API + Vite web başlatıldı, migration 045 gerçekten uygulandı (mock/test harness değil). DEMO şirketinde Ar-Ge rolüyle gerçek bir proje açıldı (500 TRY bütçe); **kısmi stok karşılama** gerçekten denendi (25 adet stoklu bir kalemden 40 adet istenip 25'i stoktan karşılandı, 15'i satın almaya yönlendi — API yanıtı doğrulandı); **tam yönlendirme** denendi (0 stoklu bir kalemden 20 adet, tamamı satın almaya gitti); **tam stoktan karşılama** denendi (10 adet istenip stokta 25+ varken hiç satın alma talebi açılmadı, `covered:true` döndü); **projesiz normal talep** ile eski davranışın bit bit aynı kaldığı doğrulandı. Onaylanan talep gerçek bir RFQ'ya dönüştürülüp gerçek bir tedarikçiye gerçek bir teklif (12.50 TRY/adet × 20) girilip ödüllendirildi — gerçek bir satın alma siparişi (250 TRY) oluştu; proje detayında bu tutar **gerçekten** göründü (`spendByCurrency`, bütçe 500 → harcanan 250 → kalan 250). Muhasebe rolüyle gerçek bir ortak gider kaydı (75 TRY, gerekçeli) eklendi — toplam harcama 325 TRY'ye, kalan bütçe 175 TRY'ye güncellendi. Yönetici raporu **gerçekten** çalıştırıldı: `project_budget` bulgusu artık gerçek verilerle "bütçenin %65'i" diyen, olası neden + alternatif açıklama içeren, `causeType:"hypothesis"` bir kayıt üretti (`GET /api/reports/findings/:id` ile tam içerik doğrulandı — kaynak referansları `rd_projects`/`purchase_order_lines`/`project_cost_allocations` gösteriyor, UYDURULMUŞ bir yorum değil). Proje gerçekten kapatıldı; kapalı projeye yeni satın alma talebi ve yeni ortak gider denemesi ikisi de `project_closed` ile gerçekten reddedildi; rapor tekrar çalıştırıldığında `project_budget` doğru şekilde `insufficient_data`'ya döndü (kapalı proje artık sayılmıyor). Son olarak **gerçek tarayıcıda** (yerel Chromium, Playwright) `/rd-projects` (liste, kapalı durum rozeti), `/rd-projects/:id` (bütçe/harcama/talep/ortak gider tabloları, gerçek verilerle) ve `/purchasing` (yeni proje/maliyet merkezi sütunu, gerçek verilerle) ekran görüntüsüyle doğrulandı. Dev sunucuları iş bitince durduruldu.
11. **Bilinçli olarak kapsam dışı**: R05 (Ar-Ge maliyetinin devir anında muhasebeye görünmesi) — mühendislik-zamanı takibi hiç yok, ayrı bir iş paketi. Otomatik/oransal ortak gider paylaştırma — insan kararını uydurmamak için bilinçli olarak elle bırakıldı. Kur dönüşümü yok (projenin genelindeki desenle tutarlı — farklı para birimli harcamalar ayrı satırlarda kalır, toplanmaz).

## Oturum 39 devamı — W42: SaaS abonelik ve şirket yaşam döngüsü

**Kapsam kararı (kullanıcıya soruldu, bağlayıcı):** W42, ana talimat dokümanının §12 sıralamasına göre W39'dan sonraki sıradaki iş olarak seçildi. Bu, önceki W39 alt kalemlerinden (AP/PO/AR/iş emri tarihsel geçişi) farklı bir nitelikte bir tasarım kararı gerektiriyordu — iç veri modelleme/uydurma-önleme kararı değil, **yeni bir şirketler-arası (cross-tenant) yetki sınırı** açılıp açılmayacağı kararı. Bu fark nedeniyle, önceki kalemlerin aksine, karar tek taraflı verilmedi; kullanıcıya üç seçenek sunuldu: (a) her şirketin kendi admin'i kendi aboneliğini yönetsin (yeni cross-tenant yüzey yok) — önerilen, (b) yeni bir cross-tenant "platform operatörü" rolü inşa edilsin, (c) W42 şimdilik atlansın. **Kullanıcı (a)'yı seçti.** Bu nedenle W42'nin tamamı, mevcut şirket içi (RLS ile sınırlı) rol yapısı içinde, hiçbir yeni şirketler-arası ekran veya rol eklenmeden uygulandı.

1. **Şema (migration 041)**: `subscription_plans` (platform genelinde paylaşılan, salt okunur referans veri — deneme/başlangıç/büyüme, kullanıcı ve bileşen limiti, AI/video hakkı); `companies` tablosuna `subscription_plan_id`, `subscription_status` (CHECK: trial/active/delinquent/restricted/cancelled), `subscription_status_reason`, `subscription_status_changed_at`, `trial_ends_at`; `subscription_events` (durum/paket değişikliği ve ödeme kaydı denetim izi, RLS ile şirkete kilitli). Migration çalıştığı anda var olan (mevcut/demo) şirketler otomatik olarak "büyüme" paketi + "aktif" durumla başlatıldı (geriye dönük, üretim davranışını bozmamak için). **Yeni oluşturulan şirketler** ise `createCompany` içine eklenen mantıkla otomatik olarak "deneme" paketi + 30 günlük deneme süresiyle başlar (bilinçli bir politika varsayılanı — gerçek bir sözleşme verisi değil, testte ve DEMO ortamı dışında yeni şirket açılışında görülür).
2. **İzinler**: yeni `subscription.view`/`subscription.manage`. `admin` rolü yalnızca `subscription.view` alır (mevcut "teknik sistem yöneticisi iş kararı onaylayamaz" kuralına uyularak — kod yorumu `prompt §5`); `manager` ve `accounting` her ikisini de alır (mevcut geniş iş/finans yetkilerine paralel). Mevcut şirketler için migration içindeki geriye dönük `role_permissions` ekleme bloğu (021'deki desenin aynısı) kullanıldı — yeni izinler `DEFAULT_ROLES`'e eklenince otomatik geriye dönmez, migration'da açıkça eklenmesi gerekir.
3. **API (`subscription.ts`)**: `GET /api/subscription` (durum, paket, canlı kullanım sayaçları — aktif üyelik sayısı, bileşen sayısı; limit aşımı yalnızca bilgilendirme, otomatik kısıtlamaya bağlı değil), `GET /api/subscription/plans`, `POST /api/subscription/plan` (paket değişikliği, denetim izi), `POST /api/subscription/transition` (durum makinesi: deneme→{aktif,iptal}; aktif→{gecikmiş,iptal}; gecikmiş→{aktif,kısıtlı,iptal}; kısıtlı→{aktif,iptal}; **iptal kalıcı, geri dönüş yok** — "yeniden açma" bilinçli olarak gerçekten yeni bir şirket kaydı gerektirir, sahte "iptali geri al" yok), `POST /api/subscription/payments` (idempotency-key ile mükerrer kayıt önlenir — mevcut genel `idempotent()` yardımcı fonksiyonu yeniden kullanıldı, yeni bir mekanizma icat edilmedi; **durumu otomatik değiştirmez** — gerçek borç/tahsilat motoru olmadan "ödeme borcu kapatıyor" çıkarımı uydurma olur), `GET /api/subscription/events` (denetim izi).
4. **Kısıtlama zorlaması — bilinçli olarak dar**: yalnızca `POST /api/sales-orders` (yeni satış siparişi) ve `POST /api/rfqs/:id/award` (teklif ödülü → yeni satın alma siparişi) `assertNotRestricted()` ile korunur — "yeni ticari taahhüt" olarak en net iki eylem. Üretim, sevkiyat, mevcut işlerin tamamlanması, görüntüleme dahil **hiçbir başka akış etkilenmez**. Bu, tam kapsamlı bir "her şeyi kilitle" yaklaşamı değil, dürüstçe belgelenmiş, ileride genişletilebilir dar bir kapsam sınırlamasıdır.
5. **Testler** (`subscription.test.ts`, 6 test): yetkisiz rol görüntüleyemez / admin yalnızca görüntüler yönetemez; yeni şirket deneme paketinde başlar, kullanım sayaçları canlı; paket değişikliği denetim izi bırakır; durum geçiş grafiği geçersiz geçişi reddeder ve "iptal" kalıcıdır; **kısıtlı durumun yalnızca satış siparişi ve RFQ ödülünü engellediği, ürün/iş emri görüntüleme ve iş emri listesi gibi diğer akışların etkilenmediği** doğrulandı; ödeme kaydı aynı idempotency-key ile mükerrer işlenmez ve durumu otomatik değiştirmez.
6. **Web** (`/subscription`, `Abonelik` menüsü, `subscription.view` ile görünür): durum/paket/kullanım kartı, paket değiştirme, durum değiştirme (gerekçe zorunlu, yalnızca izinli geçişler seçilebilir), ödeme kaydı formu, denetim izi tablosu — hepsi `subscription.manage` ile sınırlı, görüntüleme `subscription.view` ile.
7. **Doğrulama**: `pnpm -r exec tsc --noEmit` ve `vite build` temiz; `subscription.test.ts` 6/6, tam paket 240/240 geçti; migration 041 yerel geliştirme veritabanına uygulandı; gerçek tarayıcıda (yerel Chromium, Playwright) `yonetici@demo.apisfactory.com` ile `/subscription` sayfası görüntülendi ve durum deneme→aktif→gecikmiş→kısıtlı geçişleri yapıldı; ardından `satis@demo.apisfactory.com` ile `/sales` sayfasından yeni sipariş taslağı oluşturmaya çalışılınca **gerçek tarayıcıda** "Şirketin aboneliği kısıtlı durumda; yeni satış siparişi oluşturma yapılamaz." hatası göründü ve kayıt oluşmadı; sonda DEMO ortamı "aktif" duruma geri alındı (kalıcı bir yan etki bırakılmadı).
8. **Bilinçli olarak geliştirilmeyenler**: şirketler arası platform operatörü ekranı/rolü (kullanıcı kararı); gerçek ödeme sağlayıcısı entegrasyonu (sağlayıcı seçilmedi — dış bağımlılık); paket tanımlarının uygulama içinden düzenlenmesi (yalnızca migration/DB — `subscription_plans` platform geneli paylaşılan referans veri, gerçek bir platform-yönetici arayüzü olmadığı için); kullanım limiti aşımının otomatik kısıtlamaya dönüşmesi (bilinçli olarak reddedildi — gerçek bir kullanım-faturalama motoru yokken bunu otomatikleştirmek uydurma bir politika olurdu).

## Oturum 39 devamı — W39 devamı: tarihsel üretim (iş emri) geçişi — W39'un son sub-kalemi

**Durum: uygulandı, otomatik testleri geçti, gerçek tarayıcıda (yerel geliştirme ortamı) uçtan uca doğrulandı.** Dış bağımlılık gerektirmiyor.

AR göçünden sonra W39'un son açık kalemi — tarihsel üretim/kalite/maliyet kayıtları (iş emri geçişi) — ele alındı.
Bu, önceki dördünden daha karmaşıktı çünkü canlı üretim akışı çok katmanlı: planla → yayımla (seri numarası
üretilir) → operasyon sırayla başlat/tamamla → cihaz bazlı test → kalite kapısı → son kalite serbest bırakma →
kapat; ayrıca ayrı bir maliyet motoru (`computeWorkOrderCost`) operasyon süresi ve malzeme lot maliyetinden
işçilik/malzeme/genel gider ayrıştırır.

**Temel tasarım kararı — neyin uydurulmayacağı:** Geçmiş bir iş emrinin gerçekte hangi operasyonlardan hangi
sürede geçtiği, hangi malzeme lotlarının tüketildiği ve cihaz bazlı test geçmişi (hangi cihaz hangi testten ne
zaman geçti) bu sistemde ayrıca izlenmiyor olabilir — bir CSV'den bu ayrıntı düzeyi genellikle gelmez. Bu yüzden
yeni `POST /api/imports/work-orders/preview` + commit akışı bunların HİÇBİRİNİ uydurmaz: `work_order_operations`
satırı açılmaz, `material_issues` yazılmaz, `test_runs` oluşturulmaz. Yalnızca bilinen gerçek toplamlar
kaydedilir: sağlam adet, hurda adet, tamamlanma tarihi ve (opsiyonel) verilen birim maliyet.

**Cihaz kayıtlarının yine de oluşturulması — "uydurma" ile "iz sürülebilirlik" arasındaki çizgi:** Sağlam+hurda
adet kadar, canlı "yayımla" akışıyla AYNI numaralandırma deseniyle (`{kod}-00001`…) sistem tarafından üretilen
seri numaralı `devices` kaydı açılıyor — sağlam olanlar doğrudan `status='released'` ve bitmiş ürün lotuna
bağlanıyor (canlı "son kalite serbest bırakma" ile aynı stok etkisi: `stock_moves` 'produce' hareketi), hurda
olanlar `status='scrapped'` ile iz sürülüyor ama stok etkisi yaratmıyor. Bu bilinçli bir ayrım: seri numarası
zaten canlı sistemde de kullanıcıdan gelmeyen, sistem tarafından üretilen dahili bir izlenebilirlik anahtarı
(müşteriye görünen bir kimlik değil) — bunu üretmek test sonucu veya operasyon zamanlaması gibi bir "gerçek"i
uydurmakla aynı şey değil. Alternatif (hiç cihaz kaydı açmamak) daha "güvenli" görünse de mevcut gösterge/maliyet
altyapısının (ilk testte başarı, hurda oranı, maliyet motoru) 0 cihaz görüp "veri yok" göstermesine yol açardı —
bu, bilinen gerçek sağlam/hurda adedini gizleyen, aktif olarak yanlış bir sonuç olurdu. Cihaz oluşturmak, hiçbir
test/operasyon verisi uydurmadan bilinen sayıları doğru yansıtmanın yoludur.

**Maliyet motorunun korunması — sıfır girdiden sahte "0 TL" üretmemesi:** `computeWorkOrderCost` malzeme
lot maliyeti + operasyon süresi × saat ücretinden toplam maliyeti hesaplar. Migrated bir iş emrinde operasyon/
malzeme çıkışı hiç yoktur, yani bu motora göre toplam = 0 olur; sağlam adet > 0 olduğu için motor "birim maliyet
0 TL" gibi YANLIŞ ve tehlikeli bir sonuç üretebilirdi (gerçek maliyetin sıfır olduğu izlenimi verir). Bu, kod
yazılırken önceden fark edilip düzeltildi: `wo.migrated` ise motor bir "eksik" (`gaps`) mesajı ekler, `complete`
her zaman `false` kalır ve `unitCost` sağlam adet sayısından bağımsız olarak `null` döner — birim maliyet bu
motorla ASLA hesaplanmaz. Verilen birim maliyet (varsa) doğrudan bitmiş ürün lotuna `lot_costs` tablosuna
kaydedilir (source='production', aynı canlı serbest bırakma akışının kullandığı kaynak); bu, motorun ürettiği
sahte 0'ın üzerine yazılmasını da önler (motor `complete=false` olduğu için otomatik lot maliyeti yazma yolu
zaten tetiklenmez).

**Proaktif arayüz incelemesi:** Kod yazılmadan önce `WorkOrderPage`/`DeviceRow`/`MaterialRow`/`HoldAndChange`
bileşenleri okundu. Bulgular: (1) Malzeme tablosu migrated bir iş emri için "Kalan" sütununda tam BOM ihtiyacını
gösterecekti (malzeme çıkışı hiç yazılmadığı için) — bu, tamamlanmış bir işin hâlâ malzeme beklediği izlenimi
verebilir; çıkış butonu zaten `wo.status` "released"/"in_progress" değilse (migrated her zaman "completed")
gizli olduğundan işlevsel bir hata değil ama yanıltıcı görünüm riski var — bunun için iş emri detayında açık bir
"tarihsel geçiş" bilgi kutusu eklendi. (2) `DeviceRow` zaten cihaz durumuna göre doğru koşullu render ediyor
(yalnızca `in_process`/`rework`/`test_failed` durumundaki cihazlar için eylem gösteriyor) — `released`/`scrapped`
cihazlar için ek bir düzeltme gerekmedi. (3) `HoldAndChange` zaten `wo.status` aktif değilse ve değişiklik talebi
yoksa hiç render edilmiyor — migrated (`completed`) iş emri için sorunsuz.

**Ne yapıldı:**
- `apps/api/migrations/040_work_order_import.sql`: `work_orders.migrated boolean not null default false`,
  `import_jobs.kind` CHECK kısıtına `'work_orders'` eklendi.
- `packages/shared/src/schemas.ts`: `WorkOrderImportPreviewInput` (ürün kodu/sağlam adet/tamamlanma tarihi
  zorunlu; iş emri kodu/revizyon/hurda adet/birim maliyet/para birimi opsiyonel).
- `apps/api/src/modules/imports.ts`: `POST /api/imports/work-orders/preview` (yetki: `production.plan`) —
  ürün/revizyon çözümlenir (yalnızca yayımlanmış revizyon, revizyon boşsa son yayımlanan), sağlam/hurda adet tam
  sayı ve toplamı >0 olmalı (en fazla 10.000), tamamlanma tarihi zorunlu, birim maliyet opsiyonel doğrulanır, iş
  emri kodu verilmişse dosya-içi ve DB'de mükerrerlik kontrolü. Commit'te: her satır bir iş emri; `work_orders`
  doğrudan `status='completed'`, `migrated=true` ile eklenir (operasyon kaydı açılmaz); sağlam adet varsa bitmiş
  ürün lotu + `stock_moves` 'produce' hareketi (canlı serbest bırakmayla aynı desen) ve verilmişse `recordLotCost`
  ile birim maliyet kaydı; sağlam+hurda adet kadar seri numaralı `devices` kaydı (sağlam→`released`+lot bağlı,
  hurda→`scrapped`). İzin eşlemesine `work_orders → production.plan` eklendi; `reconcile()` genişletildi
  (`work_orders` → `result.workOrders`).
- `apps/api/src/modules/production.ts`: `loadWorkOrder`'ın SELECT listesine `w.migrated` eklendi (arayüzün bu
  durumu gösterebilmesi için).
- `apps/api/src/modules/costing.ts`: `computeWorkOrderCost` migrated iş emrinde motorun ürettiği sahte "0 TL"
  birim maliyeti asla döndürmemesi için korumalar (yukarıda anlatıldı) — `wo.migrated` sorguya eklendi, `gaps`'e
  açıklayıcı mesaj, `unitCost` her zaman `null`, `unitCostNote` migrated'e özel metin.
- Web: `Imports.tsx`'e "Tarihsel üretim (iş emri) geçişi" bölümü (yetki: `production.plan`), geçmiş işler
  tablosuna `work_orders: "İş emirleri"` etiketi eklendi. `Production.tsx`'teki `WorkOrderPage`'e yukarıda
  anlatılan tarihsel geçiş bilgi kutusu eklendi.
- Test: `apps/api/test/work-order-import.test.ts` (7 test) — yetkisiz rol reddi; geçerli iş emrinin doğru
  kaydedilmesi (bitmiş ürün lotuna gerçek stok etkisi, 12 cihaz — 10 released + 2 scrapped —, verilen birim
  maliyetin doğrudan lota kaydedildiğinin doğrulanması); **maliyet motorunun migrated iş emri için asla birim
  maliyet hesaplamadığının (sahte 0 üretmediğinin) doğrudan doğrulanması**; yalnız hurda (sağlam adet 0) kaydı
  ve bitmiş ürün lotu oluşmadığının doğrulanması; iş emri kodu boşken otomatik `IE-` üretimi; beş hata senaryosu
  (bilinmeyen ürün/revizyon, geçersiz adet/tarih/maliyet, sıfır toplam adet, mükerrer iş emri kodu) ve bunların
  onayı engellediği; uzlaşma göstergesinin doğru hesaplandığı.

**Doğrulama (gerçek yerel Postgres + gerçek tarayıcı, sağlayıcı/canlı ortam DEĞİL):**
- `pnpm -r exec tsc --noEmit` (api + web): hatasız.
- `npx vite build` (web): başarılı.
- `pnpm test` (api): **234/234** test geçti (önceki 227 + yeni 7), gerçek PostgreSQL 16.
- Migration 040 gerçek yerel dev veritabanına uygulandı (`migration uygulandı: 040_work_order_import.sql`).
- Playwright ile gerçek tarayıcıda (`uretim@demo.apisfactory.com`, DEMO şirketi; test için API üzerinden
  yayımlanmış bir ürün revizyonu önceden hazırlandı): giriş → İçe aktarım sayfasında "Tarihsel üretim (iş emri)
  geçişi" sihirbazı → CSV yükle (8 sağlam, 2 hurda, birim maliyet 12,75 TRY) → kolon otomatik eşleşmesi → Önizle
  → Onayla ve işle → Üretim listesinde iş emri "Tamamlandı" durumunda görünüyor (10 miktar, 8 serbest, 2 hurda)
  → iş emri detayında tarihsel geçiş bilgi kutusu görünüyor, 10 cihaz doğru seri numaralarıyla ve durumlarıyla
  (8 "Serbest bırakıldı", 2 "Hurda") listeleniyor, operasyon tablosu boş (uydurulmadı), sayfa hatası yok.

**W39'un tamamı artık tamamlandı**: müşteri/tedarikçi ana veri, açık satış siparişi, AP, açık satın alma
siparişi, AR ve şimdi tarihsel üretim (iş emri) geçişi — hepsi aynı "bilinçli fark" desenini izliyor (canlı yan
etkiler tetiklenmez, bilinmeyen ayrıntı asla uydurulmaz, yalnızca verilen/bilinen gerçek veriler kaydedilir).

## Oturum 39 devamı — W39 devamı: açık alacak (AR) tarihsel geçişi

**Durum: uygulandı, otomatik testleri geçti, gerçek tarayıcıda (yerel geliştirme ortamı) uçtan uca doğrulandı.** Dış bağımlılık gerektirmiyor.

Satış siparişi, AP ve satın alma siparişi göçlerinden sonra W39'un dördüncü açık kalemi — açık alacak (AR) — ele
alındı. Bu, önceki üçünden farklı olarak bir **şema kararı** gerektiriyordu: `customer_invoices.sales_order_id`
bugüne kadar `NOT NULL` idi çünkü canlı akışta her fatura sevk edilmiş bir sevkiyattan (dolayısıyla gerçek bir
satış siparişinden) hazırlanıyor. Geçmişten taşınan bir fatura için gerçek bir sipariş/sevkiyat bağlantısı yok.

**Şema kararı — sahte sipariş yerine nullable + açık işaretçi:** İki seçenek değerlendirildi: (1) FK'yi tatmin
etmek için sahte/senkron bir satış siparişi açmak, (2) sütunu nullable yapıp göçü ayrı bir bayrakla işaretlemek.
Birincisi reddedildi — bu, satış panolarını/raporlarını (kapasite, termin, gelir tahmini) hiç var olmamış
siparişlerle kirletir. Bunun yerine `migration 039`: `alter table customer_invoices alter column sales_order_id
drop not null;` + yeni `migrated boolean not null default false` sütunu (AP'deki `match_result.migrated` JSON
işaretçisinin sorgulanabilir bir sütuna genellenmiş hâli).

**Bulunan ve önceden düzeltilen iki INNER JOIN hatası:** `sales_order_id` artık null olabildiğinden,
`receivables.ts` içinde `join sales_orders so on so.id = ci.sales_order_id` yapan **iki** sorgu (`loadInvoice()` —
tekil fatura getirme — ve `GET /api/customer-invoices` — liste) göçmüş bir faturayı sırasıyla 404'e düşürür veya
listeden **sessizce kaybolmasına** neden olurdu (ikincisi daha tehlikeli — hiçbir hata görünmez). Bu, kod
yazılmadan önce şema değişikliğinin etkilediği tüm sorgular taranarak bulundu ve her ikisi de `left join`'e
çevrildi; `ci.migrated` her iki sorgunun SELECT listesine eklendi.

**Proaktif arayüz incelemesi (AP'deki `matchResult` çökmesinden sonra kalıcı uygulamaya alınan disiplin):**
Backend kodu yazılmadan önce `Receivables.tsx`'teki `CustomerInvoicePage` bileşeni okundu — koşulsuz
`<Link to={`/sales/${i.salesOrderId}`}>` bulundu (çökme değil ama göçmüş fatura için kırık/anlamsız bağlantı
üretirdi). Backend'e dokunmadan önce düzeltildi: sipariş yoksa "sipariş bağlantısı yok (tarihsel geçiş)" metni
gösteriliyor; ayrıca AP'dekiyle aynı desende bir "bu fatura tarihsel geçişle eklendi" bilgi kutusu eklendi.

**KDV oranını uydurmadan geriye hesaplama:** Kaynak veride genelde oran değil net/KDV tutarı bulunur. Canlı
sevkiyat akışının varsayılan oranını (ör. %20) atamak yerine, verilen net ve KDV tutarından `oran =
KDV/net × 100` olarak **geriye hesaplandı** — bu gerçek, kaynaktan gelen sayılarla yapılan gerçek matematik.
Hesaplanan oran %100'ü aşarsa (yani verilen tutarlar matematiksel olarak tutarsızsa) satır sessizce
kırpılmıyor, **reddediliyor** — bu, iyi niyetle uydurmak yerine "kaynak veri muhtemelen hatalı" sinyalini
kullanıcıya geri veriyor.

**Tetikleyici uyumu — taslak-sonra-kes iki adımlı ekleme:** `customer_invoices` üzerinde
`guard_issued_customer_invoice()` tetikleyicisi, üst fatura hâlâ `'draft'` değilse `customer_invoice_lines`
eklemesini engelliyor. Bu, migration/route kodu yazılmadan önce tetikleyici tanımı okunarak keşfedildi; commit
akışı canlı "sevkiyattan taslak → kes" akışının **aynısını** izliyor: önce `status='draft'` ile fatura başlığı
eklenir, satır(lar) eklenir, sonra ayrı bir `UPDATE ... SET status = 'issued'/'paid'` ile geçiş yapılır.

**Ne yapıldı:**
- `apps/api/migrations/039_ar_invoice_import.sql`: `sales_order_id` nullable, `migrated` sütunu, `import_jobs.kind`
  CHECK kısıtına `'ar_invoices'` eklendi.
- `packages/shared/src/schemas.ts`: `ArInvoiceImportPreviewInput` (fatura no opsiyonel, müşteri kodu/fatura
  tarihi/net tutar zorunlu; vade/kur/KDV/açıklama/tahsil edilen tutar/tahsilat tarihi opsiyonel).
- `apps/api/src/modules/imports.ts`: `POST /api/imports/ar-invoices/preview` (yetki: `receivable.manage`) —
  müşteri kodu çözümlenir (ödeme vadesi de alınır, vade boşsa oradan hesaplanır); net/KDV tutarları doğrulanır ve
  KDV oranı geriye hesaplanır (>%100 reddedilir); tahsil edilen tutar verilirse tahsilat tarihi zorunlu ve tutar
  brüt tutarı aşamaz; fatura no verilmişse dosya-içi ve DB'de mükerrerlik kontrolü. Commit'te: taslak → satır →
  kes/öde sırası; fatura no boşsa canlı "kes" akışıyla aynı `nextCode(..., "customer_invoice_issued", "MF")`
  sayacı (çakışma yok); tahsil edilen tutar verilmişse `customer_receipts` satırı da eklenir. İzin eşlemesine
  `ar_invoices → receivable.manage` eklendi; `reconcile()` genişletildi (`ar_invoices` → `result.invoices`,
  `ap_invoices` ile aynı desen).
- `apps/api/src/modules/receivables.ts`: yukarıda anlatılan iki INNER→LEFT JOIN düzeltmesi + `migrated` sütunu
  her iki sorgunun SELECT listesine eklendi.
- Web: `Imports.tsx`'e "Açık alacak (W39 devamı — tarihsel geçiş)" bölümü (yetki: `receivable.manage`), geçmiş
  işler tablosuna `ar_invoices: "Müşteri faturaları"` etiketi eklendi. `Receivables.tsx`'te yukarıda anlatılan
  kırık-bağlantı düzeltmesi + göç bilgi kutusu.
- Test: `apps/api/test/ar-invoice-import.test.ts` (6 test) — yetkisiz rol reddi; geçerli fatura (vade boşsa
  müşteri ödeme vadesinden hesaplanması, KDV oranının doğru geriye hesaplanması, `migrated=true`/`sales_order_id`
  ve `shipment_id`'nin null kalması dahil); tam tahsilat → `paid` + tahsilat kaydı, kısmi tahsilat → `issued`
  kalması; fatura no boşken otomatik `MF-` üretimi; beş hata senaryosu (bilinmeyen müşteri, geçersiz tutar/tarih,
  KDV oranı %100'ü aşan, tahsilat tarihi eksik, mükerrer fatura no) ve bunların onayı engellediği; uzlaşma
  göstergesinin doğru hesaplandığı.

**Doğrulama (gerçek yerel Postgres + gerçek tarayıcı, sağlayıcı/canlı ortam DEĞİL):**
- `pnpm -r exec tsc --noEmit` (api + web): hatasız.
- `npx vite build` (web): başarılı.
- `pnpm test` (api): **227/227** test geçti (önceki 221 + yeni 6), gerçek PostgreSQL 16.
- Migration 039 gerçek yerel dev veritabanına uygulandı (`migration uygulandı: 039_ar_invoice_import.sql`).
- Playwright ile gerçek tarayıcıda (`muhasebe@demo.apisfactory.com`, DEMO şirketi, seed'deki `MUS-001` müşterisi
  kullanılarak): giriş → İçe aktarım sayfasında "Açık alacak" sihirbazı → CSV yükle (net 2.000 TRY, KDV 360) →
  kolon otomatik eşleşmesi → Önizle → Onayla ve işle → Alacaklar listesinde fatura görünüyor → fatura detayında
  "sipariş bağlantısı yok (tarihsel geçiş)" metni (kırık bağlantı YOK), tarihsel geçiş bilgi kutusu görünüyor,
  durum "kesildi — açık", vade doğru hesaplanmış (fatura tarihi + müşteri ödeme vadesi), KDV **%18** doğru geriye
  hesaplanmış, tutarlar (Net 2.000 / KDV 360 / Toplam 2.360) doğru, sayfa hatası yok.

Kalan (W39'un hâlâ açık kısmı): yalnızca tarihsel üretim/kalite/maliyet kayıtları (iş emri geçişi) — "açık satın
alma/satış siparişi + AP + AR" dörtlüsünün tamamı artık tamamlandı. İş emri geçişi kendi başına dikkatli bir
tasarım gerektiriyor: bir iş emrinin geçmişte hangi operasyonlardan hangi sürede geçtiğini, fire/hurda
miktarlarını ve kaliteden geçip geçmediğini olduğu gibi kaydetmek, ama üretim planlama/kapasite/malzeme tüketimi
gibi canlı yan etkileri tetiklememek gerekiyor — aynı "bilinçli fark" deseni, farklı domain.

## Oturum 39 devamı — W39 devamı: açık satın alma siparişi tarihsel geçişi

**Durum: uygulandı, otomatik testleri geçti, gerçek tarayıcıda (yerel geliştirme ortamı) uçtan uca doğrulandı.** Dış bağımlılık gerektirmiyor.

AP (tedarikçi borcu) geçişinden sonra W39'un "açık satın alma/satış/üretim emirleri" kapsamındaki üçüncü ve son
sipariş türü — açık satın alma siparişi — ele alındı (satış siparişi ve AP daha önce tamamlanmıştı). Bu, AR
(alacak) göçünün aksine bir şema değişikliği gerektirmiyordu: `purchase_order_lines.item_id` NOT NULL ama
`purchase_request_id`/`quote_id` zaten satır bazında nullable, bu yüzden RFQ/teklif/talep bağlantısı olmadan da
geçerli bir satır oluşturulabiliyor — sales_orders geçişiyle aynı risk sınıfında.

**Tasarım — canlı akıştan bilinçli fark:** Canlı satın alma akışı her zaman RFQ açar → tedarikçilerden teklif
alınır/karşılaştırılır → en uygun teklif gerekçeyle seçilir (`POST /api/rfqs/:id/award`) → bu award bir satın alma
siparişi + satırı yaratır ve varsa bağlı satın alma talebini "converted" işaretler. Geçmişten taşınan bir sipariş
için RFQ/teklif karşılaştırması veya satın alma talebi/üretim ihtiyacı bağlantısı üretmek, o siparişin geçmişte
gerçekten nasıl bir teklif sürecinden geçtiğini bilmediğimiz halde uydurma bir karar geçmişi yaratmak olurdu — bu
yüzden yeni `POST /api/imports/purchase-orders/preview` + commit akışı hiçbir RFQ/`rfq_quotes`/`purchase_requests`/
`purchase_allocations` satırı oluşturmuyor; sipariş ve satırları **olduğu gibi** kaydediliyor.

**İkinci ve daha ince bir "uydurmama" kararı — sipariş durumu:** Canlı sistemde satırlara teyit tarihi ve mal kabul
işlendikçe sipariş başlığının durumu (`sent` → `confirmed`/`partially_received` → `received`) `refreshPoStatus()`
fonksiyonuyla satırlardan **türetilir**, elle set edilmez. Göç akışı da AYNI fonksiyonu (procurement.ts'ten
`export`lanmış hâliyle) çağırıyor — CSV'de teyit tarihi ve teslim alınan miktar verilmişse durum gerçekten o
verilerden hesaplanıyor (örn. teslim alınan = sipariş miktarı → `received`; kısmi → `partially_received`; yalnız
teyit tarihi → `confirmed`; hiçbiri yoksa → `sent`, ki bu zaten göçün taban durumu: "açık/dış sipariş" olarak
tanımlanan bir kaydın tedarikçiye gönderilmiş olduğu bilinen bir gerçektir, ne zaman gönderildiği (`sentAt`) ise
bilinmediği için `null` bırakılır ve arayüzde "TEST gönderimi" bildirimi bu yüzden hiç görünmez — dürüstçe boş).

**Ne yapıldı:**
- `apps/api/migrations/038_purchase_order_import.sql`: `import_jobs.kind` CHECK kısıtına `'purchase_orders'` eklendi.
- `packages/shared/src/schemas.ts`: `PurchaseOrderImportPreviewInput` (sipariş kodu opsiyonel, tedarikçi/kalem kodu
  zorunlu, sipariş miktarı zorunlu, teslim alınan miktar/birim fiyat/para birimi/istenen tarih/teyit tarihi opsiyonel).
- `apps/api/src/modules/imports.ts`: `POST /api/imports/purchase-orders/preview` (yetki: `purchase.order.manage`) —
  tedarikçi/kalem kodu çözümlenir; teslim alınan miktar sipariş miktarını aşamaz; aynı sipariş kodundaki satırlar
  farklı tedarikçi veya para birimiyle kullanılırsa reddedilir; sipariş kodu DB'de zaten varsa reddedilir. Commit'te:
  gruplar sırayla `purchase_orders` + `purchase_order_lines`'a yazılır (durum başlangıçta `'sent'`), ardından
  `refreshPoStatus()` çağrılarak gerçek durum satırlardan türetilir; sipariş kodu boşsa aynı `nextCode(...,
  "purchase_order", "SAS")` sayacı (canlı akışla aynı, çakışma olmaz) kullanılır. `procurement.ts`'ten
  `refreshPoStatus` içe aktarıldı (döngüsel import riski yok — procurement.ts imports.ts'i hiç referans etmiyor).
  Commit route'undaki izin eşlemesine `purchase_orders → purchase.order.manage` eklendi; `reconcile()` genişletildi
  (`purchase_orders` → `result.lines`, `sales_orders` ile aynı desen).
- Web: `Imports.tsx`'e "Açık satın alma siparişleri (W39 devamı — tarihsel geçiş)" bölümü (yetki:
  `purchase.order.manage`), geçmiş işler tablosuna `purchase_orders: "Satın alma siparişleri"` etiketi eklendi.
- **Bu kez UI'da hata çıkmadı** (AP faturasındaki `matchResult` hatasından sonra kod yazmadan önce
  `PurchaseOrderPage` bileşeni özellikle incelendi — `null` alanlara (`sentAt`, `unitPrice`, `confirmedDate`,
  `prCode`) zaten null-safe davrandığı ve RFQ'ya özgü hiçbir alanı varsaymadığı doğrulandı; bu yüzden ek bir
  düzeltme gerekmedi).
- Test: `apps/api/test/purchase-order-import.test.ts` (7 test) — yetkisiz rol reddi; çok satırlı sipariş
  gruplama + **`rfqs`/`purchase_requests`/`purchase_allocations` tablolarına hiçbir satır düşmediğinin doğrudan DB
  sorgusuyla doğrulanması** + teyit/teslim verilmezse durumun `sent` kalması + `sentAt`'in `null` kalması; tam
  teslim + teyit tarihi verilince durumun `received` olarak (uydurulmadan, gerçekten `refreshPoStatus`'tan)
  türetildiği; kısmi teslimde `partially_received`; sipariş kodu boşken her satırın ayrı sipariş olması; yedi farklı
  hata senaryosu (bilinmeyen tedarikçi/kalem, geçersiz miktar/teslim-aşımı/tarih/kur, mükerrer sipariş kodu) ve
  bunların onayı engellediği; uzlaşma göstergesinin doğru hesaplandığı.

**Doğrulama (gerçek yerel Postgres + gerçek tarayıcı, sağlayıcı/canlı ortam DEĞİL):**
- `pnpm -r exec tsc --noEmit`: hatasız.
- `npx vite build` (web): başarılı.
- `pnpm test` (api): **221/221** test geçti (önceki 214 + yeni 7), gerçek PostgreSQL 16.
- Migration 038 gerçek yerel dev veritabanına uygulandı (`migration uygulandı: 038_purchase_order_import.sql`).
- Playwright ile gerçek tarayıcıda (`satinalma@demo.apisfactory.com`, DEMO şirketi, seed'deki `DEMO-DAG` tedarikçisi
  ve `CMP-CAP-01` kalemi kullanılarak): giriş → İçe aktarım sayfasında "Açık satın alma siparişleri" sihirbazı →
  CSV yükle (500 sipariş, 150 teslim alınmış, teyit tarihi verilmiş) → kolon otomatik eşleşmesi → Önizle (1 satır,
  eşleşti) → Onayla ve işle (`{"orders":1,"lines":1}`) → Geçmiş işler tablosunda "İşlendi", uzlaşma "kaynak 1 /
  hedef 1" → Satın alma siparişleri listesinde sipariş görünüyor → sipariş detayında durum rozeti **"kısmi
  teslim"** (`partially_received`, gerçekten türetilmiş — 150/500 verildiği için doğru), toplam 500 × 0,45 = 225
  TRY doğru hesaplandı, teyit tarihi "2026-01-18 gecikti" (teslim tarihinden sonra ve eksik teslim olduğu için
  doğru şekilde gecikmiş işaretlendi), "Gönderim TEST" bildirimi görünmüyor (sentAt bilinmediği için dürüstçe
  boş), sayfa hatası yok.

Kalan (bu satırın yazıldığı an itibarıyla): tarihsel üretim/kalite/maliyet kayıtları ve AR (alacak) göçü — AR için
önce şema kararı (yukarıda not edilmişti) gerekiyordu. **Güncelleme (bir sonraki oturum devamı):** AR göçü de
tamamlandı, bkz. yukarıdaki "açık alacak (AR) tarihsel geçişi" bölümü. W39'un artık tek açık kalemi tarihsel
üretim/kalite/maliyet kayıtları (iş emri geçişi) — bu da kendi başına dikkatli bir tasarım gerektiriyor (bir iş
emrinin geçmişte hangi operasyonlardan hangi sürede geçtiğini, fire/hurda miktarlarını ve kaliteden geçip
geçmediğini olduğu gibi kaydetmek, ama üretim planlama/kapasite/malzeme tüketimi gibi canlı yan etkileri
tetiklememek gerekiyor — aynı "bilinçli fark" deseni, farklı domain).

## Oturum 39 devamı — W39 devamı: açık tedarikçi borcu (AP) tarihsel geçişi

Açık satış siparişi geçişinden sonra W39'un kalan iki sub-kalemi (tarihsel üretim/kalite/maliyet, AP/AR göçü) için
şema incelemesi yapıldı: `customer_invoices.sales_order_id` **NOT NULL** (`021_receivables.sql`) — AR (alacak) göçü
bu yüzden bir şema kararı (nullable + "göçmüş fatura" ayırt edici alanı, veya sahte sipariş üretme) gerektiriyor ve
bu oturuma sığmayacak kadar dikkat istiyor. `supplier_invoices` tarafında ise böyle bir zorunlu sipariş bağlantısı
yok (`po_line_id` satır bazında zaten nullable ve mevcut `match()` fonksiyonu bunu `po_missing` bayrağıyla zaten
gracefully ele alıyor) — bu yüzden AP (borç) daha az riskli/daha iyi tanımlı seçildi, AR bir sonraki oturuma bırakıldı.

**Tasarım — canlı fatura giriş akışından bilinçli fark:** `POST /api/supplier-invoices` her zaman sipariş–mal
kabul–fatura üç yönlü eşleştirmesini (`match()`) çalıştırır ve eşleşmezse faturayı `variance` durumuna düşürüp
muhasebeye onay görevi açar. Geçmişten taşınan bir fatura için bu mantığı olduğu gibi çalıştırmak, gerçekte var
olmayan bir sipariş/mal kabul bağlantısı arayıp her faturayı yapay bir "fark" olarak işaretleyecekti — bu yüzden
yeni `POST /api/imports/ap-invoices/preview` + commit akışı `match()`'i hiç çağırmıyor; fatura doğrudan `approved`
(tamamı ödenmişse `paid`) kaydediliyor ve `match_result` alanına gerçek bir eşleştirme sonucu yerine dürüst bir
işaretçi yazılıyor: `{ migrated: true, note: "Tarihsel geçiş — sipariş/mal kabul bağlantısı olmadığından üç yönlü
eşleştirme çalıştırılmadı; fatura doğrudan onaylı kaydedildi" }`. Aynı gerekçeyle `writeLotCosts()` da çağrılmıyor
(gerçek bir sipariş/lot bağlantısı olmadığından uydurma lot maliyeti yazılmaz). Ödeme tarihi verilmeden ödenen tutar
kabul edilmez (ödemenin ne zaman yapıldığı uydurulmaz, "bugün" varsayılmaz).

**Değişen davranış/dosyalar:**
- `apps/api/migrations/037_ap_invoice_import.sql`: `import_jobs.kind` CHECK kısıtına `'ap_invoices'` eklendi.
- `packages/shared/src/schemas.ts`: `ApInvoiceImportPreviewInput` (tedarikçi kodu, fatura no/tarihi, vade, kur,
  net/KDV tutarı, açıklama, ödenen tutar/tarihi).
- `apps/api/src/modules/imports.ts`: `POST /api/imports/ap-invoices/preview` (perm `invoice.manage`) — kur/tutar/
  tarih doğrulaması, tedarikçi çözümü (ödeme vadesi günü de okunur), dosya-içi ve DB'ye karşı mükerrer tedarikçi+
  fatura no denetimi; commit dalı (fatura + tek kalem + varsa ödeme kaydı, `recordEvent`); `reconcile()` genişletildi
  (`ap_invoices` → `result.invoices`); commit route'undaki izin eşlemesine `ap_invoices → invoice.manage` eklendi.
- Web: `Imports.tsx`'e "Açık tedarikçi borcu (W39 devamı — tarihsel geçiş)" bölümü (yetki: `invoice.manage`),
  geçmiş işler tablosuna `ap_invoices: "Tedarikçi faturaları"` etiketi eklendi.
- Test: `apps/api/test/ap-invoice-import.test.ts` (5 test) — yetkisiz rol reddi; geçerli fatura doğrudan onaylı
  kaydedilir + vade tedarikçi ödeme vadesinden hesaplanır + üç yönlü eşleştirme çalışmaz + `lot_costs`'a satır
  düşmez (öncesi/sonrası doğrudan DB sorgusuyla karşılaştırıldı); tam ödeme → `paid` + ödeme kaydı, kısmi ödeme →
  `approved` kalır + ödeme kaydı; hatalı satırlar (bilinmeyen tedarikçi, geçersiz tutar/tarih, ödenen tutar verilip
  ödeme tarihi verilmemesi, mükerrer fatura) onayı engeller; uzlaşma doğru hesaplanır.

**E2E doğrulama sırasında bulunan ve düzeltilen gerçek hata:** Gerçek tarayıcıda göçmüş bir fatura açıldığında
detay sayfası tamamen boş kalıyordu (JS hatası). Sebep: `apps/web/src/pages/Payables.tsx`'teki `InvoicePage`
bileşeni `matchResult`'ın her zaman canlı `match()` çıktısının şeklinde olduğunu varsayıyordu
(`m.tolerance.pricePct`, `m.headerFlags.map(...)`, `m.lines[k]`) — göçmüş faturanın `{ migrated: true, note }`
şeklindeki `matchResult`'ında bu alanlar yok, `undefined.pricePct` erişimi sayfayı çökertiyordu. Düzeltme:
`m?.migrated` doğruysa üç yönlü eşleştirme tablosu yerine göç notunu (ve fatura durumuna göre "onaylı"/"ödendi")
gösteren ayrı bir dal eklendi; canlı akış (gerçek `match()` çıktısı) değişmedi. Bu, "test testleri geçti" ile
"gerçekten kullanılabilir" arasındaki farkın somut bir örneği — API testleri (`ap-invoice-import.test.ts`) bu UI
hatasını yakalayamazdı, yalnızca gerçek tarayıcıda uçtan uca gezinme yakaladı.

**Doğrulama (gerçek yerel Postgres + gerçek tarayıcı, sağlayıcı/canlı ortam DEĞİL):**
- `pnpm -r exec tsc --noEmit`: hatasız (hem ilk yazımdan hem UI düzeltmesinden sonra).
- `npx vite build` (web): başarılı (hem ilk yazımdan hem UI düzeltmesinden sonra).
- `pnpm test` (api): **214/214** test geçti (önceki 209 + yeni 5), gerçek PostgreSQL 16.
- Migration 037 gerçek yerel dev veritabanına uygulandı (`migration uygulandı: 037_ap_invoice_import.sql`).
- Playwright ile gerçek tarayıcıda (`muhasebe@demo.apisfactory.com`, DEMO şirketi, seed'deki `DEMO-DAG` tedarikçisi
  kullanılarak): giriş → İçe aktarım sayfasında "Açık tedarikçi borcu" sihirbazı → CSV yükle → kolon otomatik
  eşleşmesi → Önizle (1 satır, eşleşti) → Onayla ve işle (`{"invoices":1,"payments":0}`) → Geçmiş işler tablosunda
  "İşlendi", uzlaşma "kaynak 1 / hedef 1" → Borçlar & ödeme listesinde fatura görünüyor, durum "ödemeye hazır"
  (variance/fark YOK) → fatura detayında (UI düzeltmesinden sonra) "Bu fatura tarihsel geçişle (W39 devamı)
  eklendi... üç yönlü eşleştirme çalıştırılmadı" notu ve dürüst göç açıklaması doğru görüntüleniyor, sayfa hatası
  yok. Ekran görüntüleri teslimatla birlikte gönderildi.

Kalan (W39'un hâlâ açık kısmı): tarihsel üretim/kalite/maliyet kayıtları ve AR (alacak) göçü — AR için önce şema
kararı (yukarıda) gerekiyor.

## Oturum 39 devamı — W39 devamı: açık satış siparişi tarihsel geçişi

**Durum: uygulandı, otomatik testleri geçti, gerçek tarayıcıda (yerel geliştirme ortamı) uçtan uca doğrulandı.** Dış bağımlılık gerektirmiyor.

W39'un daha önce açık bırakılan üç sub-kalemi (açık sipariş / tarihsel üretim-kalite-maliyet / AP-AR göçü) içinden en az riskli ve en iyi tanımlı olanı — açık satış siparişi geçişi — seçildi. Diğer ikisi (tarihsel üretim/kalite/maliyet, AP/AR) önemli ölçüde yeni domain modellemesi gerektiriyor ve tarihsel veriyi yanlış temsil etme riski daha yüksek; bu oturumda ele alınmadı.

**Tasarım kararı — neden canlı sipariş akışından bilinçli olarak farklı:** `POST /api/sales-orders` + `/confirm` canlı akışı, siparişi kesinleştirirken gerçek zamanlı uygunluk hesaplar ve rezervasyon/üretim ihtiyacı/satın alma talebi/kredi kontrolü **yazar**. Geçmişten taşınan bir sipariş için bunları çalıştırmak, o siparişin geçmişte gerçekten nasıl karşılandığını bilmediğimiz halde bugünün stok durumuna göre hayali bir talep/arz planı uydurmak anlamına gelir — bu, projenin "veri uydurma" yasağını ihlal eder. Bunun yerine yeni `POST /api/imports/sales-orders/preview` + aynı `/api/imports/:id/commit` ucu, siparişi ve satırlarını **olduğu gibi** kaydeder; hiçbir rezervasyon/üretim ihtiyacı/satın alma talebi/kredi kontrolü tetiklenmez. Ekranda "Termin: Henüz hesaplanmadı" dürüstçe gösterilir (confirmResult null kalır); "Teslimat ve sevkiyat" paneli ise ayrı, yan etkisiz bir uçtan (`/availability`) bugünün gerçek stok durumunu canlı hesaplayıp gösterir — bu uydurma değil, gerçek bir hesaplamadır.

**Ne yapıldı:**
- `apps/api/migrations/036_sales_order_import.sql`: `import_jobs.kind` CHECK kısıtına `'sales_orders'` eklendi.
- `packages/shared/src/schemas.ts`: `SalesOrderImportPreviewInput` (sipariş kodu opsiyonel, müşteri/ürün kodu zorunlu, revizyon opsiyonel, miktar zorunlu, fiyat/para birimi opsiyonel, istenen tarih zorunlu, durum opsiyonel `"draft"`/`"firm"`, varsayılan `"firm"`).
- `apps/api/src/modules/imports.ts`: `POST /api/imports/sales-orders/preview` (yetki: `sales.create`) — müşteri/ürün kodu çözümlenir; revizyon verilmezse ürünün en son **yayımlanmış (released)** revizyonu otomatik seçilir (yoksa hata — uydurulmaz); aynı "sipariş kodu" değerine sahip satırlar tek siparişin kalemleri olarak gruplanır (dosya içinde farklı müşteriyle kullanılmışsa reddedilir); sipariş kodu zaten kullanımdaysa (DB'de var) reddedilir. Commit'te: gruplar sırayla `sales_orders` + `sales_order_lines`'a yazılır (`status='firm'` ise `confirmed_at=now()`), sipariş kodu boşsa aynı `nextCode(..., "sales_order", "SS")` sayacı (canlı akışla aynı sayaç, çakışma olmaz) kullanılarak üretilir. Reconcile fonksiyonu `sales_orders` için `bom` ile aynı desenle (`result.lines`) genişletildi.
- Web: `Imports.tsx`'e "Açık satış siparişleri (W39 devamı — tarihsel geçiş)" bölümü (yetkiye göre gösterilir, `CsvWizard` yeniden kullanıldı); geçmiş işler tablosundaki tür etiketine `sales_orders: "Satış siparişleri"` eklendi.
- **Testler**: `apps/api/test/sales-order-import.test.ts` (yeni, 5 test): yetkisiz rol reddi; çok satırlı sipariş gruplama + revizyon otomatik seçimi + **`reservations`/`production_needs`/`purchase_requests` tablolarına hiçbir satır düşmediğinin doğrudan DB sorgusuyla doğrulanması** (bu, tasarımın "yan etki yok" garantisinin gerçekten tutulduğunu kanıtlayan en önemli test); sipariş kodu boşken her satırın ayrı sipariş olması; altı farklı hata senaryosu (bilinmeyen müşteri/ürün, geçersiz miktar/tarih/durum, mükerrer sipariş kodu) ve bunların onayı engellediği; uzlaşma göstergesinin doğru hesaplandığı. Toplam **209/209** otomatik test geçti (`vitest run`); `pnpm -r exec tsc --noEmit` ve `npx vite build` temiz.
- **Doğrulama**: migration yerel geliştirme veritabanına uygulandı; API + web sunucuları yerelde ayağa kaldırılıp gerçek Chromium (Playwright) ile `satis@demo.apisfactory.com` kullanıcısıyla uçtan uca çalıştırıldı — Ar-Ge kullanıcısı bir ürün+revizyon açtı, satış kullanıcısı 2 satırlık (aynı sipariş kodunda) bir CSV içe aktardı: önizleme "2 eşleşti, 0 hatalı" gösterdi, onayda `{"orders":1,"lines":2}` döndü, "Geçmiş işler" tablosunda "kaynak 2 / hedef 2" (uzlaştı) rozeti görüldü; Satış & Termin listesinde sipariş toplam miktar 10 (7+3) ve "Kesinleşti" durumuyla göründü; sipariş detayında iki satır doğru ürün/revizyon/miktar/fiyatla listelendi, "Termin: Henüz hesaplanmadı" dürüstçe gösterildi, Teslimat panelindeki miktarlar canlı `/availability` hesabından doğru geldi, işlem geçmişinde "imported" olayı görüldü.

Kalan (W39'un hâlâ açık kısmı): tarihsel üretim/kalite/maliyet kayıtları ve AP/AR (borç/alacak) göçü. Bunlar da dış bağımlılık gerektirmiyor ama önemli miktarda yeni domain modellemesi istiyor; ileri bir oturumda dikkatli bir tasarımla ele alınmalı.

## Oturum 39 devamı — W40: yük testi taban çizgisi

**Durum: uygulandı, gerçek ölçüm alındı (küçük ölçekte).** Dış bağımlılık gerektirmiyor.

W40'ın "iş kuralı/yetki/RLS" kısmı zaten fonksiyonel test paketiyle (204/204) kapsanıyordu; hiç ele alınmamış tek kısım gerçek yük ölçümüydü ("yük testi hiç çalıştırılmadı" notu). Bunun için:

- `apps/api/scripts/loadtest.mjs` (yeni): `autocannon` kullanarak gerçek API sunucusuna (yerelde çalışan) karşı, demo kullanıcısıyla giriş yapıp gerçek JWT + `X-Company-Id` ile üç uca istek gönderir: `GET /api/items`, `GET /api/stock/balances`, `GET /api/imports` — her biri 20 eşzamanlı bağlantı ile 15-20 saniye boyunca.
- `autocannon` `apps/api/package.json`'a `devDependencies` olarak eklendi (`pnpm add -D autocannon --filter @apisfactory/api`), `pnpm --filter @apisfactory/api loadtest` script'i eklendi.
- **Gerçek ölçüm sonuçları** (yerel Postgres 16 + yerel API, tek sandbox makinesi — donanım pilot ortamıyla aynı değil, bu yüzden mutlak rakamlar pilot için referans değil, yalnızca "sistem beklenen eşzamanlılıkta hatasız/zaman aşımsız çalışıyor mu" sorusuna dürüst bir evet/hayır):
  - `GET /api/items`: 8546 istek / 20 sn, ort. 427 istek/sn, ort. gecikme 46 ms, p99 89 ms, 0 hata, 0 zaman aşımı.
  - `GET /api/stock/balances`: 7764 istek / 20 sn, ort. 388 istek/sn, ort. gecikme 51 ms, p99 80 ms, 0 hata, 0 zaman aşımı.
  - `GET /api/imports`: 6980 istek / 15 sn, ort. 465 istek/sn, ort. gecikme 42 ms, p99 64 ms, 0 hata, 0 zaman aşımı.
- Yük testi eklendikten sonra tam otomatik test paketi yeniden çalıştırıldı: **204/204** geçti; `tsc --noEmit` temiz.

**Dürüst sınır — bu ne DEĞİLDİR:** talimattaki 100.000 komponent / 1.000.000 kayıt / 100 eşzamanlı kullanıcı hedefleri test edilmedi. Demo veri seti küçük (birkaç düzine kayıt); bu sandbox'ta ne bu ölçekte sentetik veri üretmek ne de uzun süreli (dakikalar/saatler) bir dayanıklılık testi çalıştırmak için disk/süre bütçesi var. Elde edilen, gerçek altyapı üzerinde gerçek ölçülmüş ama küçük ölçekli bir taban çizgisi — büyük ölçekli/uzun süreli yük testi ve kesinti/dayanıklılık senaryoları (talimat §30) hâlâ **geliştirilmedi**, pilot öncesi gerçek boyutlu bir ortamda tekrarlanması önerilir.

## Oturum 39 devamı — W41: Yardım & eğitim sayfası

**Durum: uygulandı, gerçek tarayıcıda (yerel geliştirme ortamı) doğrulandı.** Dış bağımlılık gerektirmiyor — talimatın "eğitimi tamamen erteleme, şimdiden hazırla" maddesine göre, dış sağlayıcı/pilot kararı beklemeden hazırlanabilecek bir sonraki net kalem olarak seçildi.

**Ne yapıldı:**
- `apps/web/src/pages/Help.tsx` (yeni): 9 bölümlük tek sayfa —
  1. **Rol bazlı görev rehberleri** (8 rol: Satış, Muhasebe, Satın alma, Üretim/Teknisyen, Ar-Ge, Kalite, Depo, Yönetici) — her biri sistemde gerçekten yapılabilen işlemlere dayanan 3-5 maddelik kısa rehber (uydurulmuş/henüz uygulanmamış özellik yok; örn. "geri alma" düğmesi olmadığı için düzeltme rehberinde bunun yerine audit-log üzerinden yeni kayıtla düzeltme anlatılıyor).
  2. **Örnek eğitim şirketi** — yeni oluşturulmadı, var olan `seed.ts` demo/eğitim ortamı ("DEMO Elektronik A.Ş.", `DEMO_PASSWORD`, rol başına demo kullanıcı) gerçek eğitim ortamı olarak tarif ediliyor.
  3. **Yetki matrisi** — sabit/elle yazılan bir tablo değil, `packages/shared/src/permissions.ts`'teki `DEFAULT_ROLES`'ten `Object.entries()` ile canlı üretiliyor; böylece gerçek yetki kontrolünden asla sapamaz. Her rol satırında yetki sayısı + açılır `<details>` ile kod listesi (boş yetkili `subcontractor` rolü için açıklayıcı not).
  4. İçe/dışa aktarma yönergeleri (5 madde, W39 import sihirbazı ve uzlaşma göstergesine atıfla).
  5. Video/dosya kullanımı (W27 video altyapısına atıfla).
  6. AI önerisi nasıl incelenir (6 madde, W31'in gerçek mekaniğine dayalı: LLM bağlanmadıkça "AI yorumu değil" notu, kural tabanlı hesap vs. AI yorumu ayrımı, bağımsız doğrulama zorunluluğu).
  7. Hatalı işlem düzeltme rehberi (6 madde).
  8. Destek talebi politikası (4 satır: Kritik/Yüksek/Normal/İyileştirme × tanım/sorumlu/eskalasyon) — sözleşmeyle taahhüt edilmiş bir SLA olmadığı açıkça belirtiliyor.
  9. Canlı geçiş kontrol listesi (8 madde) — nihai kabulün hâlâ pilot ve kritik testler gerektirdiği açıkça belirtiliyor.
- `apps/web/src/App.tsx`: `HelpPage` import edildi; `NAV` dizisine `perm` alanı olmayan (tüm iç kullanıcılara görünen) `{ to: "/help", key: "nav.help" }` eklendi; `/help` rotası eklendi.
- `packages/shared/src/i18n.ts`: `nav.help` anahtarı (tr: "Yardım & eğitim", en: "Help & training").
- **Testler**: yeni bir API rotası eklenmediği için yeni backend testi yazılmadı (mevcut 204/204 paket bu değişiklikten etkilenmiyor). `pnpm -r exec tsc --noEmit` ve `npx vite build` temiz.
- **Doğrulama**: API + web sunucuları yerelde ayağa kaldırılıp gerçek Chromium (Playwright) ile `depo@demo.apisfactory.com` kullanıcısıyla `/help` sayfası uçtan uca gezildi; tam sayfa ekran görüntüsünde 9 bölümün tamamı, yetki matrisinin `admin` satırındaki `<details>` açılışının gerçek yetki kodlarını gösterdiği (`admin.users, admin.roles, audit.view, task.view, org.manage, delegation.manage`) doğrulandı.

Kalan: bu bir içerik/dokümantasyon sayfası olduğu için "kalan" işlevsel bir eksik değil — içerik zamanla (yeni rol/özellik eklendikçe) güncellenmeye ihtiyaç duyacak, özellikle rol rehberleri elle yazıldığından yeni bir rol eklenirse ayrıca eklenmesi gerekir (yetki matrisi otomatik güncellenir, rol rehberleri güncellenmez).

## Oturum 39 devamı — W39 devamı: müşteri/tedarikçi ana veri içe aktarımı

**Durum: uygulandı, otomatik testleri geçti, gerçek tarayıcıda (yerel geliştirme ortamı) uçtan uca doğrulandı.** Dış bağımlılık gerektirmiyor.

W33 işi teslim edildikten sonra §12 sırasına göre bir sonraki kod ile ilerletilebilecek net kalem olarak W39 (tarihsel veri geçişi) seçildi — dış sağlayıcı/pilot kararı gerektirmeyen, mevcut import altyapısını doğal olarak genişleten bir dilim: müşteri ve tedarikçi ana veri (master data) içe aktarımı.

**Ne yapıldı:**
- `apps/api/migrations/035_master_data_import.sql`: `import_jobs.kind` CHECK kısıtına `'customers'`/`'suppliers'` eklendi.
- `packages/shared/src/schemas.ts`: `CustomerImportPreviewInput`, `SupplierImportPreviewInput`.
- `apps/api/src/modules/imports.ts`: `POST /api/imports/customers/preview` (yetki: `sales.create`) ve `POST /api/imports/suppliers/preview` (yetki: `supplier.manage`) — BOM/stok ile aynı CSV → kolon eşleştirme → sunucu doğrulaması akışı, ama **hareket değil upsert**: kod eşleşirse ad (tedarikçide ayrıca iletişim e-postası/varsayılan teslim süresi) güncellenir, yoksa yeni kayıt açılır (`insert ... on conflict (company_id, code) do update ...`, `xmax = 0` ile oluşturuldu/güncellendi ayrımı). Bu yüzden BOM/stok'taki "yeni kalem"/"belirsiz" durumları burada yok — yalnız "ok"/"hatalı" (boş kod/ad, dosya içi mükerrer kod, tedarikçide geçersiz teslim süresi). Commit uç noktasındaki ortak T13 kuralı (aynı dosya aynı türe iki kez işlenemez) burada da geçerli.
- Web: `Imports.tsx`'e mevcut `CsvWizard` bileşeni yeniden kullanılarak iki yeni bölüm eklendi (yetkiye göre gösterilir/gizlenir); geçmiş işler tablosundaki tür etiketi genişletildi.
- **Testler**: `apps/api/test/master-data-import.test.ts` (3 yeni test: müşteri içe aktarımı — yeni/güncelleme/mükerrer/boş kod/hatalı satırla onay reddi/aynı dosya ikinci kez işlenmez; tedarikçi içe aktarımı — isteğe bağlı alanlar, geçersiz teslim süresi reddi; RLS izolasyonu). Toplam **203/203** otomatik test geçti; `tsc --noEmit` ve `vite build` temiz.
- **Doğrulama**: migration yerel geliştirme veritabanına uygulandı; gerçek Chromium (Playwright) ile demo hesaplarla uçtan uca çalıştırıldı — satış kullanıcısı 2 satırlık bir müşteri CSV'sini içe aktardı (`created:2`), satın alma kullanıcısı iletişim e-postası ve teslim süresi olan bir tedarikçi CSV'sini içe aktardı (`created:1`); her ikisi de "Geçmiş işler" listesinde doğru etiketle (Müşteriler/Tedarikçiler) göründü.

Kalan (W39'un hâlâ açık kısmı): açık sipariş, tarihsel üretim/kalite/maliyet kayıtları ve AP/AR (borç/alacak) göçü. Bunlar da dış bağımlılık gerektirmiyor, ileri bir oturumda aynı desenle eklenebilir.

**Ek (aynı gün, W39 devamı): kaynak-hedef uzlaşma göstergesi.** `GET /api/imports` artık her onaylanmış iş için `reconciliation: { sourceRows, targetRows, matched }` döndürüyor — kaynak = onaylanan işin kaydettiği önizleme satır sayısı (T13 onay kapısı geçildiği için hatalı/çözümsüz satır kalmadığı garanti), hedef = türe göre gerçekte oluşan kayıt sayısı (BOM satırı / stok hareketi / oluşturulan+güncellenen ana veri kaydı). Web'de "Geçmiş işler" tablosuna bir "Uzlaşma" sütunu eklendi; uyuşmazlık olursa (örn. sessizce atlanan bir çakışma) kırmızı "UYUŞMUYOR" rozetiyle işaretlenir — bugüne kadarki tüm iş türlerinde (BOM, açılış stoğu, müşteri, tedarikçi) geriye dönük olarak da doğru hesaplanıp gösterildiği gerçek tarayıcıda doğrulandı. Yeni test: `master-data-import.test.ts`'e eklenen uzlaşma testi (henüz onaylanmamış bir iş için uzlaşmanın `null` döndüğü de dahil). Toplam **204/204** otomatik test geçti.

## Oturum 39'da eklenenler (W33 devamı: kurutma/yeniden uygunluk (bake-out) reçetesi ve çevrimi)

**Durum: uygulandı, otomatik testleri geçti, gerçek tarayıcıda (yerel geliştirme ortamı) uçtan uca doğrulandı.** Dış bağımlılık gerektirmiyor — tamamen kendi altyapımızda; sağlayıcı test ortamı/canlı doğrulama bu iş paketi için geçerli değil (dış sağlayıcı yok).

**Tasarım kararı — JEDEC tablosu neden sabit kodlanmadı:** Resmî JEDEC J-STD-033 bake-out sıcaklık/süre tablosu burada uydurulmadı. Gerekçe: (1) gerçek değerler cihaz paket kalınlığına ve MSL seviyesine göre üreticiden üreticiye değişir, bu ayrıntı düzeyinde genel bir tablo güvenilir olmaz; (2) önceki oturumun devam notu bu tabloyu zaten "üretici prosedürüne bağlı, şirket karar verince eklenebilir" diye bilinçli olarak açık bırakmıştı; (3) tıbbi cihaz üreten bir şirket için güvenlik parametresi uydurmak, bu projenin en temel kuralı olan "veri uydurma" yasağını ihlal eder. Bunun yerine `cost_policies` ile aynı sürümleme deseninde (sürümler değişmez, yeni sürüm eskisini geçersiz kılmaz), her sürümde zorunlu bir `source` alanı (üreticinin datasheet/prosedür referansı) taşıyan bir "kurutma reçetesi" sistemi kuruldu — kalite ekibi tanımlar, sistem hiçbir sayıyı kendiliğinden önermez.

**Ne yapıldı:**
- `apps/api/migrations/034_dryout.sql`: `equipment.kind` CHECK kısıtına `'oven'` eklendi (fırın da bir ekipman — mevcut kalibrasyon/hizmet dışı koruması T12'deki test ekipmanıyla aynı desenle "bedavaya" geliyor). Yeni `dryout_recipes` (sürümlü, RLS'li) ve `dryout_cycles` (lot başına aynı anda tek açık çevrim — kısmi eşsiz indeks) tabloları. `lots.floor_life_reset_at` sütunu eklendi.
- `apps/api/src/modules/storage.ts`: `floorLifeClockStart()` yardımcı fonksiyonu — kullanım süresi (floor life) saatinin başlangıcını paket açılışı ile en son tamamlanmış kurutma çevriminin hangisi daha yeniyse ona göre hesaplar; **raf ömrünü (toplam maruziyet) hiçbir şekilde değiştirmez**. Yeni uçlar: `GET/POST /api/dryout-recipes`, `POST /api/lots/:id/dryout/start` (fırın türü/hizmet durumu/kalibrasyon geçerliliği kontrolü — `not_oven`/`equipment_out_of_service`/`calibration_expired`/`already_in_progress`), `POST /api/lots/:id/dryout/:cycleId/complete` (yalnız `status:'completed'` kullanım süresini sıfırlar; `'aborted'` hiçbir şeyi değiştirmez), `GET /api/lots/:id/dryout`.
- `apps/api/src/modules/quality.ts`: ekipman oluşturma uç noktasının zod şemasına `'oven'` türü eklendi (migration'daki DB kısıtıyla eşleşmesi için).
- Web: `Quality.tsx`'e "Kurutma (bake-out) reçeteleri" bölümü (kalite ekibi için sürüm listesi + yeni sürüm formu, `source` alanı zorunlu); `Inventory.tsx`'te açılmış paketli MSL'li lotlarda "Kurutma" düğmesi → genişleyen panelde geçmiş, açık çevrim varsa gerçekleşen sıcaklık/süre girip kapatma formu, yoksa reçete+fırın seçip başlatma formu.
- **Testler**: `apps/api/test/dryout.test.ts` (5 yeni test: reçete sürümleme ve zorunlu kaynak alanı; fırın olmayan/hizmet dışı/kalibrasyonu geçmiş ekipmanla başlatma reddi + yetkisiz rol reddi; çevrim başlatma → aynı lotta ikinci açık çevrim reddi → tamamlama → yalnız kullanım süresinin ileri gitmesi + raf ömrünün değişmemesi + kapanmış çevrimin ikinci kez kapatılamaması; yarıda kesilen çevrimin kullanım süresini sıfırlamadığının doğrulanması; RLS izolasyonu). Toplam 200/200 otomatik test geçti (`vitest run`). `pnpm -r exec tsc --noEmit` temiz. `vite build` temiz.
- **Doğrulama**: migration hem test veritabanına (`vitest`'in otomatik migration'ı üzerinden) hem de yerel geliştirme veritabanına (`apisfactory`) elle uygulandı; API + web sunucuları yerelde ayağa kaldırılıp gerçek Chromium (Playwright) ile demo hesaplarla uçtan uca çalıştırıldı: kalite kullanıcısı reçete v1'i (125°C/24sa, kaynak: "JEDEC J-STD-033D.1 Tablo 4-1 (E2E doğrulama)") tanımladı; teknisyen kullanıcısı MSL 3 bir kalemin açılmış lotunda kurutma fırınıyla çevrimi başlattı, gerçekleşen 124.5°C/25 saat girerek tamamladı — ekran görüntüleri lotun "kullanım sonu" tarihinin çevrim bitişinden itibaren ileri gittiğini, "raf ömrü" alanının (hiç girilmediği için) etkilenmeden boş kaldığını ve kurutma geçmişi tablosunda "Tamamlandı" kaydını doğruladı.

Kalan (bu iş paketinin dışında, §12 sırasına göre sonraki adımlar): gerçek pilot verisiyle deneme (W42/pilot aşaması), harici takvim/kalibrasyon hatırlatma bildirimleri gibi ek otomasyonlar şu an kapsam dışı — istenirse ayrıca eklenir.

## Oturum 38'de eklenenler (W30/W31: yönetici raporları + stratejik AI önerisi)

1. **8 rapor alanı, kural tabanlı (deterministik) hesap** (`apps/api/src/lib/report-findings.ts`): fire ve yeniden işleme (mevcut `scrap_rate`/`first_pass_yield`/`rework_rate` metriklerini yeniden kullanır), gerçek maliyet ve kârlılık (mevcut `/api/reports/margin` hesabı `computeMarginReport` olarak dışa aktarılıp yeniden kullanıldı), tedarikçi performansı (teyit tarihi vs gerçek teslim gecikmesi, giriş kalite ret oranı, toplam satın alma tutarı — yeni SQL), stok ve eksik malzeme (aktif rezervasyon vs eldeki stok vs açık satın alma — yeni SQL), kapasite ve termin (iş merkezi kuyruk derinliği, çevrim süresi, geciken iş emirleri — yeni SQL), revizyon etkisi (revizyon öncesi/sonrası hurda/ilk-test-başarı karşılaştırması, asgari 5 cihazlık örneklem şartı), proje bütçesi (proje/bütçe modülü hiç yok — her zaman dürüstçe "yeterli veri yok"), tahsilat (`customer_invoices`/`customer_receipts` üzerinden vadesi geçmiş tutar).
2. **AI bu oturumda yapılandırılmadı — bu gizlenmedi, dürüstçe işaretlendi.** Hiçbir LLM/AI sağlayıcısı bağlı değil (dış bağımlılık: hangi sağlayıcı, hangi API anahtarı — sohbette istenmedi). Bulgu/kanıt/olası-neden/seçenek metni tamamen gerçek sayılardan kural tabanlı üretiliyor; bu bir AI yorumu DEĞİL. `report_findings.cause_type` sütununun CHECK kısıtı yalnızca `'hypothesis'` ve `'insufficient_data'` değerlerini kabul eder — `'confirmed'` (doğrulanmış neden) hiçbir kod yolundan asla yazılamaz; bu, talimatın "bir hipotezi kanıtlanmış neden gibi sunma" kuralını veri tabanı düzeyinde zorlar. `ai_status`/`ai_narrative` alanları `'unavailable'`/boş kalır; ekranda "AI servisi (LLM) bu oturumda yapılandırılmadı" notu açıkça gösterilir.
3. **W31 yaşam döngüsü**: öneri (bulgu) → inceleme görevi (`openTask`, sorumlu role) → onay/red/erteleme (`report.suggestion.decide`, yalnız yönetici rolü) → onaylananda baz değer/hedef/ölçüm aralığı/uygulama maliyeti kilitlenir + uygulama görevi açılır → ölçüm kaydı → **bağımsız doğrulama** (ölçen kişi kendi ölçümünü doğrulayamaz — 403) → kapatma → gerekçeli yeniden açma. Beklenen fark (hedef−baz) ile gözlenen fark (ölçülen−baz) ayrı raporlanır; ikisi otomatik olarak eşitlenmez ve fark tamamı AI'ya atfedilmez (kur/karma/eşzamanlı değişiklik uyarısı metinde var). Aynı bulgudan ikinci kez öneri/görev açılmaz (409).
4. **Yeni tablolar** (`033_reports_ai.sql`): `report_findings` (her hesaplamanın sabit kopyası, `calc_version`), `ai_suggestions` (W31 kayıtları) — ikisi de RLS ile şirket izolasyonlu.
5. **API**: `GET /api/reports/executive` (canlı, kaydetmez), `POST /api/reports/generate` (kalıcı kayıt + görev), `GET/POST /api/reports/findings...`, `POST /api/reports/suggestions/:id/{measure,verify,reopen}`. Yeni izin `report.suggestion.decide` (yalnız `manager` rolü; vekâlet edilebilir).
6. **Web**: `/reports/executive` — 8 alan kartı (bulgu, olası neden/alternatif, seçenekler, belirsizlik), "Bulguları kaydet ve inceleme görevi aç", bekleyen kararlar formu (onayla/reddet/ertele), onaylanan önerilerde ölçüm/bağımsız doğrulama/yeniden açma paneli.
7. **Test**: `apps/api/test/reports.test.ts` 13 yeni test (toplam 195/195 geçti); `tsc --noEmit` temiz.
8. **Doğrulama**: gerçek tarayıcı (Playwright, bu ortamdaki Chromium) ile yerel API + Postgres dev veritabanına karşı giriş → `/reports/executive` → "Bulguları kaydet" uçtan uca çalıştırıldı ve ekran görüntüleriyle doğrulandı. Demo veri setinde seçilen dönemde üretim/satış hareketi olmadığından 8 alan da dürüstçe "yeterli veri yok" gösterdi (bu doğru davranıştır — bkz. madde 2); onay→görev→ölçüm→bağımsız doğrulama→kapatma/yeniden açma akışı gerçek veriyle `reports.test.ts` içinde uçtan uca kapsanıyor. **Gerçek pilot verisiyle (canlı üretim/satış hareketi olan bir dönemde) henüz denenmedi — bu W42/pilot aşamasının konusu.**

Durum (altı kademeli rubrik): **uygulandı, otomatik testleri geçti, gerçek tarayıcıda doğrulandı (yerel geliştirme ortamı)**. Sağlayıcı test ortamı/canlı doğrulama bu alan için geçerli değil (dış sağlayıcı yok); AI yorum katmanı **geliştirilmedi** (dış bağımlılık: LLM sağlayıcı seçimi ve API anahtarı — sohbette istenmedi, ortam değişkeni adı önerilecek: `AI_PROVIDER`, `AI_API_KEY`).

## Oturum 37'de eklenenler (W27: video/nesne depolama altyapısı)

**Durum: uygulandı, otomatik testleri geçti.** Gerçek bir MP4 dosyası Playwright ile tam kullanıcı
akışından (giriş → kanal → video seç → yükleme ilerlemesi → mesaja ekle → gönder → indir/oynat)
uçtan uca doğrulandı; ayrıca 24 otomatik test (13 yeni: 11 `storage-video.test.ts` + 2 genişletilmiş
`subcontract.test.ts`) backend'de geçiyor (toplam 193/193). Dış bağımlılık (sağlayıcı hesabı vb.)
gerektirmiyor — tamamen kendi altyapımızda.

**Ne yapıldı:**
- `apps/api/migrations/032_object_storage_video.sql`: `message_attachments` ve
  `subcontract_job_files` tablolarına `object_key`/`storage_backend`/`duration_seconds` eklendi;
  `content bytea` NULL olabilir yapıldı (eski satırlar **taşınmadı/silinmedi** — bkz. kalanlar).
  Yeni `staged_uploads` tablosu (RLS'li) — video önce buraya ön-yüklenip doğrulanıyor.
- `apps/api/src/lib/storage.ts`: `ObjectStorage` arayüzü + `LocalDiskStorage` (tek gerçek
  uygulama; S3/MinIO henüz yok — `STORAGE_BACKEND` ortam değişkeniyle ileride eklenecek).
- `apps/api/src/lib/media.ts`: gerçek dosya türü tespiti (magic bytes — istemci beyanına
  güvenilmiyor) ve `ffprobe` ile gerçek süre/codec ölçümü (bozuk dosyada `null` döner, uydurulmaz).
- `apps/api/src/app.ts`: `video/mp4`/`video/webm` için ayrı ham-ikili content-type parser (210 MB
  bodyLimit) — genel 8 MB sınırının üstünde, yalnız bu iki tür için.
- `POST /api/attachments/video/stage`: video önce burada yüklenir; gerçek tür/boyut/süre
  sunucuda doğrulanır (200 MB / 5 dk varsayılan sınır — devam talimatı §2), `staged_uploads`a
  yazılır.
- `collaboration.ts` (mesajlar) ve `subcontract.ts` (fason iş dosyaları): mesaj/dosya oluşturma
  uçları artık hem eski satır-içi base64 ekleri (değişmeden) hem de `stagedUploadId` referansıyla
  video eklerini kabul ediyor (Zod discriminated union); indirme uçları `object_key` varsa nesne
  depolamadan, yoksa eski `content` bytea'dan okuyor.
- Web: `Discussion.tsx` (mesajlaşma/kanallar) ve `Subcontract.tsx` (fason iş dosyaları) — "Video
  ekle" düğmesi, yükleme ilerlemesi (%), gerçek süre gösterimi, oynatma (tarayıcının yerel video
  oynatıcısı, yeni sekmede). Ayrıca `Subcontract.tsx`'te önceden var olan ama **hiç çalışmayan**
  bir kusur düzeltildi: dosya indirme linki düz `<a href>` idi ve Authorization başlığı
  taşımadığından 401 verirdi (kimse fark etmemiş olabilir çünkü hiçbir otomatik test tarayıcıda
  tıklama denemiyordu) — artık `openDownload()` ile blob indirme kullanıyor (Discussion.tsx'teki
  ile aynı, paylaşılan yardımcı fonksiyon).

**Testler:** `storage-video.test.ts` (11 test: LocalDiskStorage yaz/oku/sil, path-traversal
reddi, magic-byte tespiti, gerçek ffprobe süre ölçümü, bozuk dosya reddi, sahte/uyumsuz video
reddi, ön-yükle→iliştir→indir baytları birebir eşleşir, aynı ön-yüklemenin ikinci kullanımı
reddedilir, başkasının ön-yüklemesi çalınamaz, eski satır-içi ek desteği bozulmadı) +
`subcontract.test.ts`'e eklenen video testi (aynı deseni fason iş dosyalarında doğrular).
`pnpm -r exec tsc --noEmit` temiz, `npx vite build` başarılı.

**Bilinen kalanlar (bir sonraki oturuma):**
- Gerçek S3/MinIO bağlayıcısı yok — yalnızca yerel disk. Üretime geçmeden önce yazılmalı.
- Eski `content bytea` satırları nesne depolamaya **taşınmadı** (checksum karşılaştırmalı taşıma
  script'i yazılmadı) — talimat gereği erişim doğrulanmadan silinmedi, ikisi birlikte çalışıyor.
- Şirket/paket bazlı medya politikası (200 MB/5 dk sabit, yapılandırılabilir değil) yok.
- Terk edilmiş (mesaja hiç iliştirilmemiş) `staged_uploads` kayıtlarının temizlenmesi (ör. 24 saat
  sonra silme) yazılmadı.
- Async transkodlama yok (yüklenen video olduğu gibi saklanıyor/sunuluyor).
- Kalite bulgusu ve iade (RMA) kayıtlarına video ekleme henüz yok — yalnız mesajlaşma ve fason iş
  dosyaları kablolandı; talimatta bu ikisi de "video eklenebilmeli" listesinde.
- Toplantı kaydı için ayrı bir saklama/retention politikası (talimatta istenen) yok.
- 200 MB/5 dakikalık gerçek bir dosyayla üst sınır reddi otomatik testte doğrulanmadı (disk/süre
  maliyeti nedeniyle bilinçli olarak atlandı — kod incelemesiyle doğrulanabilir).

## Son doğrulanan durum

| Komut | Sonuç |
|---|---|
| `pnpm test` (api) | 170/170 test geçti (acceptance 16, production 10, quality 14, shipping 9, returns 12, costing 10, planning 6, workflow 13, station 4, routing 4, handover 3, collaboration 10, procurement 6, payables 5, receivables 4, distributors 5, alternates 7, dispatch 5, ops 4, storage 5, scenarios 6, subcontract 12), gerçek PostgreSQL 16 |
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
| Playwright uçtan uca (oturum 12) | Üretim sorumlusu toplantı açar (gündem, 3 katılımcı), karar ve aksiyon (sorumlu depo, 2 gün) ekler, notları kaydeder; katılım işaretlenmeden kapanış reddedilir; toplantı konuşmasında teknisyenden bahseder; tutanak kapanınca aksiyon depoya görev olur (Günlük işler'de); teknisyen "Bahsedildiğiniz mesajlar"dan konuşmaya gider, yanıtlar, bildirim okundu olur; sayfa hatası yok |
| Playwright uçtan uca (oturum 13) | Ar-Ge talep açar; satın alma onaylar → "Teklif iste" → iki DEMO tedarikçiden teklif (en ucuz ihtiyaç sonrası, en hızlı pahalı) → hızlıyı seçince gerekçe istenir → gerekçeyle taslak sipariş → test gönderimi → teyit → ileri kayma not ister, kayma 3 gün uyarısı; depo sipariş satırını seçerek mal kabul eder → sipariş "teslim alındı"; tedarikçi performansı; sayfa hatası yok |
| Playwright uçtan uca (oturum 14) | Oturum 13 akışının devamı: kalite 190 kabul / 10 ret; muhasebe faturayı girer (faturalanabilir satır listeden, fiyat 5,10 vs sipariş 4,90 → %4,08 fiyat farkı), önizleme "fark var", kaydedince onaya düşer ve giren onaylayamaz; yönetici gerekçeyle onaylar; yaşlandırma; muhasebe banka referansıyla ödeme kaydı girer → "ödendi"; sayfa hatası yok |
| Playwright uçtan uca (oturum 15) | Muhasebe sevk edilmiş sevkiyattan taslak fatura (4 × 250 + %20) → 45 gün önceki tarihle keser (vadesi geçti) → kredi limiti 5.000 ve gecikme sınırı 7 gün tanımlar (müşteri "engelli"); satış yeni siparişi kesinleştiremez (`credit_blocked`, 15 gün gecikme); yönetici gerekçeyle serbest bırakır, satış kesinleştirir; muhasebe banka referansıyla tahsilat kaydı girer → "tahsil edildi"; sayfa hatası yok |
| Playwright uçtan uca (oturum 16) | Satın alma DigiKey'i TEST moduna alıp DEMO tedarikçiye bağlar, Mouser'ı fiyat dosyası moduna alıp CSV yükler; RFQ sayfasında distribütör teklifleri (TEST VERİSİ rozeti, alınma zamanı) ve "otomatik teklif" → DigiKey teklifi eklenir, Mouser atlanır (tedarikçiye bağlı değil); Ar-Ge BOM tedarik görünümünü hesaplar; sayfa hatası yok |
| Playwright uçtan uca (oturum 17) | Satın alma CMP-CAP-01 için kural tabanlı adaylardan CMP-CAP-02'yi seçip kanıtla önerir; Ar-Ge notsuz onayda "kanıt eksik" uyarısı alır, notla onaylar; üretim onaylayınca durum Onaylı; kalite gerekçeyle geri alır; sayfa hatası yok |
| Playwright uçtan uca (oturum 18) | Muhasebe e-belge bağlayıcısını (Uyumsoft) TEST moduna alır; depo kargo bağlayıcısını (Yurtiçi Kargo) TEST moduna alır; sayfa hatası yok |
| Playwright uçtan uca (oturum 19) | Üretim yeni kanal açar, fotoğraf ekleyip mesaj gönderir; ek mesajda rozet olarak görünür ve indirilebilir; sayfa hatası yok |
| Playwright uçtan uca (oturum 20) | Yönetici bağlayıcı panosunu açar; distribütör/e-belge/kargo bölümleri BAĞLANMADI ve sıfır etkinlikle görünür; sayfa hatası yok |
| Playwright uçtan uca (oturum 21) | Satın alma alternatif önerir, Ar-Ge ve üretim onaylar; üretim kanıt & tartışmayı açıp fotoğraf ekli mesaj gönderir; sayfa hatası yok |
| Playwright uçtan uca (oturum 22) | Depo mal kabul yapar; kalite MSL/kullanım süresi/raf ömrü/FEFO ve lot son kullanma tarihini girer; depo paketi açar, kullanım süresi sonu hesaplanır; sayfa hatası yok |
| Playwright uçtan uca (oturum 23) | Yönetici senaryo sayfasında 1000 adet + fason senaryosu ve ek vardiya senaryosu hesaplar; temin süresi tanımsız kalemde dürüstçe "hesaplanamadı" gösterilir; sayfa hatası yok |
| Playwright uçtan uca (oturum 24) | Üretim fason iş önerir; dış kullanıcı (fason firma) kendi girişinde kabul eder; üretim kabulden hemen sonra malzeme fasona gönderir ve bir miktar fireyi imha eder (gerçek stok düşüşü); dış kullanıcı ileri yönde ilerletir (hazırlık→üretimde→testte→sevke hazır) ve sağlam/fire/kullanılmayan beyan eder; üretim çıktıyı kesin kabul eder (yeni lot + giriş kalite görevi, "tamamlandı"); liste satırı durumu her adımda canlı güncellenir; sayfa hatası yok |
| Playwright uçtan uca (oturum 25) | FEFO politikalı kalemin üç lotu (süresi geçmiş/yakında dolacak/iyi) olduğu bir iş emrinde depo "Çıkış yap" açar; lot açılır listesi süresi en yakın (geçmiş) lotu otomatik önerir, SKT ve "SÜRESİ GEÇTİ" etiketiyle; kırmızı uyarı bandı gösterilir; sayfa hatası yok |
| Mobil (oturum 26) | `tsc --noEmit` temiz, `EXPO_OFFLINE=1 expo export --platform android` başarılı (yeni bağımlılıklar expo-document-picker/expo-file-system dahil paketlendi); gerçek cihazda/simülatörde çalıştırılmadı (bu ortamda mobil emülatör yok — önceki oturumlardaki gibi derleme+tip denetimiyle doğrulandı) |
| Playwright uçtan uca (oturum 27) | Bir fason iş kabul→malzeme gönder/fire imha→ilerlet→beyan→kesin kabul ile tamamlanır; yönetici Fason işleri sayfasında "Fasoncu performansı" açar: 1 toplam/1 tamamlanan iş, 1 zamanında/0 geç, termin oranı %100, kabul edilen 9 adet, fire oranı %10; sayfa hatası yok |
| Mobil (oturum 28) | `tsc --noEmit` temiz, `EXPO_OFFLINE=1 expo export --platform android` başarılı; backend/web dokunulmadı, tam test paketi (164/164) yine de yeniden çalıştırılıp doğrulandı; gerçek cihazda/simülatörde çalıştırılmadı (bu ortamda mobil emülatör yok) |
| Mobil (oturum 29) | `tsc --noEmit` temiz, `EXPO_OFFLINE=1 expo export --platform android` başarılı (yeni bağımlılık expo-sharing dahil paketlendi); backend/web dokunulmadı; gerçek cihazda/simülatörde çalıştırılmadı |
| Playwright uçtan uca (oturum 30) | Bir fason iş kabul→malzeme gönder (10)/fire imha (1)→ilerlet→beyan→kesin kabul (9) ile tamamlanır; iş detayında "Malzeme izlenebilirliği" paneli: girdi lotu USAGE-LOT1 için gönderilen 10 / iade 0 / fire 1 / net tüketilen 9, çıktı lotu USAGE-OUT-1 için 9 adet; sayfa hatası yok |
| Playwright uçtan uca (oturum 31) | Yönetim toplantı açar (gündem, yer, katılımcı); toplantı detayında "Takvime ekle (.ics)" düğmesine tıklanır, tarayıcı gerçek bir dosya indirir (`toplanti-TOP-000001.ics`); indirilen dosya `BEGIN:VCALENDAR`, başlık, yer ve `mailto:` katılımcı satırlarını içerir; sayfa hatası yok |
| Mobil (oturum 32) | `tsc --noEmit` temiz, `EXPO_OFFLINE=1 expo export --platform android` başarılı; backend/web dokunulmadı (mevcut `/api/tasks/delegated` ucu yeniden kullanıldı), tam test paketi (166/166) yine de yeniden çalıştırılıp doğrulandı; gerçek cihazda/simülatörde çalıştırılmadı |
| Playwright uçtan uca (oturum 33) | Yönetici satın alma politikası yayımlar (satın alma 1.000 TRY, yönetici sınırsız); talep→onay→RFQ→yüksek teklif (birim 25 TRY, toplam 1.250 TRY)→gerekçeyle ödül; satın alma rolü siparişi gönderemez ("Tutar 1250.000000 TRY; onay limitiniz 1000.00 TRY (over_limit)", yöneticiye görev açılır); yönetici aynı siparişi gönderir → "gönderildi (test)", işlem geçmişinde `approval.blocked.over_limit` → `sent`; sayfa hatası yok |
| Playwright uçtan uca (oturum 34) | Yeni fason iş formunda "Bağlı iş emri (isteğe bağlı — maliyete yansır)" seçici doğrulandı; bir iş emrine bağlı fason iş (dış test, 300 TRY) kabul→ilerlet→beyan→kesin kabul ile tamamlanır; iş emrinin Maliyet panelinde "dış hizmet 300" KPI özetinde ve ayrı "FASON İŞ" tablosunda (SJ-000001, Tamamlandı, 300 TRY) görünür; toplam malzeme+işçilik+genel+dış hizmete göre güncellenir; sayfa hatası yok |
| Playwright uçtan uca (oturum 35) | Yönetici satın alma politikasını iki seviyeli yükseltmeyle yayımlar (yönetici → muhasebe); Akış & onay ekranındaki politika tablosunda "Yönetici → Muhasebe" zinciri ve sürüm geçmişinde not görünür; talebin onay görevi süresi geçince birinci yükseltme (yönetici) açılır; o da süresi geçince birinci görev kapanır ve ikinci yükseltme (muhasebe) açılır; muhasebe kullanıcısı İzleme & müdahale ekranını hatasız görür; sayfa hatası yok |
| Playwright uçtan uca (oturum 36) | Bir iş emrine bağlı fason iş (SJ-000001) önerilir; iş emrinde ECR açılıp "beklet" kararıyla onaylanınca fason iş detayında "İncelemede: DT-000001: bağlı iş emri "beklet" — ..." kırmızı bandı ve liste satırında "İncelemede" rozeti görünür; satın almaya karar görevi düşer; üretim gerekçeyle "Durdur" seçince durum "İptal" olur, inceleme bandı ve görev kalkar; sayfa hatası yok |
| `pnpm test` (api, oturum 37) | 193/193 test geçti (170 + storage-video.test.ts 11 + subcontract.test.ts'e eklenen 1 video testi + subcontract diğer testler; tam liste yukarıdaki gibi + storage-video), gerçek PostgreSQL 16, gerçek ffprobe |
| Playwright uçtan uca (oturum 37) | Gerçek (2 saniyelik, libx264) bir MP4 dosyasıyla: giriş → yeni kanal oluştur → "Video ekle" ile dosya seç → yükleme ilerlemesi (%) → ek çipi gerçek süreyi gösterir (0:02, sunucu ffprobe'dan) → mesaja ekleyip gönder → konuşmada ek gerçek süreyle listelenir → eke tıklanınca yeni sekmede tarayıcının yerel video oynatıcısı (blob URL) açılır; sayfa hatası yok |

## Oturum 36'da eklenenler (W32 devamı: ECR kararının bağlı fason işine yansıması)

1. **Bağlı fason işi incelemesi**: "Bilinen sadelik: revizyon geldiğinde devam/durdur otomasyonu yok" notu kapatıldı. Bir değişiklik talebi (ECR) kararında bir iş emri için "beklet", "devam, sonra yeniden işle" veya "kalanı iptal" seçilirse ve o iş emrine bağlı, henüz tamamlanmamış (completed/rejected/cancelled dışı) fason iş(ler)i varsa, sunucu bunu dış firmaya **hiçbir şey otomatik iletmez/varsaymaz** — yalnızca fason işi `review_reason` ile "incelemede" işaretler, olay kaydeder ve satın alma rolüne "devam/durdur/yeniden işle kararı gerekli" görevi açar (kod ile ilerletilebilecek, insan kararı gerektiren gerçek bir otomasyon: karar hâlâ insanda, ama artık görünürlük ve görev takibi var).
2. **Karar**: yeni `POST /api/subcontract-jobs/:id/review-decision` (`subcontract.manage`, yalnız iç personel) — `continue` (incelemeyi temizler), `stop` (işi `cancelled` yapar — zaten tamamlanmış/reddedilmiş/iptal işte reddedilir), `rework` (incelemeyi temizler, notu olayda kalır). İncelemede olmayan işte karar denemesi `not_under_review` ile reddedilir.
3. Yeni sütun: `subcontract_jobs.review_reason` (migration 031, nullable). Web: iş detayında kırmızı "İncelemede: ..." bandı (yalnız iç personele karar butonları; dış firmaya salt "karar iç yönetimden bekleniyor" notu) ve liste satırında "İncelemede" rozeti.
4. `subcontract.test.ts`'e 1 yeni test (12/12, tam paket 170/170): tam ürün+BOM+devir+iş emri+bağlı fason iş akışıyla, ECR "beklet" kararının işi incelemeye düşürdüğü, görevin satın almaya açıldığı, kısa gerekçenin reddedildiği, "durdur" kararının işi iptal edip görevi kapattığı ve ikinci kez karar verilemeyeceği doğrulandı.
5. `tsc`/`vite build` temiz; Playwright E2E ile uçtan uca doğrulandı (bağlı fason iş önerilir → ECR beklet kararı → inceleme bandı ve liste rozeti gerçek ekran görüntüsünde → "Durdur" kararıyla iş iptal olur, bant kalkar).
6. **Kalan**: yalnız iki seviyeli bir zincir değil — devam/durdur/yeniden işle kararının kendisi hâlâ insan kararı (doğru davranış, sunucu tahmin etmiyor); "yeniden işle" kararı şu an yalnızca not düşer, ayrı bir yeniden-iş akışı (örn. malzeme/adet düzeltmesi) açmaz — ihtiyaç görülürse ayrı bir iş paketi olabilir.

## Oturum 35'de eklenenler (W10 devamı: iki seviyeli onay yükseltmesi)

1. **İki seviyeli yükseltme**: "Bilinen sorunlar ve sınırlar" listesindeki "Yükseltme tek seviye (üst rolün de süresi dolarsa ikinci yükseltme yok)" notu kapatıldı. Onay politikasına (`approval_policies`) isteğe bağlı ikinci bir üst rol (`escalate_to_role_2`, nullable) eklendi. Tanımlanmazsa davranış birebir eskisi gibi kalır (geriye dönük uyumlu) — yalnızca yönetici bir politikada bilinçli olarak ikinci seviye tanımlarsa yeni davranış devreye girer, hiçbir varsayılan tahmin edilmez.
2. **Davranış**: birinci yükseltme görevi (mevcut, değişmeyen mekanizma) açıldığında, politika ikinci bir rol tanımlıyorsa bu göreve de aynı `timeout_hours` kadar bir süre (`due_at`) verilir. O süre de geçerse ikinci bir tarama, birinci yükseltme görevini kapatır (üst üste iki açık görev bırakılmaz) ve ikinci role yeni bir yükseltme görevi açar. Orijinal talep karara bağlanınca mevcut kademeli kapatma mantığı (aynı `entity_id`) her iki seviyeyi de birlikte kapatır — bunun için yeni kod gerekmedi.
3. Route/şema: `POST /api/workflow/policies` yeni `escalateToRole2` alanı — bilinmeyen rol, admin (iş onayı almaz), birinci seviyeyle aynı rol veya birinci seviye tanımlanmadan ikinci seviye tanımlama denemeleri reddedilir (mevcut `admin_not_allowed`/`escalation_role_required` korumalarıyla aynı desen).
4. Web: Akış & onay ekranında politika tablosunda "Yönetici → Muhasebe" gibi zincir gösterilir; politika düzenleyicide birinci seviye seçilince koşullu olarak beliren "O da süresi geçerse (aynı süre) yükselt" ikinci rol seçici.
5. `workflow.test.ts`'e 1 yeni test (13/13, tam paket 169/169): politika iki seviye tanımlarsa, birinci yükseltme görevinin de süresi/vadesi olduğu, o vade de geçince birinci görevin kapanıp ikinci görevin doğru role açıldığı, üçüncü bir seviye olmadığından üçüncü turun hiçbir şey yapmadığı doğrulandı.
6. `tsc`/`vite build` temiz; Playwright E2E ile uçtan uca doğrulandı (politika iki seviyeli yayımlandı, birinci ve ikinci yükseltme sırayla tetiklendi, ekran görüntülerinde politika zinciri ve muhasebe kullanıcısının izleme ekranı hatasız görüldü).
7. **Kalan**: üçüncü ve sonrası seviye yok (kasıtlı — prompt'ta iki seviyeden fazlası istenmiyor); yükseltme e-postası/push bildirimi hâlâ yalnız test modundaki çıkış kutusuna yazılıyor (W10'un genel sınırı, bu oturumun kapsamı dışında).

## Oturum 34'de eklenenler (dış hizmet/fason maliyetinin iş emri maliyetine yansıması)

1. **Dış hizmet maliyeti**: `computeWorkOrderCost`'ta (`apps/api/src/modules/costing.ts`) sabit `external = 0n` idi (`externalNote: "Dış hizmet (fason) kaydı yok — W32"` ile açıkça işaretlenmiş bir eksikti). Artık bir iş emrine bağlı (isteğe bağlı, elle seçilen — sunucu tahmin etmez) fason iş(ler) varsa, **tamamlanmış** olanların anlaşılan fiyatı (`subcontract_jobs.price`, kabul/karşı teklif sonrası nihaileşen) dış hizmet kalemi olarak toplama girer. Tamamlanmamış bir bağlı iş varsa maliyete henüz sayılmaz; bunun yerine "eksik" listesine "durumu ... henüz tamamlanmadı" notu düşer — uydurulmaz. Para birimi politika para biriminden farklıysa (kur dönüşümü yok, mevcut malzeme kuralıyla tutarlı) aynı şekilde not düşülüp sayılmaz.
2. Yeni sütun: `subcontract_jobs.work_order_id` (migration 029, nullable, `work_orders(id)`). Fason iş oluşturma formunda (yalnız `production.view` yetkisi olanlara görünen) yeni "Bağlı iş emri" seçici; iş detayında bağlı iş emri kodu gösterilir.
3. Web: Maliyet panelinde (`Reports.tsx`'teki `WorkOrderCost`, `Production.tsx`'te iş emri detayına gömülü) "dış hizmet" tutarı KPI özetine eklendi; bağlı fason iş(ler) için ayrı bir tablo (kod, durum, fiyat, tutar, not).
4. `costing.test.ts`'e 1 yeni test (10/10, tam paket 168/168): bir iş emrine bağlı fason iş tamamlanmadan maliyete sayılmadığı (gaps'te not), tamamlanınca 250 TRY'nin dış hizmet toplamına ve genel toplama doğru yansıdığı doğrulandı.
5. `tsc`/`vite build` temiz; Playwright E2E ile uçtan uca doğrulandı (yeni ürün+BOM+revizyon+iş emri+dış test fason işi tamamlanana kadar götürüldü, Maliyet panelinde "dış hizmet 300" ve fason iş satırı gerçek ekran görüntüsünde görüldü).
6. **Kalan**: iade tamiri/hurda maliyetinin maliyete yansıması hâlâ yok (ayrı, benzer ama farklı bir bağlantı — iade akışına özgü); kur dönüşümü genel sınırı devam ediyor.

## Oturum 33'de eklenenler (satın alma sipariş onay limiti gönderim aşamasında)

1. **Sipariş gönderiminde onay limiti kontrolü**: "Bilinen sorunlar ve sınırlar" listesindeki "sipariş onay limiti (W10 politikası) sipariş aşamasına bağlanmadı" notu kapatıldı. Yeni bir onay politikası türü eklenmedi — mevcut `purchase_request` politika türü (oturum 8, `approval_policies`/`approval_limits`, `evaluateApproval`/`assertApproval`/`withApproval`) `POST /api/purchase-orders/:id/send` uç noktasında yeniden kullanıldı. Talep onayında kontrol edilen tutar RFQ öncesi **tahmini** tutardır; RFQ ödülünden sonra gerçek sipariş toplamı (en ucuz olmayan, gerekçeli seçilen bir teklif nedeniyle) tahminden yüksek çıkabilir — bu oturumda gönderim anında gerçek toplam üzerinden **aynı rol bazlı parasal limitler** tekrar kontrol ediliyor.
2. **Davranış**: limit aşılırsa gönderim engellenir (`over_limit`, siparişi açan role görev açılır, üst role — politika neyse — yükseltme görevi); politikanın izin verdiği (veya sınırsız) bir rol gönderirse eski akış aynen işler (durum güncellenir, çıkış kutusuna test gönderimi yazılır, olay kaydedilir) ve varsa açık yükseltme görevi kapatılır. Talebin bağlı olmadığı doğrudan RFQ'larda (`requesterId` yok) kendi-onay kontrolü zararsızca atlanır, tutar limiti yine de uygulanır.
3. **Geriye dönük uyumluluk**: hiçbir demo/test şirketinde varsayılan bir onay politikası yoktur (`seed.ts`'de kontrol edildi) — politika tanımlanmamış şirketlerde `evaluateApproval` `{allowed:true, approverLimit:"unlimited"}` döner, yani bu kontrol var olan hiçbir akışı değiştirmez (procurement.test.ts, 2.100 TRY'lik bir sipariş göndermesine rağmen politika tanımlı olmadığından değişmeden 6/6 geçti).
4. `workflow.test.ts`'e 1 yeni test (12/12, tam paket 167/167): mevcut politika (satın alma 1.000 TRY, yönetici sınırsız, yönetici'ye yükseltme) altında satın alma rolünün limiti aşan bir siparişi gönderemediği, görevin açıldığı, yöneticinin gönderebildiği ve gönderim sonrası yükseltme görevinin kapandığı doğrulandı.
5. `tsc`/`vite build` temiz (web tarafında kod değişikliği gerekmedi — Procurement.tsx'teki genel `ErrorNotice` bileşeni yeni `over_limit` hatasını da otomatik gösteriyor); Playwright E2E ile doğrulandı (ekran görüntüsünde engelleme mesajı ve yöneticinin başarılı gönderimi doğru).
6. **Kalan**: çok kalemli RFQ/sipariş, kur dönüşümü, gerçek tedarikçi gönderimi hâlâ yok (bu oturumun kapsamı dışında, ayrı bilinen sınırlar).

## Oturum 32'de eklenenler ("Akış" bilinen sınırı: vekâlet mobilde gösterilmiyordu)

1. **Mobilde vekâleten bekleyen işler**: "Bilinen sorunlar ve sınırlar" listesindeki "Vekâlet mobilde gösterilmiyor" notu kapatıldı. `apps/mobile/src/screens.tsx`'teki `TasksScreen`'e, web'in Günlük işler sayfasındaki "Vekâleten bekleyen işler" kartının salt okunur bir karşılığı eklendi — aynı mevcut uç (`GET /api/tasks/delegated`), yeni backend değişikliği yok. Liste başlığı + "vekâleten: <kimin adına>" + bitiş/gecikti bilgisini gösterir; web'deki gibi ayrı ekranlara derin bağlantı vermez (mobilde bu iş türlerinin çoğu için — satın alma, alacak vb. — zaten karşılık gelen bir ekran yok), yalnızca görünürlük sağlar.
2. Backend/web'de değişiklik yok (test sayısı sabit, 166/166); `pnpm -r exec tsc --noEmit` temiz; `EXPO_OFFLINE=1 expo export --platform android` başarılı.
3. Bu, oturum 30'daki ICS keşfiyle aynı yöntemle bulundu: "Bilinen sorunlar ve sınırlar" listesi tarandı, kod ile ilerletilebilecek küçük ve net bir kalan arandı.

## Oturum 31'de eklenenler (W28 devamı)

1. **Toplantı takvim daveti (.ics)**: "Bilinen sorunlar ve sınırlar" listesinde uzun süredir açık duran "takvim (ICS/Outlook) daveti yok" boşluğu kapatıldı. Yeni `GET /api/meetings/:id/ics` — standart bir RFC 5545 iCalendar dosyası üretir (satır katlama, kaçış karakterleri, `DTSTART`/`DTEND`/`SUMMARY`/`LOCATION`/`DESCRIPTION`/`ORGANIZER`/`ATTENDEE` alanları dahil, gündem + bağlı kayıt bilgisiyle); toplantının kendi tarih/süresinden hesaplanır, hiçbir şey uydurulmaz. Gerçek bir dış takvim/toplantı bağlayıcısı (Outlook/Google canlı senkron) hâlâ yok — bu, kullanıcının kendi takvim uygulamasına elle içe aktardığı statik bir dosya; bilinen sınır olarak öyle kalmaya devam ediyor, yalnızca eksik olan dosya üretimi eklendi.
2. Web: toplantı detay sayfasında başlık satırına "Takvime ekle (.ics)" düğmesi eklendi (mevcut yetkili-fetch + blob-indirme deseni, `Inventory.tsx`'teki CSV dışa aktarımıyla aynı desen).
3. `collaboration.test.ts`'e 1 yeni test (10/10, tam paket 166/166): üretilen dosyanın `BEGIN:VCALENDAR`/`BEGIN:VEVENT`/`UID`/`LOCATION`/başlık/`ORGANIZER`/`ATTENDEE`/`END:VEVENT`/`END:VCALENDAR` alanlarını doğru içerdiği doğrulandı.
4. Backend dışında değişiklik az: web'de tek düğme eklendi; mobilde değişiklik yok. `tsc`/`vite build` temiz; Playwright E2E ile gerçek dosya indirmesi doğrulandı.

## Oturum 30'da eklenenler (W32 devamı)

1. **Fason malzeme izlenebilirliği (girdi lotu bazında)**: yeni izleme tablosu eklenmedi — malzeme transferi/iade/fire işlemleri zaten `stock_moves` tablosuna `ref_type='subcontract_job', ref_id=<iş>` ile yazılıyordu; yeni `GET /api/subcontract-jobs/:id/material-usage` bunları lot bazında topluyor (gönderilen − iade − fire = net tüketilen) ve işin kesin kabul edilen çıktı lot(lar)ını ayrıca listeliyor. Hem iç yönetim hem işin atandığı dış fasoncu görebilir (iş detayına zaten erişimi olan herkes — `authorize()` aynı kural). Önceden yalnız toplam miktar (kesin kabul adedi) teyit edilebiliyordu; artık hangi girdi lotundan ne kadarının o işte tüketildiği de görünür.
2. **Bilinçli sınır**: bu, bileşen bazında tam BOM-eşleştirmeli bir "hangi çıktı biriminde hangi girdi biriminden ne kadar var" ayrıştırması değil — işe gönderilen/dönen lotların toplu listesi. Bir işte birden çok bileşen/lot olabileceğinden sunucu bunu tek bir orana indirgemiyor (uydurulmaz); bu, prompt'taki "bileşen bazlı tam izlenebilirlik" boşluğunu makul bir kapsamda kapatıyor.
3. Web: Fason işleri sayfasında iş detayına (kabul edilmiş her durumdan itibaren) "Malzeme izlenebilirliği" kartı eklendi — girdi lotu tablosu + çıktı lotu listesi.
4. `subcontract.test.ts`'e 1 yeni test (11/11, tam paket 165/165): yetki kontrolü (başka fasoncu 403), gönderilen/iade/fire/net tüketim doğru hesaplanıyor, çıktı lotu ayrı görünüyor, işin atandığı dış fasoncu da kendi işinin kullanımını görebiliyor.
5. `tsc`/`vite build` temiz; Playwright E2E ile doğrulandı (ekran görüntüsünde tablo değerleri doğru: gönderilen 10, fire 1, net 9, çıktı 9).
6. **Kalan (W32 devamı olarak hâlâ açık)**: revizyon geldiğinde devam/durdur/yeniden işle kararı otomasyonu (yeterince net iş kuralı spesifikasyonu yok, bu oturumda ele alınmadı).

## Oturum 29'da eklenenler (W27 devamı)

1. **Mobilde görsel olmayan eklerin cihazda açılması**: `apps/mobile/src/screens.tsx`'teki `AttachmentPreview`, oturum 26'da bilinçli kapsam dışı bırakılan son kalemdi — önceden görsel olmayan (PDF/metin/CSV) bir eke dokununca dosya indiriliyordu ama hiçbir şey gösterilmiyordu (yalnızca `Image` bileşeni denenip sessizce boş kalıyordu). Artık `contentType` bilgisiyle ayırt ediliyor: görseller eskisi gibi modalde önizleniyor, görsel olmayanlar için "Dosyayı aç" düğmesi indirilen dosyayı `expo-sharing`'in paylaşım/aç sayfasına (`Sharing.shareAsync`) veriyor — cihazda kurulu bir PDF/metin görüntüleyici seçilebiliyor. Yeni bağımlılık: `expo-sharing` (pnpm add ile, SDK 57 uyumlu).
2. Backend/web'de değişiklik yok (test sayısı sabit, 164/164); `pnpm -r exec tsc --noEmit` temiz; `EXPO_OFFLINE=1 expo export --platform android` başarılı.
3. **Kalan (W27 devamı olarak hâlâ açık)**: video eki (proje genelinde yok) — bu W27'nin son bilinen küçük kalanı; bunun dışında W27 devamı listesi artık boş.

## Oturum 28'de eklenenler (W27 devamı)

1. **Mobilde mesaj geri çekme (retract)**: `apps/mobile/src/screens.tsx`'teki `Discussion` bileşenine, web'de zaten var olan (`apps/web/src/components/Discussion.tsx`) mesaj geri çekme özelliği eklendi — oturum 26'da bilinçli kapsam dışı bırakılan üç kalemden biri. Kendi yazdığı mesajın yanında (yalnız kendi mesajında, `me` sorgusuyla `authorId` karşılaştırılarak) "Geri çek" düğmesi; gerekçe alanı (≥3 karakter) ile `POST /api/messages/:id/retract` çağrısı. State (`retract`) ve mutasyon (`act`) oturum 26'da zaten tanımlıydı ama hiçbir arayüz elemanına bağlı değildi — bu oturumda yalnız o bağlantı kuruldu, yeni state/mutasyon eklenmedi.
2. Backend/web'de değişiklik yok (test sayısı sabit, 164/164); `pnpm -r exec tsc --noEmit` temiz; `EXPO_OFFLINE=1 expo export --platform android` başarılı.
3. **Kalan (W27 devamı olarak hâlâ açık)**: video eki (proje genelinde yok); görsel olmayan eklerin (PDF/metin) mobilde cihazda açılması (şimdilik yalnız rozet).

## Oturum 27'de eklenenler (W32 devamı)

1. **Fasoncu performans raporu**: yeni bir izleme tablosu eklenmedi — mevcut `subcontract_jobs` kayıtlarından tek bir toplama sorgusuyla hesaplanıyor (`GET /api/subcontract-jobs/performance`, yalnız `subcontract.manage`, ticari veri olduğundan dış kullanıcıya kapalı). Fasoncu başına: toplam/tamamlanan/reddedilen/devam eden iş sayısı, zamanında/geç tamamlanan (yalnız hem termin hem kesin kabul tarihi dolu olan işlerden — biri eksikse "değerlendirilemedi" sayılır, uydurulmaz), termin oranı, toplam kabul edilen adet, beyan edilen sağlam/fire/kullanılmayan toplamlarından fire oranı.
2. Web: Fason işleri sayfasına "Fasoncu performansı" aç/kapa düğmesi ve tablo eklendi (yalnız iç yönetim rolünde görünür).
3. `subcontract.test.ts`'e 1 yeni test (10/10, tam paket 164/164): yetki kontrolü (dış kullanıcı ve `subcontract.manage` olmayan iç rol 403), tamamlanan bir iş üzerinden gerçek toplamların ve oranların doğru hesaplandığı, hiç işi olmayan fasoncunun raporda hiç satır almadığı.
4. Backend dışında değişiklik az: web'de tek bileşen eklendi; mobilde değişiklik yok. `tsc`/`vite build` temiz; Playwright E2E ile doğrulandı.
5. **Kalan (W32 devamı olarak hâlâ açık)**: fason çıktı lotunun girdi lotlarına bileşen bazlı tam izlenebilirliği (yalnız toplam miktar teyidi var); revizyon geldiğinde devam/durdur/yeniden işle kararı otomasyonu.

## Oturum 26'da eklenenler (W27 devamı)

1. **Mobilde tam konuşma arayüzü**: `apps/mobile/src/screens.tsx`'e web'deki `Discussion` bileşeninin sade bir mobil karşılığı eklendi — aynı uçları kullanır (`GET/POST /api/threads/:entityType/:entityId`, `.../mentionable`, `.../messages`, `.../read`, `POST /api/messages/:id/retract` şimdilik hariç tutuldu — kapsam dışı bırakıldı, aşağıda not edildi). Mesaj listesi, yanıtlama, @bahsetme (kişi rozetleri, web'deki açılır liste yerine dokunmalı rozet listesi), okundu işaretleme (mount'ta otomatik).
2. **Dosya/fotoğraf eki (mobil)**: `expo-document-picker` + `expo-file-system` eklendi (pnpm add, SDK 57 uyumlu sürümler). Seçilen dosya base64'e çevrilip aynı web doğrulamasıyla (tür: png/jpeg/webp/gif/pdf/metin/csv, 3 dosya/mesaj, dosya başına 3 MB) gönderiliyor. Görsel ekler dokununca `expo-file-system`'in `downloadAsync` (yetkili başlıklarla) ile cihaza indirilip bir modal içinde önizleniyor; görsel olmayan ekler şimdilik yalnız rozet olarak görünüyor (isim+boyut) — mobilde açılamıyor, bu bilinen bir sadelik.
3. **Bahsedilen mesajlar artık mobilde de ayrıntılı**: `Mentions` bileşeni (İşlerim ekranı) artık bir mesaja dokununca konuşmayı yerinde açıyor (önceden yalnız "okundu" işaretlenebiliyordu, ayrıntı/yanıt için web'e yönlendiriyordu — bu kısıtlama kaldırıldı).
4. **Kanallar sekmesi (mobil)**: yeni "Kanallar" sekmesi (`task.view` izni, web'deki nav izniyle aynı) — liste (aktif/arşivlenmiş), yeni kanal oluşturma, kanala dokununca yerinde açılan (satır içi, gezinme yığını olmadan — mobil uygulamanın var olan "satır içi genişletme" deseni korundu) konuşma + arşivleme formu.
5. **Değişiklik yapılmayanlar (bilinçli kapsam dışı)**: mesaj geri çekme (retract) mobilde yok — web'de zaten var, mobilde ekleme kararı ertelendi (az kullanılan, düşük öncelik); video eki desteklenmiyor (proje genelinde henüz yok); görsel olmayan eklerin mobilde açılması (yalnız rozet gösteriliyor).
6. Backend'de değişiklik yok (test sayısı sabit, 163/163); web'de değişiklik yok. `pnpm -r exec tsc --noEmit` temiz; `EXPO_OFFLINE=1 expo export --platform android` başarılı.

## Oturum 25'de eklenenler (W33 devamı)

1. **İş emri malzeme çıkışında FEFO/FIFO lot önerisi**: Üretim sayfasında "Çıkış yap" açıldığında lot listesi artık `GET /api/items/:id/lots` çağrısıyla zenginleştiriliyor (kalemin `issuePolicy`'sine göre sunucu tarafında zaten sıralı) ve bu sıraya göre yeniden düzenleniyor; kullanılamayan (stok dışı) konumlar sona atılıyor. Sunucu tarafında değişiklik yok — yalnız web istemcisi, zaten var olan iki uçtan gelen veriyi birleştiriyor.
2. **Otomatik varsayılan seçim**: açılır liste artık boş "Seçin…" ile başlamıyor; kullanılabilir ilk (politika sırasına göre en öncelikli) lot otomatik seçili geliyor. Kullanıcı isterse değiştirebilir.
3. **Süre uyarısı**: seçilen lot süresi geçmiş veya yakında dolacaksa (mevcut `expired`/`expiring_soon` durumları, storage.ts'teki hesaplamadan) seçenek metninde SKT + durum etiketi (SÜRESİ GEÇTİ / YAKINDA DOLUYOR — Inventory.tsx'teki aynı etiketler) gösteriliyor ve form altında kırmızı/turuncu bir uyarı bandı çıkıyor; çıkış engellenmiyor (karar yine kullanıcıda, sunucu da bunu zorunlu kılmıyor).
4. Onaylı alternatif kalemlerin lotları da aynı FEFO/FIFO sıralamasından geçiyor (W29'daki alternatif-lot birleştirme deseni korundu).
5. **Küçük düzeltme (W32'den)**: fason iş sayfasında liste satırının durum rozeti artık her mutasyonda (kabul/karşı teklif/ilerleme/beyan/kesin kabul) canlı yenileniyor; önceden yalnız açık detay paneli yenileniyordu, liste bir adım geride kalıyordu — bu oturumun E2E doğrulaması sırasında görüldü ve düzeltildi.
6. Backend'de değişiklik yok (dolayısıyla test sayısı sabit, 163/163); `tsc`/`vite build` temiz; mobilde bu oturumda değişiklik yok (masaüstü/depo ekranı, `expo export` çalıştırılmadı — dokunulmadı).
7. **Kalan (hâlâ W33 devamı olarak açık)**: kurutma/yeniden uygunluk (bake-out) takibi — üretici prosedürüne ve şirket kararına bağlı, bu oturumda ele alınmadı.

## Oturum 24'de eklenenler (W32)

1. **Fason üretici portalı — dış kullanıcı erişim modeli**: mevcut ama kullanılmayan `memberships.is_external` alanı `ReqCtx.isExternal` alanına ve yeni `isExternal(req)` yardımcı fonksiyonuna bağlandı. Yeni `subcontractor` rolü **kasten izinsiz** (`DEFAULT_ROLES.subcontractor.permissions = []`) — dış kullanıcının genel erişimi yok, yalnız `subcontract_jobs.subcontractor_user_id` eşleşmesiyle kendi işini görür/işler (satır bazlı yetkilendirme, izin bazlı değil). Test: dış kullanıcının `/api/stock/balances` gibi bağlantısız uçlara 403 aldığı ve başka fasoncunun işini göremediği doğrulandı.
2. **İş yaşam döngüsü**: `proposed` → (dış firma) `countered`/`accepted`/`rejected` → (iç, karşı teklif kabulü) `accepted` → (dış firma, yalnız ileri yönlü, atlama/geri gidiş 409) `prep` → `in_production` → `testing` → `ready_to_ship` → (dış firma) `declare` (sağlam/fire/kullanılmayan beyanı, şirketin kesin kabulünden ayrı alanlarda) → (iç, `accept-output`) `completed`.
3. **Malzeme entegrasyonu**: iç personel gerçek `stock_moves` ile malzemeyi fason konumuna (`FSN`) transfer eder ve iade alır (fire→imha/`scrap`, kullanılmayan→depoya `return`); kesin kabulde çıktı yeni bir lot olarak `receive` hareketiyle giriş kalite konumuna (`GKK`) girer (mal kabul deseniyle aynı — negatif stok hatasından kaçınmak için yeni lota `transfer` değil `receive` kullanıldı).
4. **Dosya paylaşımı**: fotoğraf/video/test raporu/teslim belgesi — her iki taraf görür, başka fasoncu göremez (base64/SHA-256/boyut doğrulamalı, `collaboration.ts`'teki desenin bağımsız kopyası — iş bazlı satır erişimi mevcut genel-izinli ek sistemine uymadığından).
5. Yeni tablolar: `subcontract_jobs`, `subcontract_job_files` (değişmez, `forbid_mutation` tetikleyicili); RLS zorunlu.
6. Web: yeni "Fason işleri" sayfası (`/subcontract-jobs`) — iç/dış kullanıcı için tek bileşen, `subcontract.manage` yetkisine göre dallanır; dış kullanıcı için kök rota (`/`) ve gezinme menüsü bu sayfaya yönlendirilir (izinsiz rolde boş menü görünmesini önler). Liste satırının durumu artık her mutasyonda (kabul/karşı teklif/ilerleme/beyan/kesin kabul) canlı yenileniyor — E2E sırasında bulunan bir eksiklik (yalnız detay paneli yenileniyordu) düzeltildi.
7. `subcontract.test.ts`: 9 yeni test (163/163 tam paket). Mobilde bu oturumda değişiklik yok (masaüstü/yönetim özelliği; `expo export` hash değişmedi, doğrulandı).
8. **Bilinen sadelikler** (prompt §19'un tam kapsamına göre): çıktı lotunun girdi lotlarına bileşen bazlı tam izlenebilirliği yok (yalnız toplam miktar teyidi); revizyon geldiğinde "devam et/durdur/yeniden işle" kararı otomasyonu yok; fasoncu performans raporlaması yok. Bu üçü sonraki bir oturumda ele alınabilir.

## Oturum 23'de eklenenler (W35)

1. **Senaryo karşılaştırma**: baz planın kopyası üzerinde ne-olurdu hesabı; gerçek rezervasyon/sipariş/iş emri OLUŞTURMAZ. Eksenler: üretim adedi (ör. 500→1000), kritik parça N gün gecikmesi, onaylı alternatif kullanımı (yalnız `item_alternates.status='approved'` çiftler kabul edilir), iç üretim yerine fason (iç kapasite sıfırlanır), ek vardiya (günlük kapasiteye dakika eklenir).
2. Yeni tablo `scenarios` (company_id, name, product_revision_id, qty, overrides, result jsonb — baseline+scenario+delta, source_asof, created_by); RLS zorunlu.
3. `POST /api/scenarios`, `GET /api/scenarios`, `GET /api/scenarios/:id` — izin `report.view` (birden çok rol kullanabilir; yalnızca yönetime özel değil, salt okunur ve durum yazmıyor).
4. Referans birim maliyet kalemin en son kaydedilen lot maliyetinden alınır; kayıt yoksa toplam maliyet "hesaplanamadı" — uydurulmaz. Temin süresi tanımsız kalemde termin de "hesaplanamadı".
5. Web: yeni "Senaryolar" sayfası (`/scenarios`) — ürün/revizyon seçimi, senaryo formu (kritik parça/alternatif için ItemPicker paylaşıldı — Alternates.tsx'ten export edildi), sonuç kartı (termin farkı, maliyet farkı, malzeme tablosu, varsayımlar, hesaplanamayan noktalar), kayıtlı senaryolar tablosu.
6. `scenarios.test.ts`: 6 yeni test (154/154 tam paket). Mobilde bu oturumda değişiklik yok (yönetim masaüstü aracı).

## Oturum 22'de eklenenler (W33)

1. **Kalem düzeyinde saklama kuralları** (isteğe bağlı, tüm parçalara zorunlu değil): MSL (1–6/2a/5a), kullanım süresi (paket açık, saat), raf ömrü (kapalı paket, gün), saklama koşulu (serbest metin), çıkış politikası (FIFO/FEFO). Yeni izin: `item.storage.manage` (kalite + depo rollerine varsayılan verildi).
2. **Lot düzeyinde üretim/son kullanma tarihi**: elle girilir (`POST /api/lots/:id/expiry`); sunucu hiçbir tarihi hesaplamaz/uydurmaz.
3. **Paket açılışı**: `POST /api/lots/:id/open` bir kez kaydedilir (409 tekrar); kullanım süresi sonu, açılış anı + kalemin `floorLifeHours` değerinden hesaplanır.
4. **Lot listesi**: `GET /api/items/:id/lots` kalemin çıkış politikasına göre (FEFO: son kullanmaya göre, FIFO: girişe göre) sıralı lot listesi + `expired`/`expiring_soon`/`ok`/`unknown` durumu döner.
5. Web: Depo & Lot sayfasında kalem seçilince "saklama & lot ömrü" bölümü (düzenleme formu, lot tablosu, tarih girme ve paket açma aksiyonları).
6. Mobil: barkod/lot sorgu ekranında MSL, son kullanma tarihi (süresi geçmişse uyarı), paket açık bilgisi ve saklama koşulu gösterilir.
7. `storage.test.ts`: 5 yeni test (148/148 tam paket).

## Oturum 21'de eklenenler (W29 devamı)

1. **Alternatif kaydına kanıt & tartışma**: her alternatif önerisi artık kendi konuşmasına sahip (yeni tablo yok — mevcut mesaj/ek altyapısı `item_alternate` kayıt türü olarak kaydedildi). Ar-Ge/üretim datasheet, test sonucu fotoğrafı vb. ekleyip tartışabilir; yalnız `bom.view` yetkisi olanlar görür.
2. **Mobil**: iş emri malzeme çıkışı ekranında onaylı alternatiften çıkılan miktar ayrı gösterilir; alternatif lotun okutulabileceği bilgisi eklendi (çıkış zaten kod bazlı olduğundan, onaylı herhangi bir alternatif lotun okutulması sunucu tarafından otomatik doğrulanıyordu — bu oturumda yalnız görünürlük eklendi).
3. Gerçek AI önerisi hâlâ yok (W30 sonrasına bırakıldı); aday bulma kural tabanlı kalmaya devam ediyor.

## Oturum 20'de eklenenler (W38)

1. **Bağlayıcı operasyon panosu** (`/events/connectors`; ayar `audit.view` — yönetici/teknik lider): distribütör (5), e-belge (6) ve kargo (6) bağlayıcılarının tek ekranda özeti. Yeni tablo yok — mevcut değişmez `connector_calls` ve `document_dispatches` kayıtlarının toplamı.
2. Distribütörler için: bugünkü çağrı / günlük kota ve yüzdesi (≥%90 kırmızı), önbellek isabet oranı, toplam çağrı, son 7 gün hata sayısı, son başarılı etkinlik zamanı.
3. E-belge ve kargo için: bugünkü/toplam gönderim sayısı, son gönderim zamanı.
4. Üstte özet: kaç bağlayıcı bağlı, son 7 günde toplam hata, bugün kota dolan bağlayıcı sayısı.
5. İşlem geçmişi sayfasından bağlantı; gerçek dış API'si olan bağlayıcı yok — pano yalnız TEST/fiyat dosyası etkinliğini gösterir, canlıya geçilince aynı ekran gerçek verilerle çalışır.

## Oturum 19'da eklenenler (W27 devamı)

1. **Mesajlara dosya/fotoğraf eki**: mevcut her konuşmada (iş emri, değişiklik, iade, toplantı, kanal…) mesaja en fazla 3 dosya eklenebilir (PNG/JPEG/WEBP/GIF/PDF/metin/CSV, dosya başına 3 MB, mesaj başına toplam 5 MB — istek gövdesi sınırına göre). Ek veri tabanında saklanır (harici depolama yok); indirme, mesajın bağlı olduğu kaydı görme yetkisiyle korunur. Mesaj geri çekilince eki de görünmez.
2. **Serbest grup kanalları** (`/collaboration/channels`): herhangi bir iş kaydına bağlı olmayan, tüm çalışanların (`task.view`) görebildiği konuşma odaları. Herkes kanal açabilir; yalnız oluşturan veya görev yönetimi yetkisi olan kişi arşivler (geçmiş kalır). Mevcut konuşma/bahsetme/okundu altyapısı aynen kullanılır (kanal = yeni bir "kayıt türü").
3. Web: `Discussion` bileşenine dosya seçici ve ek rozetleri (indirmede blob + yetkili fetch); yeni Kanallar sayfası ve menü girdisi.

## Oturum 18'de eklenenler (W36)

1. **E-fatura/e-arşiv bağlayıcıları** (`/receivables/einvoice-connectors`; ayar `receivable.manage`): GİB e-Belge Portalı, Uyumsoft, Foriba, Logo, Paraşüt, Nesbilgi — varsayılan **BAĞLANMADI** (resmi gönderim bir GİB özel entegratör sözleşmesi gerektirir; sağlayıcı seçimi şirketin ticari kararıdır, burada taslak listelenmiştir). Yalnız **TEST** modu var: sentetik ETTN üretir, hiçbir şey GİB'e gönderilmez.
2. **E-belge gönder**: kesilmiş (issued) müşteri faturası için tür (e-Fatura / e-Arşiv) elle seçilir (mükellef sorgusu yok), bağlayıcı TEST değilse reddedilir; gönderilince belge modu **TEST** olur ve sabitlenir (bir kez), ETTN ve sağlayıcı görünür.
3. **Kargo bağlayıcıları** (`/shipments/cargo-connectors`; ayar `shipment.create`): Yurtiçi, Aras, MNG, PTT, Sürat, UPS — varsayılan BAĞLANMADI, yalnız TEST modu. Paketlenmiş sevkiyat için sentetik takip no + etiket referansı üretir (bağlayıcı + sevkiyat koduna göre deterministik); gerçek kargo firmasına iletilmez.
4. **Sevk entegrasyonu**: kargo etiketi üretildiyse "sevk et" adımında taşıyıcı/takip no elle girilmez, etiketten alınır (elle giriş de hâlâ mümkün). Aynı sevkiyata iki kez etiket üretilemez.
5. Tüm gönderimler değişmez `document_dispatches` kaydına düşer.

## Oturum 17'de eklenenler (W29)

1. **Alternatif parça kaydı** (`/products/alternates`, Ar-Ge & BOM sayfasından bağlantı): birincil → alternatif, kapsam (genel veya ürün), gerekçe (≥ 10), kanıt (pin uyumu, footprint, elektriksel eşdeğerlik, not). Öneri Ar-Ge (`product.create`) veya satın alma (`supplier.manage`) yapar; aynı canlı çift ikinci kez önerilemez.
2. **Kural tabanlı aday**: ad/değer/kılıf belirteçleri örtüşmesi, puan ≥ 50, serbest stokla — ekranda "yapay zekâ değildir" yazar; aday yalnız öneridir.
3. **Onay**: Ar-Ge ve üretim ayrı karar (değişmez kayıt, görev açılır/kapanır); öneren onaylayamaz; kanıt eksikse onay için ≥ 20 karakter teknik not; ret gerekçe ister; herhangi bir ret → reddedildi. Geri alma (herhangi bir `product.approve.*`, gerekçeli) yeni çıkışı engeller, geçmiş çıkış kayıtta kalır; aynı çift yeniden önerilebilir.
4. **İş emrinde alternatif çıkışı**: lot seçiminde onaylı alternatif lotları da listelenir; sunucu ürün kapsamını doğrular, çıkış birincil kalem ihtiyacından düşer (`for_item_id`, `alternate_id` izlenebilir), malzeme tablosunda "alternatif" miktarı, olay `material.issued.alternate`. Onaysız parça `wrong_part` ile reddedilir.
5. **Tedarik görünümü**: her BOM satırında onaylı alternatifler ve serbest stoğu; birincil stok yetmiyor/teklif yok/EOL ise "Onaylı alternatif X stoktan karşılar" önerisi.
6. Demo: CMP-CAP-02 (onaysız aday örneği).

## Oturum 16'da eklenenler (W17)

1. **Distribütör bağlayıcıları** (`/purchasing/distributors`; ayar `supplier.manage`): DigiKey, Mouser, Farnell, Nexar/Octopart, LCSC — varsayılan **BAĞLANMADI** (gerçek API lisans/erişim doğrulaması bekliyor). Modlar: **TEST** (MPN'den deterministik sentetik katalog; her yerde "TEST VERİSİ" rozeti — gerçek fiyat/stok değildir) ve **FİYAT DOSYASI** (distribütörden indirilen CSV: mpn, sku, stock, moq, lead_time_days, lifecycle, price_N kırılımları; dosya adı + özetle kaynak). Tedarikçi eşlemesi, önbellek süresi, günlük çağrı kotası, para birimi; değişiklik gerekçeli ve olay kayıtlı.
2. **Önbellek ve kota**: teklif kaynak, alınma zamanı ve son geçerlilikle saklanır; süresi geçen "eski" işaretlenir; test modunda istek üzerine yenilenir, kota dolunca önbellek + uyarı. Çağrı kaydı değişmez (ok / bulunamadı / önbellek / kota). Bağlantı durumunda her distribütörün gerçek modu.
3. **Kalem teklifleri** (`/api/items/:id/offers`): adet için kırılım fiyatı, stok, MOQ, temin, yaşam döngüsü (NRND/EOL); fiyat yalnız maliyet görme yetkisiyle.
4. **BOM tedarik görünümü** (ürün › BOM): adet için brüt ihtiyaç, serbest stok, alınacak miktar, stoğu yeten en ucuz teklif, para birimi bazında tahmini alım (kur dönüşümü yok) ve riskler (MPN yok, teklif yok, stok yetersiz, eski teklif, NRND/EOL).
5. **RFQ'ya otomatik teklif**: tedarikçiye bağlı aktif bağlayıcıların teklifi (kaynak "test_connector", notta TEST/dosya, stok ve alınma zamanı) eklenir; elle girilmiş teklifin üzerine yazmaz (elle teklif artık kaynağı "manual" olarak günceller).

## Oturum 15'te eklenenler (alacaklar)

1. **Müşteri faturası** (`/receivables`, `receivable.manage`: muhasebe; görüntüleme muhasebe, yönetici, satış): sevk edilmiş sevkiyattan TASLAK (fiyat siparişten, KDV oranı seçilir); sevkiyat başına bir fatura; fiyatsız satır veya karışık para birimi faturalanmaz. "Kes": sıralı fatura numarası (MF-…), fatura tarihi ve müşteri vadesiyle vade sabitlenir; kesilen fatura ve satırları veri tabanında değişmez (düzeltme = iptal + yeniden hazırlama). Belge modu TASLAK — resmi e-fatura/e-arşiv yok (W36).
2. **Tahsilat kaydı** (`payment.record`): sistem tahsilat yapmaz; bankaya gelen ödemenin kaydı (değişmez), açık bakiyeyi aşamaz, tamamı girilince "tahsil edildi"; tahsilatı olan fatura iptal edilemez.
3. **Alacak yaşlandırma** (vadesi gelmemiş / 1–30 / 31–60 / 60+) ve müşteri bazında **kredi riski** = açık alacak + faturalanmamış kesin siparişler (KDV hariç).
4. **Kredi kontrolü** (müşteri: limit, vade, gecikme sınırı gün): sipariş kesinleştirmede risk + bu sipariş > limit veya gecikme sınırından eski alacak varsa `credit_blocked` (olay defterine ret); `credit.override` (muhasebe, yönetici) sipariş bazında gerekçeyle serbest bırakır. Sipariş sayfasında kredi durumu kartı.

## Oturum 14'te eklenenler (W24)

1. **Tedarikçi faturası** (`/payables`, giriş `invoice.manage`: muhasebe; görüntüleme muhasebe, satın alma, yönetici): fatura no tedarikçi başına tekil (mükerrer reddi), vade boşsa tedarikçinin ödeme vadesinden (varsayılan 30 gün), net + KDV = toplam, tekrar korumalı.
2. **Üç yönlü eşleştirme** (sipariş – kalite kabulü – fatura): faturalanan miktar (önceki faturalar dahil) ≤ **kalite kabul edilen** miktar (kabul bekleyen faturalanamaz); fiyat sapması ≤ tolerans (% ve tutar); aynı para birimi ve tedarikçi; siparişsiz satır ve toplam uyuşmazlığı fark sayılır. Kaydetmeden önizleme; kalite kabul edilmiş/faturalanmamış satır listesi.
3. **Tolerans politikası** (sürümlü, değişmez; `cost.manage`): varsayılan fiyat %2, miktar %0. Fatura, kaydedildiği andaki politika sürümünü saklar.
4. **Karar**: eşleşen fatura otomatik "ödemeye hazır"; farklı fatura muhasebe görevine düşer, **faturayı giren onaylayamaz** (görev ayrılığı), gerekçeli onay/ret (`invoice.approve`: muhasebe, yönetici).
5. **Faturadan lot maliyeti**: onaylanan faturanın birim fiyatı o sipariş satırından gelen lotlara maliyet kaydı olarak yazılır (kaynak: fatura) — iş emri maliyeti bunu kullanır.
6. **Ödeme kaydı** (`payment.record`): sistem ödeme YAPMAZ; bankada yapılmış ödemenin tutar/tarih/referans kaydı (değişmez), açık bakiyeyi aşamaz, tamamı girilince "ödendi". Ödeme kaydı olan fatura iptal edilemez.
7. **Vade yaşlandırma** (geçmiş 1–30/31–60/60+, 7/30 gün içinde, sonrası, farkta bekleyen) ve 8 haftalık ödeme planı, para birimi bazında (kur dönüşümü yok).
8. Tedarikçiye ödeme vadesi alanı; fatura sayfasında kayda bağlı konuşma.

## Oturum 13'te eklenenler (W18)

1. **Tedarikçiler** (`/purchasing/suppliers`, `supplier.manage`: satın alma): kod, ad, e-posta, varsayılan temin; gerekçeli bloke/aktif; performans (satır, gecikmiş, ortalama teyit kayması). Eski serbest metin tedarikçiler migration'da kayda dönüştürüldü. DEMO: iki tedarikçi.
2. **Teklif talebi (RFQ)** (`/purchasing/rfqs`, `purchase.order.manage`: satın alma, yönetici): yalnız onaylı satın alma talebinden (talep başına bir açık RFQ); teklif = birim fiyat, para birimi, temin, MOQ, geçerlilik; bloke tedarikçiden teklif alınmaz; yeni teklif öncekinin yerine geçer (önceki olayda). Karşılaştırma: toplam (MOQ ile), en ucuz, en hızlı, hazır tarihi / ihtiyaç tarihi, süresi dolmuş, son lot maliyetinden sapma. Fiyatlar maliyet görme yetkisi olmayana gizli.
3. **Gerekçeli seçim**: en ucuz değil / ihtiyaç tarihini karşılamıyor / süresi dolmuş / %20+ fiyat sapması → gerekçe zorunlu (`award_reason_required`). Seçim taslak satın alma siparişi açar (MOQ miktarıyla), talep "siparişe dönüştü".
4. **Satın alma siparişi** (`/purchasing/orders`): taslak → gönder (**TEST**: yalnız çıkış kutusu, tedarikçiye gerçek gönderim yok) → teyitli → kısmi / tamamı teslim (mal kabulden otomatik) ; gerekçeli iptal (teslim başladıysa veya üretim ihtiyacına ayrıldıysa engelli).
5. **Tedarikçi teyidi**: satır bazında, değişmez kayıt (önceki tarih, kayma günü, tedarikçi ref., kaynak). İleri kayma not ister; bağlı satış siparişleri (ayırma veya üretim ihtiyacı talebi üzerinden) etkisi döner, termin riskteyse satış ve üretime görev açılır. Termin hesabı teyit tarihini kullanır.
6. **Takip** (`/purchasing/followups`): gönderimden 3 gün sonra teyitsiz ve teyit tarihi geçmiş eksik satırlar; satın almaya görev + test modunda tedarikçi hatırlatması (satır başına günde bir); arka plan her dakika tarar.
7. **Mal kabul**: açık sipariş satırı seçilerek (fiyatsız liste, depo rolü) kabul; satır kapalıysa veya kalem eşleşmiyorsa reddedilir.
8. Sipariş sayfasında kayda bağlı konuşma; Bağlantı durumunda "Tedarikçi sipariş gönderimi: TEST".

## Oturum 12'de eklenenler (W27/W28)

1. **Kayda bağlı konuşma** (iş emri, değişiklik talebi, iade, sipariş, ürün, görev, toplantı sayfalarında): kaydı görme izni olan okur/yazar; yanıt, bahsetme (@kişi), okunmamış işareti. Bahsedilen kişinin de kaydı görme izni olmalı (yoksa `mention_no_access`; içerik sızdırılmaz). Mesaj metni veri tabanında değişmez/silinmez; yazar gerekçeyle geri çeker (kayıt ve olay kalır). Tekrar korumalı gönderim.
2. **Bahsetmeler**: Günlük işler'de "Bahsedildiğiniz mesajlar" (web) ve İşlerim'de (mobil, okundu işaretleme); konuşma açılınca okunur. Bildirim çıkış kutusuna test modunda.
3. **Toplantı** (`/planning/meetings`, açma `task.manage`): gündem, zaman, yer, bağlı kayıt, katılımcılar (davet bildirimi test modunda), katılım (katıldı/katılmadı/mazeretli), tutanak notu, karar/aksiyon/bilgi maddeleri (aksiyon sorumlu + bitiş zorunlu). Düzenleme: düzenleyen veya görev yöneticisi.
4. **Tutanağı kapat**: tüm katılım işaretli ve en az bir madde olmalı; aksiyonlar sorumlusuna toplantıya bağlı, bitiş tarihli görev olarak açılır; tutanak, katılım ve maddeler veri tabanı tetikleyicisiyle değişmez. Gerekçeli iptal. Günlük işler'de "Yaklaşan toplantılarım".
5. Düzeltme: birkaç ekranda seçim kutusunun değeri istek gönderilirken geri alınıyordu (kontrollü bileşende olay değerinin geç okunması) — BOM bağlama, teslimat adresi/kısmi sevk, kontrol listesi.

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

- Dış bağlayıcılar **BAĞLANMADI** (e-belge, kargo, toplantı). Distribütörler varsayılan BAĞLANMADI; TEST modu sentetik veridir, FİYAT DOSYASI gerçek ama elle yüklenen veridir. Test istasyonu adaptörü **TEST** modunda (gerçek istasyon çıktısıyla doğrulanmadı).
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
- Planlama: Gantt'ta kaynak kapasitesi ve vardiya yok; iş emri çubukları salt okunur.
- İletişim: kayıttan bağımsız birebir sohbet, anlık (canlı) güncelleme yok (sayfa yenilenince/işlemde güncellenir); sesli/görüntülü görüşme, kayıt ve transkript yok (dış bağlayıcı gerekir). Toplantı için takvim daveti dosyası (.ics) var (oturum 31); gerçek canlı takvim senkronu (Outlook/Google bağlayıcısı) yok.
- Satın alma: tedarikçiye gerçek gönderim (e-posta/EDI/portal) yok; teklifler elle, fiyat dosyasından veya TEST kataloğundan (gerçek distribütör API'si yok); çok kalemli RFQ/sipariş yok (talep başına bir satır); kur dönüşümü yok (farklı para birimli teklif sapma hesaplanmaz). Sipariş onay limiti gönderim aşamasında da kontrol edilir (oturum 33, gerçek RFQ ödül tutarı üzerinden).
- Borçlar: e-fatura (GİB) alımı yok (fatura elle girilir, W36); banka/ödeme bağlantısı yok (yalnız kayıt); kur farkı, stopaj ve iade faturası (fiyat farkı/iade) yok; iade/fiyat farkı (alacak dekontu) yok; kısmi sevkiyatta sipariş toplamı değil sevk edilen miktar faturalanır; kur dönüşümü olmadığından kredi riski yalnız müşterinin kredi para biriminde hesaplanır; muhasebe fişi/entegrasyonu yok.
- Akış: politika yalnızca beş onay türü için; satın alma dışındaki türlerde parasal limit yok. Yükseltme artık isteğe bağlı olarak iki seviyeli tanımlanabilir (oturum 35, politika ikinci bir üst rol tanımlarsa; üçüncü seviye yok, tanımlanmazsa eski tek seviyeli davranış aynen sürer). Bildirim yalnızca çıkış kutusunda (e-posta/anlık bildirim bağlanmadı). Vekâleten bekleyen işler artık mobilde de görünür (oturum 32, salt okunur); işlem yine web'den yapılır. Tahmini tutar son lot maliyetinden; tedarikçi teklifi/fiyat listesi yok (W18).
- Maliyet: kur dönüşümü yok (farklı para birimli satır "hesaplanamadı"); iade tamiri ve iade hurdası maliyete yansımıyor; bütçe modülü yok; prototip/pilot/seri ayrımı ve ekip performansı raporu (W26) yok. İşçilik yalnızca operasyon başlat/tamamla süresinden; hızlı tıklanan operasyon süre biriktirmez (uyarı olarak eksik listesine düşer). Mobilde maliyet ekranı yok (ofis işi). Dış hizmet (fason) maliyeti artık iş emrine bağlıysa ve iş tamamlandıysa maliyete yansır (oturum 34).

## Sıradaki uygulanabilir iş

1. W36 devamı: gerçek entegratör/kargo firması sözleşmesi imzalanınca canlı bağlanma (sağlayıcı kararı şirkete ait).
2. W27 devamı: video eki desteği oturum 37'de tamamlandı (nesne depolama, gerçek MP4/WebM ile uçtan uca doğrulandı) — mesaj geri çekme oturum 28'de, görsel olmayan eklerin mobilde açılması oturum 29'da tamamlandı; W27 için bilinen bir kalan yok.
3. W33 devamı: kurutma/yeniden uygunluk (bake-out) reçetesi ve çevrim kaydı oturum 39'da tamamlandı (JEDEC tablosu bilinçli olarak sabit kodlanmadı — şirketin kendi tanımladığı, kaynak zorunlu, sürümlü reçete var; bkz. yukarıdaki "Oturum 39'da eklenenler"). FEFO/FIFO lot önerisi oturum 25'te tamamlanmıştı; W33 için bilinen bir kalan yok.
4. W32 devamı: bağlı iş emrinde ECR kararının (beklet/yeniden işle/kalanı iptal) fason işi otomatik incelemeye düşürmesi oturum 36'da tamamlandı (performans raporu oturum 27'de, girdi lotu bazlı malzeme izlenebilirliği oturum 30'da tamamlandı; "yeniden işle" kararının kendi ayrı akışı hâlâ yok — ayrı iş paketi gerekebilir).
5. W28 devamı (tek küçük kalan): toplantı takvim daveti (.ics) oturum 31'de tamamlandı; kalan (görüşme/kayıt/transkript, gerçek Outlook/Google canlı senkronu) dış bağlayıcı kararı gerektiriyor.
6. "Akış" bilinen sınırı: vekâleten bekleyen işler mobilde görünürlüğü oturum 32'de tamamlandı.
7. "Satın alma" bilinen sınırı: sipariş onay limitinin (W10 politikası) sipariş gönderim aşamasına bağlanması oturum 33'te tamamlandı.
8. "Maliyet" bilinen sınırı: dış hizmet (fason) maliyetinin iş emri maliyetine yansıması oturum 34'te tamamlandı (iade tamiri/hurda maliyeti hâlâ ayrı bir kalan).
9. "Akış" bilinen sınırı: yükseltmenin isteğe bağlı ikinci seviyesi oturum 35'te tamamlandı (politika tanımlamazsa eski tek seviyeli davranış aynen sürer).
10. "Maliyet"/W32 bilinen sınırı: ECR kararının bağlı fason işini incelemeye düşürmesi oturum 36'da tamamlandı (yukarıya bakınız).
11. W30/W31 devamı (oturum 38'de tamamlanan kısımdan kalan): AI (LLM) yorum katmanı — sağlayıcı/model seçimi şirkete ait bir karar (dış bağımlılık); seçilince `ai_status='generated'` ile gerçek yorum üretimi eklenebilir. Gerçek pilot verisiyle (canlı üretim/satış dönemi) W31 akışının denenmesi de kalan bir adım (§12 sırasına göre gerçek pilot ile birlikte).
12. W42 devamı: şirket içi kapsam (durum makinesi, paket, kullanım sayacı, ödeme kaydı, kısıtlama) oturum 39 devamında tamamlandı (bkz. yukarıda). Kalan yalnızca dış bağımlılık: gerçek ödeme sağlayıcısı entegrasyonu (seçim şirkete ait) ve — istenirse ileride — bir platform operatörü ekranı (kullanıcı kararıyla şimdilik bilinçli olarak kapsam dışı).
13. Kalanların çoğu (W03, W28 devamı — canlı takvim senkronu, W30 AI yorum katmanı, W42'nin ödeme sağlayıcısı) dış sağlayıcı kararı, gerçek AI kapsamı veya iş/pilot süreci gerektiriyor. Kod ile ilerletilebilecek net, küçük bir kalan bulmak için önce bu listeye, sonra "Bilinen sorunlar ve sınırlar" bölümüne bakılmalı (oturum 30/31/32/33/34/35/36/38/39'da ICS, vekâlet görünürlüğü, sipariş onay limiti, dış hizmet maliyeti, iki seviyeli yükseltme, ECR-fason inceleme bağlantısı, yönetici raporu ve W42 abonelik yaşam döngüsü gibi küçük ama gerçek boşluklar oradan bulundu) — yeni bir iş paketi tanımlanmadıkça bu liste bundan sonra büyük ölçüde sabit kalacak.
14. R37 (tedarik riskinin sipariş ve termine etkisi) oturum 39 devamında tamamlandı (bkz. yukarıda) — ardından R39 (hazır akışlarla hızlı şirket kurulumu) da aynı oturumda uygulandı, otomatik testleri geçti ve gerçek dev sunucusunda doğrulandı (bkz. "Oturum 39/40 devamı — R39" bölümü). Kalan "planlandı" durumundaki maddelerden dış bağımlılığı olmayan tek aday **R46 (yedek, geri yükleme ve kesintide talimat erişimi, W37)** — R05 (Ar-Ge maliyeti devir anında) mühendislik-zamanı takibi gerektiriyor (ayrı bir W11 alt adımı), R12/R26 gerçek AI/görüntülü görüşme dış bağlayıcısı bekliyor, R47 kullanıcı talimatıyla beklemede, R48 e-fatura/kargo dış bağımlılığına dayanıyor — bir sonraki oturumda R46 ile devam edilebilir.
14. R44 (saha arızası — fiziksel iade akışından ayrım) ve R21 (vadeli tahsilat/hatırlatma) bu oturum devamında tamamlandı (bkz. yukarıda). R04 (Ar-Ge alımının proje/muhasebe bağlantısı) da bu oturum devamında tamamlandı (bkz. yukarıda "Oturum 39 devamı — R04"). **R37 (tedarik riskinin sipariş ve termine etkisi) oturum 39/40 devamında tamamlandı** (bkz. yukarıda "Oturum 39/40 devamı — R37"). R47 (şirketin tam veri/dosya çıkış paketi) kodu yazıldı, izole test ve migration doğrulandı ama kullanıcı talimatıyla **commit edilmeden beklemede** — devam kararı kullanıcıya ait (bkz. yukarıdaki tablo satırı). Kapsam izleme dokümanında (`docs/kapsam-izleme.md`) "planlandı" durumundaki diğer maddeler (R05, R10/R11 dış bağımlılık, R24 zaten tamamlandı, R39, R46 vb.) bir sonraki somut, engellenmemiş aday olabilir — dış bağımlılık gerektirmeyen kalanlardan biri R39 (hazır akışlarla hızlı şirket kurulumu, kurulum sihirbazı) olabilir. R05 (Ar-Ge maliyetinin devir anında görünmesi) mühendislik-zamanı takibi gerektirdiğinden bu turda bilinçli olarak R04'ten ayrı bırakıldı — bağımsız bir iş paketi olarak ele alınmalı.

15. **R46 (yedek, geri yükleme ve kesintide talimat erişimi) oturum 40'ta tamamlandı** (bkz. yukarıda "Oturum 40 — R46"): hem Bölüm A (kesintide erişim) hem Bölüm B (şifreli yedekleme/geri yükleme, BYPASSRLS reddi sonrası RLS-saygılı yeniden tasarım, gerçek geri yükleme tatbikatı `GEÇTİ`) tamamen uygulandı, otomatik testleri geçti (279/279) ve gerçek dev sunucusunda doğrulandı.
16. **R47 (şirketin tam veri/dosya çıkış paketi) aynı oturumda beklemeden çıkarılıp commit edildi** (commit `35279b1`) — kod zaten yazılmış ve test edilmişti, kullanıcı "R47'yi beklemeden çıkar" dedi. Tam paket **279/279**, `tsc --noEmit` temiz.
17. Bu ikisiyle **kapsam izleme dokümanındaki dış bağımlılığı olmayan tüm somut adaylar tükendi.** Geriye kalan "planlandı" maddelerin tümü gerçek bir dış sağlayıcı/entegratör kararı ve erişimi bekliyor: R10/R11/R48 (e-fatura entegratörü + kargo firması, W36'nın TEST modundan sağlayıcı test ortamına geçişi), R12/R26 (gerçek AI/LLM sağlayıcısı, W30 yorum katmanı), W28 devamı (Google Calendar / Microsoft 365 OAuth uygulama kaydı), W42'nin ödeme sağlayıcısı entegrasyonu, distribütör API'leri (DigiKey/Mouser/Farnell/Nexar gerçek kimlik doğrulama). R05 ayrıca mühendislik-zamanı takibi altyapısı gerektiriyor (ayrı bir iş paketi, dış sağlayıcı değil). Kullanıcı bu dış-bağımlılık maddelerini **sırayla** ilerletmeyi istedi (2026-09-27) — her biri için hangi sağlayıcı seçileceği ve erişim bilgilerinin (API anahtarı, istemci kimliği vb.) nereden geleceği kullanıcıdan/platform işletmecisinden gelmesi gereken kararlar; kod tarafı (bağlayıcı çerçevesi) her birinde zaten TEST modunda hazır, yalnızca gerçek kimlik doğrulama/API erişimi ekleniyor.

## Oturum 41 devamı — kalan işler 1: UBL-TR 1.2 e-fatura belgesi

`lib/ubl-tr.ts` (`buildUblTr`): UBL 2.1 / CustomizationID TR1.2 fatura XML'i — UBL eleman sırası, VKN'li taraf
`PartyName`, TCKN'li taraf `Person` (son kelime soyad), adres/vergi dairesi, KDV (`0015`) fatura ve satır düzeyinde
(kuruş hassasiyetinde BigInt; yuvarlama farkı son satıra), `LegalMonetaryTotal`, döviz faturada `PricingExchangeRate`,
KDV %0'da istisna kodu, GİB numara biçimi (`^[A-Z0-9]{3}20\d{2}\d{9}$`; yoksa uyarı — entegratör atar), ETTN (gönderilmişse
kayıtlı ETTN, değilse fatura koduna göre deterministik UUID v4), tüm metin XML kaçışlı. Mali mühür (`UBLExtensions`
içeriği) ve `cac:Signature` entegratör tarafından eklenir. Denetimler: satır toplamı = net, net + KDV = brüt (hata);
KDV = oran × net (uyarı — `receivables.ts` KDV'yi float ile yuvarlıyor, x,xx5 sınırında 1 kuruş sapabilir).
Uç: `GET /api/customer-invoices/:id/ubl` (kind, profile, number, exchangeRate, exemptionCode/Reason). Web: fatura
sayfasında "UBL-TR önizle" + "XML indir". `ubl-tr.test.ts` 7/7 (sıra, iyi biçimlilik, tutarlar, yuvarlama, kaçış,
TCKN kişi, denetimler, ETTN) + `einvoice-live.test.ts`'e gerçek faturadan uç testi. **Resmi GİB XSD/Schematron ile
doğrulanmadı.**

## Oturum 41 devamı — kalan işler 2: gerçekçi DEMO senaryo verisi

`src/db/seed-scenario.ts` (`pnpm db:seed-scenario`, `db:seed`'den sonra): DEMO-ELK şirketinde GERÇEK API uçlarıyla bir iş
akışı oynatır — ürün + BOM + üç alanlı devir, bitmiş ürün stoğu + lot maliyeti, satış → sevkiyat → 45 gün önce kesilmiş
(vadesi geçmiş) fatura, bütçeli Ar-Ge projesi (5.000 TL) → proje talebi → teklif → ödül (6.250 TL, bütçe aşımı), satın alma
siparişi → 8 gün önceye teyit → bugün mal kabul (geç teslim). Geçmiş tarihler yalnız API'nin kabul ettiği alanlarla
(fatura tarihi, teyit tarihi) verilir; hiçbir tutar/durum SQL ile yazılmaz. Sonuç (bu ay): **tahsilat, proje bütçesi,
tedarikçi performansı, kârlılık** alanları onay bekleyen bulgu üretir → AI yorumu (madde 3) anahtar gelince hemen
denenebilir. Üretim hareketi gerektiren fire/yeniden işleme, kapasite, revizyon etkisi, stok açığı veri yetersiz kalır.
Idempotent (DEMO-KART-01 varsa atlanır). `seed-scenario.test.ts` 2/2: boş şemada seed + senaryo → dört bulgu; ikinci
çalıştırma atlanır. Yerel dev veritabanına da uygulandı ve rapor gerçek API'den okunarak doğrulandı.


## Oturum 41 devamı — kalan işler 3: canlı e-belge ve kargo çağrıları arka plana (outbox)

**Önce:** canlı gönderimde sağlayıcı çağrısı istek içinde, fatura/sevkiyat satırı kilitliyken yapılıyordu. **Şimdi:** istek
hazırlığı denetleyip kaydı `queued` işaretler ve outbox'a `einvoice.send` / `cargo.label` bırakır (hızlı döner). İşçi
`processEinvoiceSend` / `processCargoLabel` ile: (1) kısa işlemde queued → sending, (2) dış çağrı açık işlem yokken,
(3) sonucu ayrı işlemde yazar. Migration 054: `customer_invoices.einvoice_status/error/requested_*`,
`shipments.cargo_request_status/error/requested_*` (eski kayıtlar sent/created olarak doldu).

**Çift resmi belge / ücretli kayıt koruması:** adaptör `ConnectorError(msg, { notSent: true })` fırlatırsa → `failed`
(sağlayıcı kesin reddetti, hiçbir şey oluşmadı; düzeltip yeniden gönderilebilir). Diğer her hata (zaman aşımı, ağ, 5xx) →
`unknown`: OTOMATİK TEKRAR YOK, yeniden gönderim engellenir (`send_outcome_unknown`), kullanıcı sağlayıcı panelinden
doğrulayıp `POST /api/customer-invoices/:id/einvoice-resolve` (gerçek ETTN ile sent / not_sent) veya
`POST /api/shipments/:id/cargo-resolve` ile işaretler (gerekçe zorunlu, olay kaydı). İşçide işlem fonksiyonu beklenmedik
hata fırlatırsa outbox işi de `unknown` olur (yeniden denenmez). Sağlayıcıya fatura kodundan sabit ETTN (`doc.ettn`)
gider — ikinci kez ulaşırsa sağlayıcı/GİB mükerrer olarak reddedebilir. Web: fatura ve sevkiyat sayfalarında
kuyruk/red bildirimi ve belirsiz sonuç çözüm formu.

**Doğrulama:** `einvoice-live.test.ts` canlı akış testi genişletildi (istek dış çağrı yapmaz, sürüyor reddi, kesin ret →
failed, zaman aşımı → unknown, tekrar işleme sağlayıcıya gitmez, yeniden gönderim engeli, elle çözüm, başarılı gönderim,
sabit ETTN, olay zinciri); `cargo-live.test.ts` kuyruk + işleme + çözüm ucu. Tam paket 353/353 (49 dosya). Not: yerelde
canlı gönderimin işlenmesi için outbox işçisinin çalışması gerekir (`pnpm --filter @apisfactory/api outbox`).


## Oturum 41 devamı — kalan işler 4: web rota bazlı kod bölme

`App.tsx` 66 sayfayı `React.lazy` + tek `Suspense` ile yükler (`lazyNamed` yardımcısı adlı dışa aktarımları sarar).
Ana paket 859 kB → 354 kB (gzip 225 → 105 kB), 500 kB uyarısı kalktı. Bilinçli olarak eager kalanlar: `OfflinePage`
(bağlantı yokken yeni parça indirilemez) ve giriş öncesi `CompanySetupPage`/`OnboardingPage`.


## Oturum 41 devamı — kalan işler 5: ESLint

Kökte tek flat config (`eslint.config.mjs`): `@eslint/js` + `typescript-eslint` önerilenleri (tip bilgisiz, hızlı),
web/mobil için `react-hooks` (rules-of-hooks hata, exhaustive-deps uyarı). `no-explicit-any` kapalı (pg satırları ve dış
servis cevapları bilinçli `any`); `_` önekli değişkenler serbest. Komut: `pnpm lint` (`--max-warnings 0`), `pnpm lint:fix`.
İlk çalıştırmada çıkan 25 hata düzeltildi: kullanılmayan içe aktarımlar, `prefer-const`, CSV'de regex içine gömülü görünmez
BOM → görünür U+FEFF kaçış dizisi, `restore.mjs`'te hiç kullanılmayan `--target-app-url` parametresi kaldırıldı (geri yükleme baştan beri
yalnız migration bağlantısı + şirket başına `app.company_id` ile RLS içinden çalışıyor). Not: kök `typescript-eslint`
typescript'i eş bağımlılık istediği için hoisted düzende mobilin typescript 6.0.3'ü köke taşındı; api/web kendi 5.9.3'ünü
kullanır.

## Oturum 41 devamı — kalan işler 6: W03 distribütör erişim matrisi

`docs/w03-distributor-erisim-matrisi.md` — ayrıntı orada. Mouser/Farnell önbellek ve saklama yasağı açık engel.


## Oturum 41 devamı — kalan işler 7a: R05 devirde Ar-Ge maliyeti

Migration 055. Revizyon bir Ar-Ge projesine bağlanır (`PUT /api/revisions/:id/rd-project`, yayından sonra değişmez).
Maliyet (`lib/rd-cost.ts` → `computeRdCost`, para BigInt kuruşla):
- projeye bağlı talepten doğan her sipariş satırı bir kez: faturalanan tutar gerçek, teslim alınıp faturalanmamış
  miktar sipariş fiyatıyla tahakkuk, teslim alınmamış açık miktar yalnız "taahhüt" (toplama girmez);
- elle bölüştürülen giderler (kategori ile);
- mühendislik zamanı (`rd_time_entries`) × çalışma tarihinde geçerli `rd_labor_rates` sürümü.

Tahakkuk, açık sipariş, fiyatsız satır veya ücretsiz saat varsa rapor **geçici**. Devrin son onayında rapor sürüm 1
olarak `rd_cost_reports`'a dondurulur; sonradan gelen fatura/gider/zaman için muhasebe gerekçeyle yeni sürüm hesaplar
(`POST /api/revisions/:id/rd-cost-reports/recalculate`), fark olay defterine yazılır. Çift sayım: projenin sipariş
satırlarına bağlı tedarikçi faturası (iç kod veya fatura no.) elle bölüştürmeye kaynak gösterilemez (`double_count`).
Web: proje sayfasında anlık maliyet, zaman kaydı/ters çevirme, saat ücreti; ürün sayfasında revizyon proje bağı ve rapor
sürümleri. Kalan: Ar-Ge payının ürün birim maliyetine aktarımı (amortisman) yok; stoktan karşılanan proje malzemesi
stok çıkışı olmadığı için rapora girmez. `rd-cost.test.ts` 6/6.

## Oturum 41 devamı — kalan işler 7b: maliyet — kur, bütçe, iade tamiri/hurda

Migration 056.
- **Kur** (`lib/fx.ts`): `exchange_rates` değişmez; 1 taban = kur × karşılık, kaynak zorunlu, aynı çift/gün için yeni
  kayıt düzeltmedir (son girilen geçerli). İşlem tarihine en yakın önceki kur; `cost_policies.fx_max_age_days`
  (varsayılan 7) aşılırsa dönüştürülmez → eksik. Doğrudan çift yoksa ters çift. Kur 10 ondalıkla çarpılır. Kullanım:
  iş emri malzemesi (lot maliyet kayıt tarihi), fason iş (hesap tarihi), kâr raporu SMM (sevk tarihi), iade maliyeti
  (hareket tarihi), bütçe sapması (dönem sonu). Uçlar: `GET/POST /api/exchange-rates` (okuma field.cost.view,
  yazma cost.manage). Kur otomatik çekilmez.
- **Bütçe**: `rd_project_budgets` onaylı baz bütçe sürümleri (açılış bütçesi v1; mevcut projeler migration'da
  dolduruldu); `POST /api/rd-projects/:id/budget` (cost.manage, gerekçeli). Metrik `budget_variance` artık
  hesaplanır: açık projelerde (Ar-Ge maliyeti toplamı, bütçe para birimine çevrilmiş − son baz) / baz. Bütçeler farklı
  para birimindeyse toplu oran verilmez, proje satırları kaynak kayıtlarda.
- **İade maliyeti** (`computeRmaCost`, `GET /api/rmas/:id/cost`): `POST /api/rmas/:id/repair` artık isteğe bağlı
  `laborHours` ve `parts` alır; her deneme `rma_repair_attempts`'a değişmez yazılır, parçalar ana depodan `issue`
  hareketiyle (`ref_type = 'rma_repair'`) düşülür (yetersiz stok → `negative_stock`, deneme de geri alınır). Maliyet =
  deneme saati × deneme tarihindeki politika ücreti + saat başı genel gider + parça lot maliyeti + hurdaya ayrılan iade
  ürünü + değişim ürünü. Kâr raporunda dönemde karar verilen iadelerin maliyeti ayrı gösterilir, brüt kârdan düşülmez.

Web: Raporlar → kur tablosu ve politika azami kur yaşı, kâr raporunda iade maliyeti ve satır kuru, iş emri
malzemesinde kur; iade detayında tamir saati/parça ve iade maliyeti paneli; Ar-Ge projesinde bütçe sürümleri.

## Oturum 41 devamı — kalan işler 7c: kaynak kapasitesi ve vardiya (R29)

Migration 057, `lib/capacity.ts`, `modules/capacity.ts`. Günlük kapasite: vardiya ataması olan merkezde o güne düşen
vardiyaların net süresi (bitiş − başlangıç − mola; gece yarısını geçen vardiya başladığı güne) × istasyon; ataması
hiç olmayan merkezde hafta içi `daily_minutes` (eski davranış); tatil 0; `capacity_exceptions` eklenir/düşülür (iş
merkezi boşsa tüm merkezler). Not: vardiya ataması olan bir merkezde o gün geçerli atama yoksa kapasite 0'dır (varsayılana
düşmez). `scheduleOnCalendar` termin (`leadtime.ts`) ve senaryo (`scenarios.ts`) hesabında her merkezi takviminden gün gün
tüketir; vardiyasız merkezde sonuç eski formülle birebir (mevcut termin/senaryo testleri değişmeden geçti). Senaryodaki
ek vardiya varsayımı kapasiteli günlere eklenir.

Uçlar: `GET/POST /api/shift-patterns`, `GET/POST /api/work-center-shifts`, `POST /api/work-center-shifts/:id/end`
(atama silinmez, bitiş tarihi verilir), `GET/POST /api/capacity-exceptions` (değişmez), `GET /api/capacity/load`
(bugünden itibaren açık operasyonların kalan süresi teslim tarihi → oluşturma → sıra ile sonlu kapasiteye yüklenir;
aralık en çok 120 gün). Yazma `capacity.manage`, okuma `production.view`. Web: Kalite → kapasite bölümünde vardiya/atama/
istisna; Planlama → Gantt altında iş merkezi × gün yük tablosu. `capacity.test.ts` 5/5.

## Oturum 41 devamı — kalan işler 7d: R12 AI ile alternatif araştırması

Migration 058, `lib/alternate-research.ts`, `modules/alternate-research.ts`, ortak AI çağrısı `lib/ai-call.ts` (AI yorum
katmanı da buna taşındı; `aiDeps`/`aiConfig` ai-narrative'den yeniden dışa aktarılır). `POST /api/items/:id/alternate-research`
(Ar-Ge veya yetkili üretim): kategori, uygulama, sıcaklık, hedef, birincil datasheet alıntısı (D0), şema (S0), firmware
kanıtı, kalem kartından adaylar (C1…, datasheet DC1…) ve dış adaylar (X1…, DX1…). AI yalnız bu belgelerle karşılaştırır;
`applyRules` sürümlü kategori kurallarıyla kararı verir (aday / kanıt yetersiz / kuralla elendi / araştırma adayı).
Önce onaylı alternatifler döner; aday seçilmezse `no_candidates`. Belge tam metni saklanmaz (kimlik, başlık, uzunluk,
sha256). `POST /api/alternate-research/candidates/:id/propose` → `item_alternates` (origin `ai_research`) + Ar-Ge/üretim
onay görevleri; elenen aday reddedilir, dış aday için önce kalem kartı gerekir. Web: Alternatif parçalar → "AI'ya sor"
(yalnız Ar-Ge / yetkili üretim görür). Serbest web araması bilinçli olarak yok (W03). Gerçek model çağrısı için
ANTHROPIC_API_KEY gerekir; testler sahte yanıtla (`alternate-research.test.ts` 5/5).


## Oturum 41 devamı — W03 lisans teyidi (açık engelin kapatılması)

Migration 059. `POST /api/distributors/:id/license` (workflow.manage): sekiz izin (multi_tenant, display, cache, history,
derived_analysis, export, account_pricing, ai_processing) × allowed/denied/unknown, belge referansı zorunlu, isteğe bağlı
önbellek süresi sınırı; değişmez ve sürümlü. Canlı moda geçiş ilk üçü "allowed" değilse `license_required`; veri tabanında
`distributor_connectors_live_licensed`. Teyit daraltılınca bağlayıcı `not_connected` olur (olay kaydında). Tedarik riski
taraması canlı bağlayıcının geçmişini yalnız history + derived_analysis izinliyse kullanır. Web: Satın alma → Distribütörler
→ Ayarla altında lisans teyidi. `distributor-live.test.ts` güncellendi (+1 test).

## Oturum 41 devamı — stoktan karşılanan Ar-Ge malzemesi

Projeye bağlı talep (kısmen) stoktan karşılanınca depoya `rd_material_issue` görevi açılır. Depo `POST /api/rd-projects/:id/material-issues`
(inventory.issue; yalnız kullanılabilir stok, ayrılmamış miktar, idempotent) ile çıkış, `material-returns` ile iade yapar (net çıkıştan
fazlası iade edilemez); hareketler `stock_moves` ref_type rd_project. Ar-Ge maliyeti (`computeRdCost`) net çıkışı lotun güncel
maliyetiyle prototip malzemesine ekler (`stockIssued`); lot maliyeti yoksa rapor geçici. Depo bütçe/harcama görmez: dar liste
`GET /api/rd-projects/open-for-issue` (yalnız kod/ad). Web: Depo sayfasında "Ar-Ge projesine malzeme çıkışı / iadesi".

## Oturum 41 devamı — Ar-Ge payının ürün maliyetine aktarımı

Migration 060. `cost_policies.include_rd_share` (varsayılan kapalı — mevcut hesaplar ve parmak izleri değişmez).
`POST /api/revisions/:id/rd-amortization` (cost.manage): en son devir raporunun toplamı politika para birimine bugünkü kurla
çevrilir (kur yoksa reddedilir) ÷ planlanan adet; değişmez, sürümlü. İş emri maliyeti (politika açıksa): sağlam adet × birim pay;
aynı revizyonun diğer iş emirlerinin SON hesaplarındaki `totals.rdShare` toplamı düşülür, toplam aktarım plan tutarını aşmaz
(aşan kısım aktarılmaz, notta yazılır). Web: politika formunda "Ar-Ge payı dahil", revizyon kartında plan, iş emri maliyetinde pay.
`rd-amortization.test.ts` 3/3.

## Oturum 41 devamı — kontrol listeleri (R16/R17/R18)

Migration 061, `lib/checklists.ts`, `modules/checklists.ts`. Plan (`check_plans`): aşama giriş/ara/son/paketleme, bağlam kalem (giriş),
iş merkezi (ara/paketleme), revizyon; maddeler onay/ölçüm (sınırlı)/metin; sürümlü ve değişmez, yalnız quality.plan.manage yazar
(aşama değiştirilemez). Kayıt (`check_records`) değişmez; karar sunucuda (zorunlu eksik, sınır dışı, "uygun değil" → kaldı).
Kapanış kuralı (`assertChecksPassed`): uyan her planın GÜNCEL sürümüne karşı son kayıt geçmiş olmalı — operasyon tamamlama (ara/
paketleme), stoğa bırakma (son), mal kabul kararında kabul > 0 (giriş). Plan yoksa hiçbir şey değişmez. Web: Kalite → plan yönetimi;
iş emri operasyon satırında, son kalitede ve mal kabul kararında form. Mobil: operasyon ve giriş kontrol kartında form.
`checklists.test.ts` 4/4.

## Oturum 41 devamı — R42 senaryodan göreve / değişiklik talebine

Migration 062 (`change_requests.scenario_id`). Görev: mevcut `POST /api/tasks` artık `entityType: "scenario"` kabul eder. Değişiklik talebi:
`POST /api/change-requests` isteğe bağlı `scenarioId` (revizyon verilmezse senaryonunki). `GET /api/scenarios/:id` `followUps` (görevler,
talepler) döner. Web: Senaryolar → kayıtlı senaryoya tıkla → takip bölümü (görev / talep aç).

## Oturum 41 devamı — R14 teklif talebinde onaylı alternatif

Migration 063: `rfq_quotes.offered_item_id`; tekillik (rfq, tedarikçi, teklif edilen kalem). `GET /api/rfqs/:id` `approvedAlternates` döner.
Teklif girişi `offeredItemId`: yalnız onaylı ve GENEL (product_id null) alternatif (`not_approved_alternate` / `alternate_scope`). Ödülde
alternatif teklif gerekçe ister; PO satırı alternatif kalemle açılır (üretimde onaylı alternatif çıkışı zaten mümkün). Not: net ihtiyaç
hesabı alternatif siparişi birincil kalemin arzı saymaz. `rfq-alternates.test.ts` 3/3.

## Oturum 41 devamı — R32/R34 üretim aşaması ve ürün karmaşıklığı

Migration 064: `work_orders.production_stage` (prototype/pilot/series, varsayılan series — mevcut kayıtlar seri), `products.complexity`
(low/medium/high/boş). İş emri açılışında `productionStage`; `PUT /api/products/:id/complexity` (product.create, gerekçeli). `/api/metrics` ve
kaynak kayıtlar isteğe bağlı `stage` filtresi (hurda, ilk testte başarı, yeniden işleme); `metricData` 6. parametre (varsayılan null —
report-findings çağrıları değişmedi). Ekip raporu: `operationsByStage`, `operationsByComplexity`, `testsByStage`. `production-stage.test.ts` 3/3.

## Oturum 41 devamı — R25 birebir mesajlaşma

Migration 065. `direct_conversations` (çift başına tek; user_a < user_b) + mevcut threads/messages altyapısı (`entity_type = direct`).
Gizlilik veri tabanında: kısıtlayıcı RLS politikaları konuşmayı ve bağlı mesaj/ek/bahsetme/okundu kayıtlarını yalnız iki katılımcıya
gösterir (politika alt sorguları da RLS'e tabi olduğu için zincirleme). İstisna yalnız `app.system_scope = backup` — backup.mjs/restore.mjs
ayarlar, uygulama istekleri hiç ayarlamaz. Şirket dışa aktarımı dışa aktaranın yalnız kendi birebir konuşmalarını içerir. Uçlar:
`POST/GET /api/direct-conversations`, `/people`; mesajlar genel `/api/threads/direct/:id` uçlarıyla (bahsetme reddedilir). Web: Mesajlar.
Mobil ekran yok. `direct-messages.test.ts` 4/4 (veri tabanı düzeyi dahil).
