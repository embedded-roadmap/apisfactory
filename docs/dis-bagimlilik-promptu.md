# Dış bağımlılık gerektiren kalan işler — detaylı prompt / talimat seti

Bu belge, `docs/kapsam-izleme.md` ve `docs/devam-notu.md`'de "dış bağımlılık bekliyor" olarak işaretlenmiş
kalan maddelerin her biri için **kod tarafında ne hazır, kimden ne karar/erişim gerekiyor, hangi ortam
değişkenine bağlanacak, kabul kriteri ne** sorularını tek tek yanıtlayan bir çalışma promptudur. Her madde
bağımsızdır — istediğiniz sırayla, birini seçip "bununla devam et" diyerek ilerletebilirsiniz; ben o maddenin
kod tarafını (TEST modundan gerçek sağlayıcıya bağlama) siz karar/erişimi sağladıktan sonra tamamlarım.

Genel kural (proje genelinde tutarlı): **hiçbir madde de sahte/uydurma bir "bağlandı" durumu üretilmeyecek.**
Sağlayıcı seçilip gerçek erişim sağlanana kadar ilgili özellik TEST modunda, ekranda açıkça işaretli kalır.

**Ortam değişkenleri hakkında not:** aşağıdaki "Bağlanacağı yer" satırlarındaki değişken adları (`EINVOICE_*`,
`CARGO_*`, `AI_*`, `DIGIKEY_*`, `GOOGLE_OAUTH_*`, `MS_OAUTH_*`) **önerilen** adlardır — henüz ne kodda ne de
`apps/api/.env.example`'da tanımlı. Şu an `apps/api/src/config.ts` yalnızca `NODE_ENV`, `PORT`, `CORS_ORIGIN`,
`SESSION_HOURS` okuyor. Her madde bağlanırken ilgili değişkenler `config.ts`'e (doğrulamasıyla) ve
`.env.example`'a (değersiz şablon olarak) eklenecek.

---

## 1. E-fatura / e-arşiv entegratörü (R10, R48, W36)

**Şu an kod tarafında hazır olan:** `einvoice_connectors` tablosu (migration 024), 6 sağlayıcı seçeneği
önceden tanımlı: `gib_portal` (GİB e-Belge Portalı), `uyumsoft`, `foriba`, `logo` (e-Fatura), `parasut`
(Paraşüt), `nesbilgi`. Şu an hepsi `mode='not_connected'` veya elle `'test'`e alınabiliyor (sentetik ETTN
üretir, "TEST — resmiyeti yok" etiketiyle). Kesilmiş faturadan gönderim akışı, `document_dispatches`
değişmez denetim kaydı, bağlayıcı operasyon panosu (W38) — hepsi hazır ve TEST modunda çalışıyor.

**Oturum 41'de eklenen (sağlayıcıdan bağımsız):** migration 048 ile şirket/müşteri vergi kimliği (VKN/TCKN
kontrol hanesiyle), `'live'` modu, ortam (sandbox/production) ve şifreli erişim bilgisi; `einvoiceReadiness()`
hazırlık denetimi; `EINVOICE_PROVIDERS` adaptör kayıt defteri (bilerek boş — adaptörü olmayan sağlayıcı canlıya
alınamaz); web'de vergi kimliği kartları ve yalnız-yazılır erişim bilgisi formu. Ayrıntı: `devam-notu.md` →
"Oturum 41".

**Sizden/şirketten karar gerekenler:**
1. Hangi sağlayıcı? (GİB Portalı ücretsiz ama manuel/sınırlı; Uyumsoft/Foriba/Logo/Paraşüt/Nesbilgi
   ticari özel entegratörler — hacim, fiyat, mevcut muhasebe yazılımıyla uyum kriterine göre şirketin
   seçmesi gerekiyor. Pratik öneri: şirketin mali müşavirinin/muhasebe yazılımının zaten çalıştığı entegratör
   ilk adaptör için en az sürtünmeli seçimdir.)
2. Sağlayıcıyla sözleşme + test ortamı erişimi (özel entegratörlerin çoğu önce bir "test/sandbox" hesabı,
   sonra canlıya geçiş süreci ister) ve sağlayıcının API dokümantasyonu.
