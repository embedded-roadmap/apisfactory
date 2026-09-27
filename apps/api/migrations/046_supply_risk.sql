-- Oturum 40 (R37): tedarik riskinin sipariş ve termine etkisi.
-- part_offers (migration 022) her yenilemede yeni bir satır ekliyor — bu, doğal bir tarihsel anlık görüntü
-- zaten var demek; ayrı bir "snapshot" tablosu kurmaya gerek yok.
-- ÖNEMLİ DÜRÜSTLÜK NOTU: TEST bağlayıcısı MPN'den deterministik türer (aynı MPN + bağlayıcı = hep aynı
-- stok/fiyat/temin/yaşam döngüsü). Bu yüzden stok düşüşü / fiyat artışı / temin uzaması gibi İKİ ANLIK
-- GÖRÜNTÜ KARŞILAŞTIRMASI gerektiren riskler TEST modunda YAPISAL OLARAK asla tetiklenmez — çünkü gerçekten
-- hiçbir şey değişmiyor. Bu bir eksiklik değil, doğru davranıştır (uydurma değişim üretilmez). Bu tür riskler
-- gerçek veriyle (FİYAT DOSYASI'nın zaman içinde yeniden yüklenmesi ya da ileride gerçek distribütör API'si)
-- etkinleşir. TEK anlık görüntüden çıkarılabilen riskler (kaynakta stok yok, yaşam döngüsü NRND/EOL/OBSOLETE)
-- TEST modunda da gerçek (uydurulmamış) sinyal verir — sentetik üretici zaten bu değerleri MPN'ye göre üretiyor.

create table supply_risk_settings (
  company_id uuid primary key references companies(id),
  enabled boolean not null default true,
  stock_drop_pct numeric(5, 2) not null default 50 check (stock_drop_pct between 1 and 100),
  price_increase_pct numeric(5, 2) not null default 20 check (price_increase_pct between 1 and 500),
  lead_time_increase_days int not null default 10 check (lead_time_increase_days between 1 and 365),
  scan_frequency_hours int not null default 24 check (scan_frequency_hours between 1 and 720),
  last_scanned_at timestamptz,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table supply_risks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  item_id uuid not null references items(id),
  connector_id uuid references distributor_connectors(id),
  risk_type text not null check (risk_type in ('no_source_stock', 'lifecycle_risk', 'stock_drop', 'price_increase', 'lead_time_increase')),
  severity text not null check (severity in ('warning', 'critical')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  previous_snapshot jsonb,
  current_snapshot jsonb not null,
  change_summary text not null,
  source_fetched_at timestamptz not null,
  open_request_qty numeric(18, 6) not null default 0,
  open_po_qty numeric(18, 6) not null default 0,
  earliest_need_date date,
  has_approved_alternate boolean not null default false,
  recommended_action text not null,
  responsible_role text not null,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_reason text,
  escalated_task_opened boolean not null default false
);
-- Tekilleştirme: kalem+risk türü başına yalnızca tek bir AÇIK kayıt.
create unique index supply_risks_open_dedup on supply_risks (company_id, item_id, risk_type) where status = 'open';
create index supply_risks_lookup on supply_risks (company_id, status, severity, detected_at desc);

do $$
declare t text;
begin
  foreach t in array array['supply_risk_settings', 'supply_risks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on supply_risk_settings to apis_app;
grant select, insert, update on supply_risks to apis_app;

-- Yeni izin: tedarik riski ayarlarını değiştirme ve tarama tetikleme (görüntüleme mevcut purchase.view ile).
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into supply_risk_settings (company_id) values (c.id) on conflict do nothing;
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm from roles r
      join (values ('purchasing', 'supply.risk.manage'),
                   ('manager', 'supply.risk.manage')) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
