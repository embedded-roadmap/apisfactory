# W03 — Distribütör API yetenek, lisans ve erişim matrisi

**Durum:** masa başı inceleme (2026-09-29). Hiçbir sağlayıcıyla gerçek erişim denemesi yapılmadı, hiçbir sözleşme
imzalanmadı. Bu belge hukuki görüş değildir; "şartlarda" sütunları sağlayıcıların herkese açık sayfalarından özetlenmiştir
ve **imzalanacak/kabul edilecek güncel metin esas alınarak** yeniden kontrol edilmelidir (şartlar değişir). Ana prompt
§27 gereği: bilinmeyen özellik "yok/bilinmiyor" yazıldı, var sayılmadı; **API anahtarı almak ticari yeniden gösterim izni
değildir.**

İşaretler: ✅ şartlarda açıkça izinli · ⛔ şartlarda açıkça yasak · ✉️ sağlayıcıdan yazılı onay gerekir ·
❓ kamuya açık metinde bulunamadı — sağlayıcıya sorulmalı.


## 1. Teknik yetenek matrisi

| | DigiKey | Mouser | Farnell / element14 / Newark | Nexar (Octopart) | LCSC |
|---|---|---|---|---|---|
| **İşlemler** | Ürün arama (KeywordSearch), ürün ayrıntısı (ProductDetails); sipariş/teklif API'leri ayrı ürünler | Anahtar kelime ve parça no. araması; ayrıca Cart, Order, Order History API'leri | Anahtar kelime, ürün kimliği, üretici parça no. araması; ayrı Order API | GraphQL: MPN araması (`supSearchMPN`, varsayılan 10 parça), çoklu eşleme (`supMultiMatch`, en çok 3), benzer parçalar, satıcı bazında teklif | Kategori, üretici, kategoriye göre liste, ürün ayrıntısı, anahtar kelime araması (sayfa başı en çok 30); sipariş oluşturma/sorgu, sevk yöntemi |
| **Dönen alanlar** | Stok, fiyat kırılımları, MOQ, yaşam döngüsü vb. (ayrıntı alan listesi portal belgesinde) | Mouser/üretici parça no., stok, veri sayfası, yaşam döngüsü, RoHS, MOQ, katsayı, temin süresi, önerilen muadil, fiyat | Ayrıntı I/O Docs'ta; sözleşmeli fiyat için imzalı istek ("Contract Pricing Signature") | Teknik özellikler, fiyat kırılımları (1/10/100/1000/10000), ülke ve distribütör bazında stok, satıcı adı. **Octopart ekranındaki her alanın API'de olduğu varsayılmamalı** — plan bazında kısıtlanabilir | Ürün ayrıntısı, fiyat; para birimi USD, CNY, EUR, HKD |
| **Kimlik doğrulama** | OAuth 2.0 (2 ve 3 bacaklı). Erişim jetonu 30 dk, yenileme jetonu 90 gün | API anahtarı (My Mouser hesabı + başvuru formu, anahtar e-postayla gelir) | API anahtarı; anahtar devredilemez, kamuya açılamaz | OAuth 2.0 istemci kimliği (Nexar portalı); tek uç `api.nexar.com/graphql` | API anahtarı + imza + 16 karakterlik nonce + zaman damgası; önce LCSC hesabı, sonra API başvurusu |
| **Test ortamı** | Var (sandbox) — yanıt yapısı doğru, **veri istekle eşleşmeyebilir** | ❓ ayrı sandbox görülmedi | I/O Docs üzerinden canlı deneme | Ücretsiz değerlendirme uygulaması (ömür boyu 1.000 parça) | ❓ |
| **Kota** | Anlık sınır: dakikada >120 istek. Günlük sınır plana göre, `X-RateLimit-Limit` başlığında. Aşımda 429; sözleşme metnine göre saniye eşiği aşılırsa **10 dk hesap askısı** | Dakikada 30, günde 1.000 çağrı | "Size atanan sorgu sayısı"; başlangıç için ücretsiz kullanım payı, sonrası görüşmeyle | Aylık **parça** limiti (çağrı değil — dönen her parça sayılır); yeni uygulamada limit 0; her ayın 1'inde sıfırlanır; istek 90 sn'de zaman aşımı | ❓ kamuya açık değil |
| **Hata kodları** | 400, 401, 404, 405, 429, 500, 503 | ❓ (Swagger belgesinde) | ❓ (I/O Docs'ta) | GraphQL hata nesnesi; limit aşımı ❓ | ❓ |
| **Güncellik** | KeywordSearch verisi **24 saate kadar eski olabilir**; gerçek zamanlı fiyat/stok için ProductDetails | ❓ | ❓ | Satıcı bazında; güncellik zamanı ❓ | ❓ |
| **Maliyet** | Portalda plan bazında; ücretsiz başlangıç ❓ | Ücretsiz anahtar (başvuruyla) | Ücretsiz başlangıç payı, sonrası görüşme | Ücretsiz değerlendirme (1.000 parça ömür boyu); ücretli planlar "compare plans" sayfasında (üçüncü taraf kaynaklarda aylık ~2.000 parça ≈ 500 USD ve bu planda yaşam döngüsü/temin/veri sayfası kısıtı geçiyor — **resmî sayfadan doğrulanamadı**) | ❓ |


## 2. Lisans / izin matrisi (ana prompt §27'deki sekiz izin)

| İzin | DigiKey | Mouser | Farnell | Nexar | LCSC |
|---|---|---|---|---|---|
| **Çok müşterili SaaS kullanımı** (bir anahtarla birden çok şirkete hizmet) | ✉️ Yeniden satış/üçüncü tarafa dağıtım yasak; istisna `api.contact@digikey.com` üzerinden yazılı onay | ❓ | ❓ Anahtar başka uygulamaya devredilemez, alt lisans yok | ❓ (şart sayfası erişilemedi — 403) | ❓ |
| **Ticari gösterim** (müşteri ekranında) | ✅ Kendi sitenizde / iç uygulamanızda, "izinli amaç" için | ⛔ Mouser'la ilişki/onay izlenimi verecek şekilde gösterim yasak; genel gösterim ❓ | ✅ Son kullanıcıya gösterim, ancak uygulamanın **asıl amacı Farnell ürün satışını desteklemek** olmalı | ❓ | ❓ |
| **Önbellek** | ❓ Süre sınırı yok; sözleşme bitince **tüm veri silinmeli** | ⛔ "cache, record, pre-fetch veya saklama" yasak | ⛔ "cache, record, pre-fetch veya saklama" yasak | ❓ | ❓ |
| **Tarihsel kayıt** | ❓ (bitişte silme yükümlülüğü var) | ⛔ (saklama yasağı kapsamında) | ⛔ (saklama yasağı; kendi veritabanını oluşturma yasak) | ❓ | ❓ |
| **Türetilmiş analiz** | ⚠️ Türetilmiş veri **DigiKey'in mülkü ve gizli bilgisi** sayılıyor | ❓ | ⛔ İçerikten kendi veritabanını oluşturmak yasak | ❓ | ❓ |
| **Kullanıcıya export** | ⛔ Üçüncü tarafa dağıtım yasak (ekranda gösterim hariç) | ⛔ Toplu indirme yasak | ⛔ Toplu indirme yasak | ❓ | ❓ |
| **Özel hesap fiyatı** | 3 bacaklı OAuth ile kullanıcının kendi hesabı ❓ | ❓ | Sözleşmeli fiyat imzası mevcut (teknik) — kullanım şartı ❓ | ❓ | ❓ |
| **AI işleme** | ❓ Metinde yok | ❓ Metinde yok | ❓ Metinde yok | ❓ | ❓ |
| **Atıf zorunluluğu** | ✅ Evet — kaynak "açık ve belirgin" gösterilmeli | ❓ | ✅ Evet — kaynak açık ve belirgin | ❓ | ❓ |


## 3. Bizim sistemimizle çakışmalar (açık engeller)

Mevcut distribütör katmanı (`distributors.ts`, `supply-risk.ts`, migration 022/046/051) şu davranışlara sahip. Aşağıdaki
çakışmalar giderilmeden veya yazılı izin alınmadan ilgili sağlayıcı için **canlı mod açılmamalıdır**
(§27: "İzin çıkmayan özelliği canlı açma; etkisini açık engel olarak kaydet").

| Sistem davranışı | Nerede | Çakıştığı sağlayıcı | Etki |
|---|---|---|---|
| TTL önbelleği (en az 5 dk, varsayılan şirket ayarı) | `distributor_connectors.cache_ttl_minutes`, `part_offers.expires_at` | Mouser ⛔, Farnell ⛔ | Bu iki sağlayıcıda önbelleksiz çalışmak gerekir → her görüntülemede çağrı; Mouser'ın günde 1.000 çağrı kotası BOM görünümünde hızla dolar |
| Her yenilemede yeni `part_offers` satırı, süresiz saklama (doğal tarihçe) | migration 022, 046 notu | Mouser ⛔, Farnell ⛔; DigiKey'de bitişte silme yükümlülüğü | Sağlayıcı bazında saklama süresi + sözleşme bitince silme işi gerekir |
| Tedarik riski taraması (önceki/şimdiki teklif karşılaştırması: stok düşüşü, fiyat artışı, temin uzaması) | `supply-risk.ts` | Farnell ⛔, Mouser ⛔ (tarihçe yok → karşılaştırma yok); DigiKey ⚠️ (türetilmiş veri DigiKey'in mülkü) | Bu sağlayıcılarda risk taraması ya kapatılmalı ya yazılı izin alınmalı |
| RFQ otomatik teklif karşılaştırması, BOM tedarik görünümü | `distributors.ts` | DigiKey ✅ (iç uygulama, satın alma amaçlı); Farnell ancak Farnell satışını destekliyorsa | Diğerlerinde ❓ |
| Tek platform, çok şirket | Şirket başına kendi anahtarı (`credentials_enc`) | DigiKey ✉️ | **Lehimize tasarım:** her şirket kendi hesabı/anahtarıyla bağlanıyor, yani platform veriyi üçüncü tarafa dağıtmıyor. Yine de sağlayıcıya "müşterinin kendi anahtarıyla, kendi iç kullanımı" modelinin kabul edildiği teyit ettirilmeli |
| AI yorum katmanı | `ai-narrative.ts` | — | **Çakışma yok:** AI yorumu yalnız rapor bulgularına uygulanıyor, distribütör teklifleri AI'ya gönderilmiyor. Distribütör verisi AI'ya gidecekse önce her sağlayıcıdan AI işleme izni alınmalı (tüm sağlayıcılarda ❓) |
| Kaynak gösterimi | Teklif kaynağı ve zaman damgası ekranda | DigiKey, Farnell atıf ister | Mevcut "kaynak + zaman" gösterimi atıf için temel; sağlayıcı adı açıkça yazılmalı |


## 4. Sağlayıcıya sorulacaklar (K04 kararı için)

Her sağlayıcıya aynı soru listesi — cevaplar yazılı alınmalı ve bu belgeye eklenmeli:

1. Uygulama çok şirketli bir SaaS; **her müşteri şirket kendi hesabı ve anahtarıyla** bağlanıyor. Bu model kabul mü?
2. Sonuçları kaç dakika önbelleğe alabiliriz? Önbellek tamamen yasaksa, aynı kullanıcı oturumunda tekrar gösterim
   çağrı sayılır mı?
3. Teklif geçmişini (stok/fiyat/temin süresi) saklayıp zaman içindeki değişimden **tedarik riski uyarısı** üretebilir
   miyiz? Saklama süresi sınırı nedir?
4. Veriyi (ör. BOM maliyet raporu içinde) kullanıcıya CSV/PDF olarak dışa aktarabilir miyiz?
5. Verinin bir AI modeline (yorum/özet için, eğitim için değil) gönderilmesi serbest mi?
6. Kullanıcının kendi hesabına özel fiyatını (3 bacaklı OAuth / sözleşmeli fiyat) gösterebilir miyiz? Bu fiyat diğer
   şirketlere asla gösterilmez.
7. Kota: günlük/dakikalık sınır nedir, artırma koşulu ve maliyeti nedir?
8. Atıf biçimi (logo, bağlantı, metin) nasıl olmalı?


## 5. Öneri

- **İlk aday: DigiKey.** Sandbox, OAuth, belgelenmiş 429 davranışı var. Şartları iç uygulama ve satın alma amaçlı
  kullanıma açıkça izin veriyor. Önbellek için süre yasağı yok. Açık konular:
  - "Müşterinin kendi anahtarı" modelinin yazılı teyidi,
  - türetilmiş veri maddesinin tedarik riski taramasına etkisi.
- **Mouser ve Farnell:** kamuya açık şartları önbelleği ve saklamayı yasaklıyor. Yazılı istisna alınmadan canlı modda
  en fazla "anlık sorgu, saklamasız gösterim" yapılabilir. Bunun için kodda sağlayıcı bazında `önbellek yok / geçmiş
  yok / risk taraması yok` bayrakları gerekir (henüz yok — sonraki iş).
- **Nexar:** parça başına ücretlendirme ve plan bazlı alan kısıtı var. Şart metni erişilemedi. Plan ve şartlar
  netleşmeden maliyet tahmini yapılamaz.
- **LCSC:** başvuru ve onay süreci var. Kota ve şartlar kamuya açık değil.
- **Kod tarafı (önerilen sonraki adım):** canlı mod açılırken bağlayıcıya "lisans teyidi" kaydı (kim, ne zaman, hangi
  izinler, belge referansı) ve sağlayıcı bazında izin bayrakları eklenmeli. Canlı modu yalnız teyit varsa açan bir veri
  tabanı kısıtı, mevcut `distributor_connectors_live_ready` kısıtının yanına eklenebilir.


## Kaynaklar (2026-09-29 tarihinde okundu)

- DigiKey — [API SSS](https://developer.digikey.com/faq), [API User Agreement](https://developer.digikey.com/api-user-agreement)
- Mouser — [Search API](https://www.mouser.com/en/api-search/), [API Terms](https://www.mouser.com/en/apiterms/), [API Hub](https://www.mouser.com/en/api-hub/)
- Farnell / element14 — [Partner belgeleri](https://partner.element14.com/docs), [Terms of Use](https://partner.element14.com/terms)
- Nexar — [SSS](https://support.nexar.com/support/solutions/articles/101000497890-frequently-asked-questions), [Playground/sorgu notları](https://support.nexar.com/support/solutions/articles/101000494582-nexar-playground), [Octopart API şartları](https://octopart.com/api/terms) (403 — okunamadı), plan karşılaştırma: nexar.com/compare-plans
- LCSC — [OpenAPI belgesi](https://www.lcsc.com/docs/openapi/index.html), [API başvurusu](https://www.lcsc.com/agent)