3. Kimlik bilgileri: sağlayıcıya göre değişir — API kullanıcı adı/parola, veya sertifika (özel entegratör
   API'lerinin çoğu mali mühür/e-imza sertifikası veya API anahtarı ister).

**Bağlanacağı yer:** erişim bilgisi **şirket başına**, uygulamanın e-belge bağlayıcıları ekranından girilir ve
`einvoice_connectors.credentials_enc` sütununda AES-256-GCM ile şifreli saklanır (bağlayıcılar çok kiracılı —
her şirketin kendi entegratör sözleşmesi var; tek bir platform ortam değişkeni bu yapıya uymaz). Platform
düzeyinde tek sır şifreleme anahtarıdır: `CONNECTOR_SECRET_KEY` (sunucu tarafı secret store, asla koda yazılmaz).

**Şema:** oturum 41'de tamamlandı (migration 048 — `'live'` modu, `einvoice_connectors_live_ready` kısıtı,
`customer_invoices.document_mode` `'live'`).

**Kabul kriteri:** sağlayıcının kendi test ortamında gerçek bir e-fatura/e-arşiv gönderiminin başarıyla
iletilmesi ve dönen gerçek ETTN'nin kaydedilmesi (sentetik değil).

**Bana ne söylemeniz yeterli:** "Uyumsoft'u seçtik" + sağlayıcının API dokümantasyonu. Erişim bilgisini sohbete
yazmayın — uygulamanın e-belge bağlayıcıları ekranından kendiniz girin. Ben o sağlayıcı için
`apps/api/src/lib/einvoice-providers.ts`'e bir adaptör yazar, `EINVOICE_PROVIDERS`'a eklerim; `dispatch.ts`'teki
canlı gönderim yolu (`sendLive`) hazır. Otomatik test + sağlayıcı test ortamında gerçek gönderim ile doğrularım.

---

## 2. Kargo firması entegrasyonu (R48, W36)

**Şu an kod tarafında hazır olan:** `cargo_connectors` tablosu, 6 firma önceden tanımlı: `yurtici`
(Yurtiçi Kargo), `aras` (Aras Kargo), `mng` (MNG Kargo), `ptt` (PTT Kargo), `surat` (Sürat Kargo), `ups`.
Paketlenmiş sevkiyattan etiket/takip no üretme akışı TEST modunda hazır (sentetik takip no, "TEST" etiketi).

**Oturum 41'de eklenen — farklı firmalara uyarlanabilir yapı (kullanıcı talebi):** firmalar arasında değişen her
şey bir **adaptöre** (`apps/api/src/lib/cargo-providers.ts` → `CargoProvider`) bırakıldı; sistemin geri kalanı
ortak. Adaptör şunları tanımlar: istenen erişim bilgisi alanları (`credentialFields`), firmaya özel gizli olmayan
ayarlar (`settingFields` — ör. servis tipi, seçenek listesiyle doğrulanır), kargo kaydı açma (`createShipment` —
takip no + PDF/ZPL/PNG etiket) ve isteğe bağlı takip sorgusu (`track` — firmanın kendi durum kodunu ortak 7 duruma
eşler: kayıt açıldı / yolda / dağıtımda / teslim / iade / sorun / bilinmiyor; ham metin de saklanır). Ortak kısım:
migration 049 (`'live'` modu, ortam, şifreli erişim bilgisi, `settings`, `cargo_connectors_live_ready` kısıtı,
şirket telefonu, sevkiyatta etiket modu/dosyası/takip durumu), `cargoReadiness()` (gönderici adres+telefon, alıcı
adres+telefon, kapalı koli, toplam ağırlık), etiket dosyasının nesne depolamada saklanıp indirilmesi, web'de
firma ayarları ve erişim bilgisi formu. Uyarlanabilirlik iki farklı sahte adaptörle (PDF/takipsiz ve ZPL/takipli)
`cargo-live.test.ts`'te sınandı. **Yeni bir firma eklemek = bir adaptör nesnesi yazıp `CARGO_PROVIDERS`'a kaydetmek.**

**Sizden/şirketten karar gerekenler:**
1. Hangi kargo firması mevcut anlaşmalınız? (Zaten bir anlaşma varsa yeni sözleşme gerekmez, sadece o
   firmanın API erişimini açtırmanız gerekir — çoğu kargo firması ticari müşterilerine ücretsiz API erişimi
   verir.)
2. Firmanın API dokümantasyonu ve test ortamı erişimi.

**Bağlanacağı yer:** erişim bilgisi **şirket başına**, kargo bağlayıcıları ekranından girilir ve şifreli saklanır
(`cargo_connectors.credentials_enc`); platform düzeyinde yalnız `CONNECTOR_SECRET_KEY` (madde 1 ile ortak).

**Şema:** oturum 41'de tamamlandı (migration 049).

**Kabul kriteri:** firmanın test ortamında gerçek bir kargo kaydı açılması, gerçek takip numarası ve etiket
dosyasının alınması; takip destekleniyorsa gerçek durum sorgusunun normalize edilmesi.

