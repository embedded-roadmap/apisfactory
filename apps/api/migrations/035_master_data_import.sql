-- Oturum 39 devamı (W39 devamı, kullanıcının 2026-09-26 devam talimatı §12 sırası): tarihsel veri geçişi
-- kapsamına müşteri ve tedarikçi ana veri içe aktarımı eklenir. Aynı BOM/açılış stoğu sihirbazı deseni
-- (önizleme → sunucu doğrulaması → onay, aynı dosya aynı hedefe iki kez işlenmez) kullanılır; farkı,
-- bunun bir hareket değil, ana veri upsert'i olmasıdır (kod eşleşirse güncellenir, yoksa oluşturulur).
alter table import_jobs drop constraint import_jobs_kind_check;
alter table import_jobs add constraint import_jobs_kind_check check (kind in ('bom', 'stock_opening', 'customers', 'suppliers'));
