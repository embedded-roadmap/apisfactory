-- Oturum 9 (W22): test istasyonu adaptörü (TEST modu). CSV yükleme ve istasyon API'si aynı eşleme ile
-- cihaz serisine bağlanır; kayıt, elle test girişindeki kuralların aynısından geçer (firmware, ekipman, plan limitleri).

create table test_station_connectors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  equipment_id uuid not null references equipment(id),
  mode text not null default 'test' check (mode in ('test')), -- canlı mod ayrı karar (bağlayıcı doğrulaması) gerektirir
  status text not null default 'active' check (status in ('active', 'disabled')),
  -- { serial, runId?, timestamp?, result?, firmware?, decimal: "."|",", serialStrip?: string, measurements: [{ column, name, scale }] }
  mapping jsonb not null,
  token_hint text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code)
);

-- İstasyon belirteci: yalnızca özet saklanır; RLS'siz ayrı tablo, uygulama rolü doğrudan okuyamaz,
-- yalnızca dar kapsamlı fonksiyonla eşleşme bulunur.
create table test_station_tokens (
  token_hash text primary key,
  connector_id uuid not null unique references test_station_connectors(id),
  company_id uuid not null references companies(id),
  created_at timestamptz not null default now()
);
revoke all on test_station_tokens from apis_app;

create or replace function station_token_lookup(p_hash text)
returns table (connector_id uuid, company_id uuid)
language sql security definer set search_path = public stable as $$
  select t.connector_id, t.company_id from test_station_tokens t where t.token_hash = p_hash
$$;

create or replace function station_token_set(p_connector uuid, p_hash text)
returns void
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select company_id into cid from test_station_connectors where id = p_connector and company_id = app_company_id();
  if cid is null then raise exception 'not_found' using errcode = 'P0001'; end if;
  delete from test_station_tokens where connector_id = p_connector;
  insert into test_station_tokens (token_hash, connector_id, company_id) values (p_hash, p_connector, cid);
end $$;
grant execute on function station_token_lookup(text), station_token_set(uuid, text) to apis_app;

create table test_station_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  connector_id uuid not null references test_station_connectors(id),
  source text not null check (source in ('csv', 'api')),
  file_name text,
  content_sha256 text not null,
  status text not null default 'preview' check (status in ('preview', 'committed', 'cancelled')),
  total int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  committed_by uuid references users(id),
  committed_at timestamptz,
  unique (connector_id, content_sha256)
);

create table test_station_rows (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  batch_id uuid not null references test_station_batches(id),
  row_no int not null,
  raw jsonb not null,
  serial text,
  external_run_id text,
  measured_at timestamptz,
  firmware_version text,
  measurements jsonb not null default '[]',
  status text not null check (status in ('ready', 'duplicate', 'unknown_serial', 'invalid', 'rejected', 'recorded')),
  result text check (result in ('pass', 'fail')),
  code text,
  message text,
  device_id uuid references devices(id),
  test_run_id uuid references test_runs(id),
  unique (batch_id, row_no)
);
create index test_station_rows_batch on test_station_rows (batch_id);

-- Test çalışmasının kaynağı ve istasyonun ölçüm zamanı
alter table test_runs add column source text not null default 'manual' check (source in ('manual', 'station_csv', 'station_api'));
alter table test_runs add column measured_at timestamptz;
alter table test_runs add column station_batch_id uuid references test_station_batches(id);

do $$
declare t text;
begin
  foreach t in array array['test_station_connectors', 'test_station_batches', 'test_station_rows'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on test_station_connectors, test_station_batches, test_station_rows to apis_app;