**Bana ne söylemeniz yeterli:** "Aras Kargo'yu kullanıyoruz" + firmanın API dokümantasyonu. Erişim bilgisini
sohbete yazmayın — kargo bağlayıcıları ekranından kendiniz girin. Ben o firmanın adaptörünü yazar,
`CARGO_PROVIDERS`'a eklerim; canlı yol (`labelLive`, `cargo-track`, etiket indirme) hazır.

---

## 3. AI/LLM sağlayıcısı — yönetici raporu yorum katmanı (R12, R26, W30)

**Şu an kod tarafında hazır olan:** `report-findings.ts` 8 rapor alanını (fire/yeniden işleme, kârlılık,
tedarikçi performansı, stok/eksik malzeme, kapasite/termin, revizyon etkisi, proje bütçesi, tahsilat)
tamamen **kural tabanlı, deterministik** olarak hesaplayıp `report_findings` tablosuna yazıyor;
`ai_status='unavailable'` ile dürüstçe işaretli. Şema (`report_findings.cause_type` CHECK kısıtı)
AI'ın asla `'confirmed'` (doğrulanmış neden) iddia edemeyeceğini zaten dayatıyor — izin verilen değerler
yalnızca `'hypothesis'` (varsayım/yorum) ve `'insufficient_data'` (yetersiz veri) — bu tasarım kararı sağlayıcı bağlanınca değişmeyecek.

**Karar (oturum 41):** sağlayıcı **Anthropic Claude** (kullanıcı seçimi). Kod tamamlandı: `lib/ai-narrative.ts`
(resmi `@anthropic-ai/sdk`, model `claude-opus-5` — `AI_MODEL` ile değiştirilebilir; JSON şemalı yapılandırılmış çıktı;
güvenlik sınıflandırıcısı reddederse `fallbacks: "default"` ile sunucu tarafında önerilen modele yönlendirme),
`POST /api/reports/findings/narrate` (sağlayıcı çağrısı DB işlemi dışında; yalnız yorumsuz bulgulara yazar; bulgunun
sayısal alanları/`cause_type` değişmez; hangi model/ne zaman/kim izlenir — migration 050), `GET /api/reports/ai-status`,
web'de "AI yorumu üret" düğmesi ve "AI yorumu — varsayım" etiketli gösterim. Yetki: `report.suggestion.decide`
(maliyet doğurur). `ai-narrative.test.ts` 6/6 sahte istemciyle. **Bekleyen:** gerçek anahtarla canlı doğrulama.

**Sizden gereken:**
1. API anahtarı — console.anthropic.com → Billing (bakiye; isteğe bağlı aylık harcama limiti) → API Keys.
2. Veri gizliliği notu: rapor bulguları (kâr marjı, tedarikçi performansı gibi ticari hassas veriler)
   Anthropic'e gönderilir; Anthropic API verisini varsayılan olarak model eğitiminde kullanmaz.

**Bağlanacağı yer:** `ANTHROPIC_API_KEY` (platform düzeyi — yerelde `apps/api/.env`, sunucuda hosting secret store);
isteğe bağlı `AI_MODEL`.

**Kabul kriteri:** gerçek bir yorum üretimi + `ai_status='generated'` olarak işaretlenmesi; kural tabanlı
sayısal bulgular değişmeden kalır (AI yalnızca yorum/özet katmanı ekler, hesaplamayı değiştirmez).

