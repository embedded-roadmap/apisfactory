# Kabul senaryoları — T01–T24

Yalnızca gerçekten çalıştırılan testler “doğrulandı” yazılır. Komut: `pnpm test`.

| Kod | Senaryo | Beklenen | Durum | Kanıt |
|---|---|---|---|---|
| T01 | Devir onaysız ürüne kesin satış | Backend reddeder; teklif taslağı korunabilir | doğrulandı | acceptance.test.ts › T01 |
| T02 | 1.000 sipariş ve 300 uygun bitmiş stok | 300 rezervasyon, 700 üretim ihtiyacı | doğrulandı | acceptance.test.ts › T02 |
| T03 | İki sipariş eş zamanlı aynı stoğu istiyor | Toplam tahsis kullanılabilir miktarı aşmaz | doğrulandı | acceptance.test.ts › T03 (eşzamanlı iki onay) |
| T04 | Satış onayı olayı iki kez geliyor | Tek üretim ihtiyacı ve tek net alım talebi | doğrulandı | acceptance.test.ts › T02 içinde tekrar onay + T04 eşzamanlı Idempotency-Key |
| T05 | Kısmi mal kabulün bir bölümü reddediliyor | Yalnızca kabul edilen miktar kullanılabilir | doğrulandı | acceptance.test.ts › T05 |
| T06 | Üretim sürerken yeni revizyon yayımlanıyor | Açık iş kontrollü geçiş kararı olmadan değişmez | doğrulandı | production.test.ts › T06 |
| T07 | AI alternatifinde pin/elektriksel uyumsuzluk | Fark görünür; onaysız dizgi engellenir | planlandı | — |
| T08 | Alternatif Rev.B için onaylı, Rev.C'de seçiliyor | Otomatik kullanım engellenir; yeni kapsam gerekir | planlandı | — |
| T09 | İlk test başarısız, tekrar test başarılı | İlk test başarısızlığı korunur; FPY yanlış yükselmez | doğrulandı | production.test.ts › T09 ve T10 |
| T10 | Son kaliteyi geçmeyen ürüne sevkiyat | Sevk engellenir | doğrulandı | production.test.ts › T09 ve T10 |
| T11 | Makara bölme, fason transferi ve iade | Lot zinciri ve miktar dengesi korunur | planlandı | — |
| T12 | Yanlış firmware veya süresi geçmiş test ekipmanı | Tanımlı uyarı/engel ve olay kaydı oluşur | doğrulandı | production.test.ts › yanlış parça; quality.test.ts › yanlış firmware, kalibrasyon/hizmet dışı; e2e (web) |
| T13 | Aynı stok/sipariş dosyası yeniden yükleniyor | Kayıt ve miktarlar mükerrer olmaz | doğrulandı | acceptance.test.ts › T13 |
| T14 | Tarihsel sipariş aktarılıyor | Dış sipariş, ödeme ve müşteri mesajı gitmez | planlandı | — |
| T15 | Distribütör API'si kesiliyor | Bilinmiyor/eski veri gösterilir; sıfır stok sayılmaz | planlandı | — |
| T16 | Ödeme/belge/sipariş yanıtı zaman aşımına uğruyor | Uzlaştırma yapılmadan ikinci dış işlem gönderilmez | planlandı | — |
| T17 | Kısmi satış ve müşteri iadesi | Miktar, bakiye ve doğru parti maliyeti korunur | planlandı | — |
| T18 | Başka şirket/rol dosya veya API kaydına erişiyor | API, arama, dosya, export ve AI yollarında erişim yok | doğrulandı | acceptance.test.ts › T18 (API, arama, doğrudan kimlik, veri tabanı RLS). Dosya/export/AI yolları henüz yok |
| T19 | Toplantı kaydı kapalı veya erişim kaldırılmış | Kayıt oluşturulmaz; yetkisiz indirme engellenir | planlandı | — |
| T20 | Gantt görevlerine döngüsel bağımlılık ekleniyor | Kaydetme reddedilir; taahhüt sessiz değişmez | planlandı | — |
| T21 | Senaryo çalıştırılıyor | Gerçek stok, sipariş ve üretim etkilenmez | planlandı | — |
| T22 | Yönetici AI raporu az/eksik veriye dayanıyor | Sınırlılık, kaynak ve eksik veri açık gösterilir | planlandı | — |
| T23 | Tam yedekten kurtarma | Veri, dosya, ilişkiler ve yetkiler doğrulanır | planlandı | — |
| T24 | Vadesi geçmiş görünen fatura az önce ödenmiş | Güncel bakiye kontrolüyle yanlış hatırlatma engellenir | planlandı | — |

## Ek doğrulamalar (testli)

- Yayımlanmış BOM satırı veri tabanında değiştirilemez (tetikleyici).
- Fiziksel stok negatife düşemez (kısıt tetikleyicisi).
- Olay defteri UPDATE/DELETE kabul etmez.
- Sistem yöneticisi devir onayı veremez; birim yalnızca kendi alanında karar verir; ret gerekçesi zorunlu.
- Fiyat alan izni olmayan rol satış fiyatını API yanıtında almaz; teknisyen sipariş kesinleştiremez.
- Çıkış yapılan oturum belirteci tekrar kullanılamaz.
- BOM farkı eklenen/değişen satırları gösterir; belirsiz MPN eşleşmesi çözüm olmadan işlenmez.
- Karantina lotu ve başka işe ayrılmış malzeme iş emrine çıkılamaz; fazla çıkış reddedilir; aynı çıkış isteği tekrar gelirse çift hareket olmaz.
- Operasyon sırası atlanamaz; malzeme tamamlanmadan hazırlık, testi/kararı açık cihaz varken kalite kapısı kapanmaz; duraklatma nedeni zorunlu.
- Limit dışı ölçümle "geçti" kaydedilemez; istasyonun aynı çalışma kimliği ikinci test kaydı oluşturmaz.
- İş emri operasyonlar ve cihazlar uzlaşmadan kapanmaz; kapanışta çıkılan malzeme tüketilir.
- Sipariş iptali rezervasyonu bırakır, başlamamış ihtiyacı ve açık talebi iptal eder; fiziksel stok değişmez.
- Sistem yöneticisi kendi rolünü değiştiremez; askıya alınan kullanıcı erişemez; parola değişikliği diğer oturumları kapatır.
