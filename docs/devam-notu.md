# Devam notu

Son güncelleme: 26.09.2026 — oturum 39 devamı (kullanıcının 2026-09-26 "devam talimatları" belgesi, bkz. proje dokümanı `claude/devam-talimatlari-2026-09.md`; en son: W39 devamı — açık tedarikçi borcu (AP) tarihsel geçişi)

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
| §20/W28 Takvim canlı senkron | **dış bağımlılık bekliyor** | OAuth uygulaması (Google/Microsoft) platform işletmecisi tarafından kaydedilmeli — bkz. dışarıdan beklenenler tablosu. |
| §23/W30 Yönetici raporu + stratejik AI | **otomatik testleri geçti, gerçek tarayıcıda doğrulandı (yerel)** | `report-findings.ts` + `reports.ts`: 8 alan (fire/rework, kârlılık, tedarikçi, stok, kapasite/termin, revizyon etkisi, proje bütçesi, tahsilat) kural tabanlı hesaplanır; `report_findings.cause_type` CHECK kısıtı 'confirmed' değerini asla kabul etmez. `reports.test.ts` 13 test; web'de `/reports/executive` gerçek tarayıcı + yerel Postgres dev veritabanında uçtan uca çalıştırıldı (bkz. oturum 38). **AI (LLM) yorum katmanı hâlâ geliştirilmedi** — sağlayıcı seçilip bağlanmadı (dış bağımlılık); `ai_status='unavailable'` dürüstçe işaretleniyor. |
| W31 Öneri→görev→etki | **otomatik testleri geçti** | Öneri→inceleme→onay/red/erteleme→görev→ölçüm→bağımsız doğrulama→kapatma/yeniden açma akışının tamamı `reports.test.ts` içinde uçtan uca test edildi (aynı bulgudan ikinci öneri açılmaması, ölçen kişinin kendi ölçümünü doğrulayamaması dahil). Canlı pilot verisiyle henüz denenmedi. |
| W33 MSL/kurutma altyapısı | **otomatik testleri geçti, gerçek tarayıcıda doğrulandı (yerel)** | Oturum 22: MSL, kullanım süresi, raf ömrü, lot SKT, paket açılışı (`storage.ts`, 5 test). Oturum 39: sürümlü kurutma (bake-out) reçetesi + gerçek çevrim kaydı eklendi (bkz. aşağıda) — JEDEC J-STD-033 tablosu hâlâ **sabit kodlanmadı** (bilinçli tasarım kararı, aşağıda gerekçesi var), şirketin kendi tanımladığı kaynağa dayalı reçete var. |
| W36 E-belge/kargo bağlayıcı | **uygulandı (TEST modu), otomatik testleri geçti** | `receivables.ts`/`shipping.ts`, sağlayıcı seçilebilir tasarım var ama yalnız TEST modu; gerçek entegratör/kargo API'si **dış bağımlılık bekliyor**. |
| W03 API erişim matrisi | **geliştirilmedi** (matris dokümanı yok) | `distributors.ts` TEST/fiyat dosyası modlarını destekliyor (`distributors.test.ts` 5 test) ama resmî "her sağlayıcı için erişim matrisi" dokümanı hâlâ yok. |
| W39 Tarihsel veri geçişi | **kısmen uygulandı, otomatik testleri geçti, gerçek tarayıcıda doğrulandı (yerel)** | BOM ve stok import sihirbazı vardı; oturum 39 devamında aynı desenle müşteri/tedarikçi ana veri içe aktarımı (upsert), tüm import türleri için kaynak-hedef uzlaşma göstergesi, açık satış siparişi tarihsel geçişi ve açık tedarikçi borcu (AP) tarihsel geçişi eklendi (bkz. aşağıda). Tarihsel üretim/kalite/maliyet kayıtları ve AR (alacak) göçü hâlâ **geliştirilmedi** — AR, `customer_invoices.sales_order_id NOT NULL` kısıtı nedeniyle şema kararı gerektiriyor. |
| W40 Uçtan uca/yük/dayanıklılık | **kısmen uygulandı, otomatik testleri geçti** | 26 test dosyasında iş kuralı/yetki/RLS testleri var (204/204) — bunlar fonksiyonel kabul testidir. Oturum 39 devamında `apps/api/scripts/loadtest.mjs` (autocannon, `pnpm --filter @apisfactory/api loadtest`) eklendi ve gerçek yerel API + Postgres'e karşı çalıştırıldı: 20 eşzamanlı bağlantı × 20 sn ile `GET /api/items` (ort. 427 istek/sn, ort. gecikme 46 ms, p99 89 ms), `GET /api/stock/balances` (ort. 388 istek/sn, ort. 51 ms, p99 80 ms), `GET /api/imports` (ort. 456 istek/sn, ort. 43 ms, p99 71 ms) — üçünde de 0 hata/0 zaman aşımı. **Bu, prompt'taki 100.000 komponent/1M kayıt/100 eşzamanlı kullanıcı hedefinin tam ölçekli bir testi değildir** (sandbox disk/süre bütçesi elvermiyor; demo veri seti küçük) — yalnızca gerçek ölçülmüş, düşük ölçekli bir taban çizgisi. Gerçek ölçekli yük testi ve dayanıklılık (uzun süreli/kesinti senaryoları) hâlâ **geliştirilmedi**. |
| W41 Eğitim/destek | **uygulandı, gerçek tarayıcıda doğrulandı (yerel)** | `/help` sayfası: rol bazlı görev rehberleri (8 rol), örnek eğitim şirketi notu, `DEFAULT_ROLES`'ten otomatik üretilen yetki matrisi, içe/dışa aktarma ve video/dosya rehberi, AI önerisi inceleme rehberi, hatalı işlem düzeltme rehberi, destek talebi öncelik/sorumlu/eskalasyon tablosu, canlı geçiş kontrol listesi (bkz. aşağıda). Otomatik test yok (yeni API yüzeyi eklemeyen, salt içerik/frontend işi); doğrulama gerçek tarayıcı ekran görüntüsüyle yapıldı. |
| W42 SaaS/abonelik yaşam döngüsü | **geliştirilmedi** | Şirket izolasyonu (RLS, her tabloda `company_id`) var ve testli, ama abonelik durumu (deneme/aktif/gecikmiş/kısıtlı/iptal), paket hakları, kullanım sayacı, ödeme idempotency **geliştirilmedi**. |