**Kapsam notu (R26 — sesli/görüntülü görüşme ile karıştırılmasın):** R26 ayrı bir madde — ekran paylaşımlı
gerçek zamanlı görüşme/transkript (W28'in konusu, madde 5'e bakın), bu maddeyle (rapor yorum AI'ı) doğrudan
ilgisi yok, farklı bir dış bağımlılık kategorisi.

**Bana ne söylemeniz yeterli:** anahtarı `apps/api/.env`'e `ANTHROPIC_API_KEY=...` olarak ekleyip "anahtarı ekledim"
deyin (anahtarı sohbete yazmayın). Karar bekleyen (yeterli veriye sahip) bir bulgu üzerinde gerçek yorum üretip
`ai_status='generated'` akışını uçtan uca doğrularım.

---

## 4. Distribütör API'leri — DigiKey / Mouser / Farnell / Nexar (Octopart) / LCSC (R10, R11, W03, W17)

**Şu an kod tarafında hazır olan:** `distributor_connectors` tablosu, 5 sağlayıcı önceden tanımlı:
`digikey`, `mouser`, `farnell`, `nexar`, `lcsc`. Üç mod destekleniyor: `not_connected`, `test` (MPN'den
deterministik sentetik teklif — gerçek veri değil, işaretli), `price_file` (gerçek bir CSV fiyat listesinin
elle yüklenmesi — R37'de tedarik riski taramasını canlı doğrulamak için bu mod kullanıldı, tam otomatik
API değil ama gerçek veri). Önbellek (TTL), günlük çağrı kotası, çağrı kaydı, RFQ otomatik teklif
karşılaştırması — hepsi hazır.

**Oturum 41'de eklenen (kullanıcı kararı: "istediği distribütörü seçebilsinler"):** her şirket distribütörünü ve
modunu kendi seçer (zaten şirket başınaydı); buna **CANLI API** modu eklendi. Distribütörler arasında değişen şey
(OAuth istemci kimliği / API anahtarı, istek/yanıt biçimi) adaptörde (`lib/distributor-providers.ts` →
`DistributorProvider.lookup`, ortak `DistributorOffer` biçimine çevirir); önbellek, günlük kota, çağrı kaydı, fiyat
görünürlüğü, BOM tedarik görünümü, RFQ otomatik teklif ve tedarik riski taraması canlı teklifleri de aynen kullanır
(teklif kaynağı `api`, `source_ref` ürün bağlantısı). Migration 051 (`live` modu, şifreli erişim bilgisi,
`distributor_connectors_live_ready` kısıtı). Hata olursa önbellek korunur, uyarı gösterilir, hata ayrıntısı
(sır içerebilir) sızdırılmaz. `distributor-live.test.ts` 7/7 (iki farklı sahte adaptör). **Gerçek distribütör
adaptörü yok.**

**Sizden karar gerekenler (her distribütör ayrı bir hesap/sözleşme):**
1. İlk hangi distribütörün adaptörü yazılsın? Genelde birden fazlası paralel kullanılır (DigiKey + Mouser en yaygın).
2. Her biri için geliştirici hesabı: DigiKey ve Mouser'ın kendi geliştirici portalından ücretsiz API
   anahtarı alınabilir (ticari kullanım için bazı ek onaylar gerekebilir); Nexar (Octopart) API'si ayrı bir
   ticari lisans gerektirebilir; Farnell (element14) API erişimi de ayrı başvuru ister.
3. **Ticari yeniden gösterim izni**: bu API'lerin çoğu "sonuçları kendi ürününüzde gösterme" için ayrı bir
   ticari kullanım şartı/lisansı ister — yalnızca dahili kullanım (iç ERP) ile müşteri karşı ürünü
   göstermek farklı lisans şartlarına tabi olabilir; sağlayıcıyla netleştirilmesi gerekiyor.

**Bağlanacağı yer:** erişim bilgisi **şirket başına**, Satın alma → Distribütörler → Ayarla ekranından girilir ve
şifreli saklanır (`distributor_connectors.credentials_enc`); platform düzeyinde yalnız `CONNECTOR_SECRET_KEY`.

**Kabul kriteri:** gerçek bir MPN sorgusunun gerçek stok/fiyat/lead time döndürmesi (sentetik değil),
günlük kota sayacının gerçek API kota limitleriyle eşleşmesi.

**Öncelik önerisi:** hepsini aynı anda değil, en çok kullandığınız/hacimli olan 1-2 distribütörle (örn.
DigiKey + Mouser) başlamak, gerçek veri akışını doğruladıktan sonra diğerlerini eklemek daha az riskli.

---

## 5. Takvim canlı senkronu — Google Calendar / Microsoft 365 OAuth (W28)

**Şu an kod tarafında hazır olan:** Toplantı akışı (gündem, katılım, tutanak, karar/aksiyon→görev,
değişmez kapanış) ve statik `.ics` daveti (RFC 5545, katılımcı kendi takvimine elle içe aktarır) tamamen
çalışıyor. Gerçek görüşme/kayıt/transkript ve **canlı** (iki yönlü, otomatik) takvim senkronu yok.

**Sizden/platform işletmecisinden (siz) karar gerekenler:**
1. Google Cloud Console'da bir OAuth uygulaması kaydı (Calendar API kapsamıyla) — bu platform işletmecisi
   olarak sizin yapmanız gereken bir adım, şirket kullanıcılarının değil (uygulama tek bir OAuth istemcisi
   üzerinden çalışır, her kullanıcı kendi hesabıyla yetkilendirir).
2. Ve/veya Azure AD'de bir uygulama kaydı (Microsoft Graph Calendar API kapsamıyla), Microsoft 365/Outlook
   kullanan şirketler için.
3. Onay ekranı (consent screen) metni/logosu — Google/Microsoft kullanıcılara "bu uygulama takviminize
   erişmek istiyor" onay ekranını gösterir, marka/metin sizin belirlemeniz gereken bir detay.

**Bağlanacağı yer:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`
(Google için); `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET`, `MS_OAUTH_TENANT` (Microsoft için) — önerilen adlar, henüz
tanımlı değil.

**Kabul kriteri:** bir kullanıcının kendi Google/Microsoft hesabına OAuth ile bağlanıp gerçek bir
toplantının iki yönlü (uygulama→takvim ve takvim→uygulama) senkronize olması; artımlı (delta) senkron —
her seferinde tüm takvimi çekmek yerine yalnızca değişenleri almak.

**Not:** gerçek görüşme/kayıt/transkript (aynı W28 paketinin diğer parçası) ayrı, daha büyük bir dış
bağımlılık — bir video konferans sağlayıcısı (Zoom/Google Meet/Teams API) ve konuşma-metne (speech-to-text)
sağlayıcısı seçimi gerektirir; bu belgeye dahil edilmedi çünkü henüz "planlandı" bile değil, ana talimatta
ayrı bir gelecek iş paketi olarak durmalı — isterseniz ayrı bir madde olarak detaylandırabilirim.

---

## 6. Ödeme sağlayıcısı — abonelik ücreti tahsilatı (W42)

**Şu an kod tarafında hazır olan:** Durum makinesi (deneme→aktif→gecikmiş→kısıtlı→iptal), paket/kullanım
sayaçları, **idempotent ödeme kaydı** (`POST /api/subscription/payments`) — ama bu yalnızca dışarıda
yapılmış bir ödemenin elle girilen notudur, gerçek bir tahsilat/fatura akışı değil ve durumu otomatik
değiştirmez.

**Sizden karar gerekenler:**
1. Hangi ödeme sağlayıcısı? (iyzico, Stripe, Param, PayTR gibi — Türkiye pazarı için iyzico/PayTR yaygın,
   uluslararası için Stripe.)
2. Sağlayıcı hesabı + API anahtarları (genelde test/sandbox anahtarıyla başlanır).
3. Fatura kesme sorumluluğu: ödeme sağlayıcısı mı fatura kesecek yoksa e-fatura entegratörünüz mü (madde 1
   ile bağlantılı bir karar).

**Kabul kriteri:** sağlayıcının test/sandbox modunda gerçek bir kart işleminin (test kartıyla) başarıyla
tamamlanması ve `companies.subscription_status`'ün otomatik güncellenmesi (elle not girme yerine).

**Not:** bu, platform işletmecisi (siz) için bir gelir modeli kararı da içeriyor — hangi paketin ne kadar
tuttuğu, deneme süresi sonu otomatik mi yoksa manuel onaylı mı kesintiye gireceği gibi iş kararları da
teknik entegrasyondan önce netleşmeli.

---

## Özet tablo — hangi kararı kimden bekliyorum

| # | Madde | Beklenen karar | Beklenen erişim bilgisi |
|---|---|---|---|
| 1 | E-fatura entegratörü | Sağlayıcı seçimi (6 seçenek) | API kullanıcı/parola veya sertifika |
| 2 | Kargo firması | Mevcut anlaşmalı firma (6 seçenek) | API anahtarı/müşteri kodu |
| 3 | AI/LLM sağlayıcısı | Sağlayıcı/model seçimi | API anahtarı |
| 4 | Distribütör API'leri | Hangi distribütör(ler) (5 seçenek) | Her biri için geliştirici hesabı + API anahtarı |
| 5 | Takvim OAuth | Google ve/veya Microsoft | Platform işletmecisi (siz) uygulama kaydı yapar |
| 6 | Ödeme sağlayıcısı | Sağlayıcı seçimi + gelir modeli kararı | API anahtarları (sandbox önce) |

**Nasıl ilerleriz:** yukarıdaki tablodan istediğiniz bir satırı seçip karar/erişim bilgisini paylaştığınızda,
o maddenin kod tarafını (mevcut TEST bağlayıcı çerçevesini gerçek sağlayıcıya bağlama) tamamlar, otomatik
test + sağlayıcının kendi test ortamında gerçek bir işlemle doğrularım — projenin bu oturuma kadar tüm
R/W maddelerinde izlediğim aynı altı durumlu dürüst raporlama disipliniyle (geliştirilmedi / uygulandı /
otomatik testleri geçti / sağlayıcı test ortamında doğrulandı / canlıda doğrulandı / dış bağımlılık
bekliyor).
