-- Oturum 3: test planı ve limit sürümleri, ekipman ve kalibrasyon, firmware sabitleme,
-- termin hesabı için kapasite/takvim, mühendislik değişiklik talepleri.

-- ---------------------------------------------------------------------------
-- Firmware: revizyonun yayımlanmış firmware sürümü ve özeti; iş emri bunu sabitler.
-- ---------------------------------------------------------------------------
alter table product_revisions add column firmware_version text;
alter table product_revisions add column firmware_sha256 text check (firmware_sha256 is null or firmware_sha256 ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- Test planı: revizyon başına sürümlü; yayımlanan sürüm değiştirilemez (prompt §16).
-- ---------------------------------------------------------------------------
create table test_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  product_revision_id uuid not null references product_revisions(id),
  version_no int not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (product_revision_id, version_no)
);

create table test_limits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  test_plan_id uuid not null references test_plans(id),
  seq int not null,
  name text not null,
  unit text,
  low numeric(18, 6),
  high numeric(18, 6),
  required boolean not null default true,
  unique (test_plan_id, name),
  check (low is null or high is null or low <= high)
);

create or replace function guard_published_test_plan() returns trigger
language plpgsql as $$
declare st text;
begin
  select status into st from test_plans where id = coalesce(new.test_plan_id, old.test_plan_id);
  if st <> 'draft' then
    raise exception 'test_plan_published: yayımlanmış test planı değiştirilemez; yeni sürüm açın' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger test_limits_guard before insert or update or delete on test_limits for each row execute function guard_published_test_plan();

-- ---------------------------------------------------------------------------
-- Ekipman ve kalibrasyon (prompt §16): süresi dolmuş ekipmanla test kaydı politikaya göre engellenir.
-- ---------------------------------------------------------------------------
create table equipment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  kind text not null check (kind in ('test_station', 'measuring', 'fixture', 'programmer')),
  status text not null default 'active' check (status in ('active', 'out_of_service')),
  calibration_due date,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table calibration_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  equipment_id uuid not null references equipment(id),
  calibrated_on date not null,
  valid_until date not null check (valid_until > calibrated_on),
  certificate text,
  recorded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create trigger calibration_records_append_only before update or delete on calibration_records for each row execute function forbid_mutation();

-- İş emri test planını ve firmware sürümünü sabitler; test çalışması kullanılan ekipmanı taşır.
alter table work_orders add column test_plan_id uuid references test_plans(id);
alter table work_orders add column firmware_version text;
alter table work_orders add column firmware_sha256 text;
alter table work_orders add column hold_reason text;
alter table test_runs add column test_plan_id uuid references test_plans(id);
alter table test_runs add column equipment_id uuid references equipment(id);

-- ---------------------------------------------------------------------------
-- Termin: iş merkezi kapasitesi, standart süreler, tatiller, kalem temin süresi.
-- ---------------------------------------------------------------------------
alter table work_centers add column daily_minutes int not null default 450 check (daily_minutes > 0);
alter table work_centers add column setup_minutes int not null default 0 check (setup_minutes >= 0);
alter table work_centers add column minutes_per_unit numeric(10, 3) not null default 0 check (minutes_per_unit >= 0);
alter table items add column lead_time_days int check (lead_time_days is null or lead_time_days >= 0);

create table holidays (
  company_id uuid not null references companies(id),
  day date not null,
  name text not null,
  primary key (company_id, day)
);

-- Müşteriye verilen tarih ayrı alan; gecikme bu tarihi sessizce değiştirmez (prompt §4, §12).
alter table sales_orders add column estimate jsonb;

-- ---------------------------------------------------------------------------
-- Mühendislik değişiklik talebi (prompt §9). Talep BOM'u doğrudan değiştirmez.
-- ---------------------------------------------------------------------------
create table change_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  product_revision_id uuid not null references product_revisions(id),
  work_order_id uuid references work_orders(id),
  device_serial text,
  title text not null,
  description text not null,
  urgency text not null default 'normal' check (urgency in ('low', 'normal', 'high', 'critical')),
  stop_production boolean not null default false,
  status text not null default 'open' check (status in ('open', 'approved', 'rejected', 'implemented')),
  decision_type text check (decision_type in ('deviation', 'permanent_revision', 'stop_production', 'field_action')),
  effectivity text,
  open_work_order_decisions jsonb,
  decision_note text,
  opened_by uuid not null references users(id),
  decided_by uuid references users(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (company_id, code)
);

do $$
declare t text;
begin
  foreach t in array array['test_plans', 'test_limits', 'equipment', 'calibration_records', 'holidays', 'change_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
    execute format('grant select, insert, update, delete on %I to apis_app', t);
  end loop;
end $$;
revoke update, delete on calibration_records from apis_app;

-- Yeni izinler
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm
      from roles r
      join (values
        ('quality', 'quality.plan.manage'), ('quality', 'equipment.manage'), ('rd', 'quality.plan.manage'),
        ('rd', 'change.decide'), ('rd', 'change.create'), ('production', 'change.create'), ('technician', 'change.create'),
        ('quality', 'change.create'), ('production', 'production.plan'), ('manager', 'change.view'), ('rd', 'change.view'),
        ('production', 'change.view'), ('quality', 'change.view'), ('technician', 'change.view'), ('sales', 'sales.promise'),
        ('production', 'capacity.manage')
      ) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