## Dışarıdan beklenen girdiler (gizli değer yazılmaz — yalnız ne gerektiği)

| Sağlayıcı/konu | Gerekli erişim | Güvenli yapılandırma yeri | Bekleyen doğrulama |
|---|---|---|---|
| E-fatura özel entegratörü (Uyumsoft/Foriba/Logo/Paraşüt/Nesbilgi/GİB Portalı) | API kullanıcı/parola veya sertifika (sağlayıcıya göre değişir) | `EINVOICE_PROVIDER`, `EINVOICE_API_KEY`, `EINVOICE_API_SECRET` ortam değişkenleri (sunucu tarafı secret store) | Sağlayıcı test ortamında gerçek e-fatura gönderimi |
| Kargo firması (pilot şirketin mevcut anlaşmalısı) | API anahtarı/müşteri kodu | `CARGO_PROVIDER`, `CARGO_API_KEY` | Test ortamında gerçek etiket/takip |
| Google Calendar OAuth | Google Cloud Console'da uygulama kaydı (client id/secret) — platform işletmecisi (Zahid) tarafından oluşturulur | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | OAuth akışı ve artımlı senkron |
| Microsoft 365/Outlook OAuth | Azure AD uygulama kaydı | `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET`, `MS_OAUTH_TENANT` | OAuth akışı ve delta sorgu |
| Distribütör API'leri (DigiKey/Mouser/Farnell/Nexar) | Her birinin kendi geliştirici hesabı + ticari kullanım lisansı | `DIGIKEY_CLIENT_ID` vb. (sağlayıcı başına) | Gerçek kimlik doğrulama + ticari yeniden gösterim izni |
| Ödeme sağlayıcısı (W42, ileride) | Henüz seçilmedi | — | Seçim sonrası |
| AI/LLM sağlayıcısı (W30 yorum katmanı) | Henüz seçilmedi (sağlayıcı ve model şirkete ait karar) | `AI_PROVIDER`, `AI_API_KEY` (sunucu tarafı secret store) | Sağlayıcı seçilip bağlanınca: gerçek yorum üretimi ve `ai_status='generated'` doğrulaması |

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
12. Kalanların çoğu (W03, W28 devamı — canlı takvim senkronu, W30 AI yorum katmanı, W39–W42) dış sağlayıcı kararı, gerçek AI kapsamı veya iş/pilot süreci gerektiriyor. Kod ile ilerletilebilecek net, küçük bir kalan bulmak için önce bu listeye, sonra "Bilinen sorunlar ve sınırlar" bölümüne bakılmalı (oturum 30/31/32/33/34/35/36/38'de ICS, vekâlet görünürlüğü, sipariş onay limiti, dış hizmet maliyeti, iki seviyeli yükseltme, ECR-fason inceleme bağlantısı ve yönetici raporu gibi küçük ama gerçek boşluklar oradan bulundu) — yeni bir iş paketi tanımlanmadıkça bu liste bundan sonra büyük ölçüde sabit kalacak.
