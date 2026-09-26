-- W32 devamı: "revizyon geldiğinde devam/durdur/yeniden işle kararı otomasyonu yok" boşluğu.
-- İş emrini bekleten/yeniden işleten/kalanı iptal eden bir değişiklik talebi kararı, o iş emrine bağlı
-- (henüz tamamlanmamış) bir fason işi varsa otomatik olarak dış firmaya yansımaz (sunucu tahmin etmez) —
-- yalnızca satın alma/üretime "devam/durdur/yeniden işle" kararı için bir görev açılır ve nedeni işte görünür kılınır.
alter table subcontract_jobs add column review_reason text;
