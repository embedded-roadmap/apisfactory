-- W39 devamı: açık satın alma siparişi tarihsel geçişi için import_jobs.kind genişletmesi.
alter table import_jobs drop constraint import_jobs_kind_check;
alter table import_jobs add constraint import_jobs_kind_check check (kind in ('bom', 'stock_opening', 'customers', 'suppliers', 'sales_orders', 'ap_invoices', 'purchase_orders'));
