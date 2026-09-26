-- W39 devamı: tarihsel üretim (iş emri) geçişi. Canlı iş emri akışından bilinçli olarak farklı — bkz.
-- imports.ts'teki POST /api/imports/work-orders/preview açıklaması. Geçmiş bir iş emrinin hangi
-- operasyonlardan/malzeme lotlarından geçtiği bilinmediğinden bu ayrıntı uydurulmaz; yalnızca sağlam/hurda
-- adet ve tamamlanma tarihi (ve varsa verilen birim maliyet) olduğu gibi kaydedilir. Bu yüzden `migrated`
-- sütunu, gösterge ekranlarının (malzeme/operasyon/maliyet) bu farkı açıkça belirtebilmesi için gerekli.
alter table work_orders add column migrated boolean not null default false;

alter table import_jobs drop constraint import_jobs_kind_check;
alter table import_jobs add constraint import_jobs_kind_check
  check (kind in ('bom', 'stock_opening', 'customers', 'suppliers', 'sales_orders', 'ap_invoices', 'purchase_orders', 'ar_invoices', 'work_orders'));
