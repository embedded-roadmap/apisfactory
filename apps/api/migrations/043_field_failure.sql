-- R44: saha arızasının seri/lot/revizyona bağlanması — gerçek bir akış eksikliği düzeltmesi.
--
-- `rmas.kind` sütunu 011_returns.sql'den beri 'field_failure' değerini zaten kabul ediyordu, ama
-- işlem akışı (receive → inspect → decide) her kind için AYNI fiziksel depo hareketini zorunlu
-- kılıyordu: teslim alma adımı stok hareketi yazıp cihazı 'returned' işaretliyor, karar adımı
-- (repair/replace/scrap/restock) "iade kabul" konumundan stok hareketi çıkarıyor. Saha arızasında
-- cihaz FİZİKSEL OLARAK GERİ GELMEZ (müşteride kalır, belki uzaktan/yerinde çözülür) — bu yüzden
-- eski akış ya imkansız bir durumu (bulunmayan konumdan stok hareketi) ya da UYDURMA bir "iade
-- kabul edildi" hareketini üretirdi. Bu migration saha arızasına özgü, stok hareketi YARATMAYAN
-- iki yeni sonuç ekler ve gerekirse gerçek bir iadeye (fiziksel gönderim olursa) yükseltme
-- bağlantısı sağlar.
alter table rmas drop constraint rmas_disposition_check;
alter table rmas add constraint rmas_disposition_check
  check (disposition in ('return_as_is', 'repair', 'replace', 'scrap', 'restock', 'logged_no_action', 'escalated_to_rma'));

-- Saha arızası gerçek bir iadeye (müşteri cihazı göndermeye karar verirse) yükseltilirse, yeni
-- açılan 'return'/'warranty' kayda bağlantı — geçmiş saha arızası kaybolmaz, yükseltildiği kayıt
-- izlenebilir olur.
alter table rmas add column escalated_rma_id uuid references rmas(id);
