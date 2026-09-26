-- W39 devamı: açık alacak (AR) tarihsel geçişi.
-- customer_invoices.sales_order_id bugüne kadar NOT NULL idi çünkü canlı akışta her fatura sevk edilmiş bir
-- sevkiyattan (dolayısıyla gerçek bir satış siparişinden) hazırlanıyordu. Geçmişten taşınan bir fatura için
-- gerçek bir sipariş/sevkiyat bağlantısı yoktur; bunu uydurmak (sahte sipariş açmak) yerine sütunu nullable
-- yapıp göçmüş kaydı ayrıca işaretliyoruz (AP'deki match_result.migrated işaretçisiyle aynı dürüstlük deseni).
alter table customer_invoices alter column sales_order_id drop not null;
alter table customer_invoices add column migrated boolean not null default false;

alter table import_jobs drop constraint import_jobs_kind_check;
alter table import_jobs add constraint import_jobs_kind_check check (kind in ('bom', 'stock_opening', 'customers', 'suppliers', 'sales_orders', 'ap_invoices', 'purchase_orders', 'ar_invoices'));
