-- Oturum 41 devamı — R32/R34 (ana talimat §18): "Prototip/pilot/seri üretimi, ürün karmaşıklığını … dikkate al."
-- İş emri üretim aşaması (varsayılan seri — mevcut kayıtlar seri sayılır) ve ürün karmaşıklığı (boş = tanımsız).
alter table work_orders add column production_stage text not null default 'series' check (production_stage in ('prototype', 'pilot', 'series'));
alter table products add column complexity text check (complexity in ('low', 'medium', 'high'));
