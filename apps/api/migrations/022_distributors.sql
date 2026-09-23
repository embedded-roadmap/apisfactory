-- Oturum 16 (W17): distribütör fiyat/stok bağlayıcıları. Gerçek API bağlantısı YOK (lisans/erişim doğrulaması bekliyor):
--  - "test" modu: MPN'den türetilen sentetik katalog (açıkça TEST VERİSİ olarak işaretli, gerçek fiyat değildir),
--  - "price_file": şirketin distribütörden indirdiği fiyat/stok listesinin CSV yüklemesi (gerçek veri, zaman damgalı).
-- Her teklif önbellekte kaynak, alınma zamanı ve geçerlilik süresiyle tutulur; çağrılar kotaya tabi ve kayıtlıdır.

create table distributor_connectors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  key text not null check (key in ('digikey', 'mouser', 'farnell', 'nexar', 'lcsc')),
  name text not null,
  mode text not null default 'not_connected' check (mode in ('not_connected', 'test', 'price_file')),
  supplier_id uuid references suppliers(id),
  cache_ttl_minutes int not null default 1440 check (cache_ttl_minutes between 5 and 43200),
  daily_call_limit int not null default 500 check (daily_call_limit between 0 and 100000),
  currency char(3) not null default 'USD',
  note text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  unique (company_id, key)
);

create table part_offers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  connector_id uuid not null references distributor_connectors(id),
  item_id uuid references items(id),
  mpn text not null,
  manufacturer text,
  sku text,
  stock numeric(18, 0),
  moq numeric(18, 6),
  multiple numeric(18, 6),
  lead_time_days int,
  lifecycle text check (lifecycle in ('active', 'nrnd', 'eol', 'obsolete', 'unknown')),
  currency char(3) not null,
  price_breaks jsonb not null default '[]', -- [{qty, price}]
  source text not null check (source in ('test_connector', 'price_file')),
  source_ref text,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index part_offers_lookup on part_offers (company_id, lower(mpn), connector_id, fetched_at desc);

-- Bağlayıcı çağrı kaydı (kota ve izleme; değişmez)
create table connector_calls (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies(id),
  connector_id uuid not null references distributor_connectors(id),
  mpn text,
  outcome text not null check (outcome in ('ok', 'not_found', 'quota_exceeded', 'cache_hit', 'error')),
  called_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index connector_calls_day on connector_calls (connector_id, created_at);
create trigger connector_calls_append_only before update or delete on connector_calls for each row execute function forbid_mutation();

alter table items add column lifecycle text check (lifecycle in ('active', 'nrnd', 'eol', 'obsolete', 'unknown'));

do $$
declare t text;
begin
  foreach t in array array['distributor_connectors', 'part_offers', 'connector_calls'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on distributor_connectors to apis_app;
grant select, insert on part_offers, connector_calls to apis_app;

do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into distributor_connectors (company_id, key, name, currency)
    values (c.id, 'digikey', 'DigiKey', 'USD'), (c.id, 'mouser', 'Mouser', 'USD'), (c.id, 'farnell', 'Farnell', 'EUR'), (c.id, 'nexar', 'Nexar / Octopart', 'USD'), (c.id, 'lcsc', 'LCSC', 'USD')
    on conflict do nothing;
  end loop;
end $$;
