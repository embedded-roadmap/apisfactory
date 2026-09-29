-- Oturum 41 devamı — R16/R17/R18: giriş, ara, son ürün ve paketleme kontrol listeleri (ana talimat §15, §16).
-- "Giriş, ara, son ürün ve paketleme kontrol planları oluştur … Eksik zorunlu ölçüm … varken tam kapanış verilmesin …
--  İlk başarısız test silinmesin … Operatör kendi test limitini değiştiremesin."
-- Plan: sürümlü ve değişmez (her değişiklik yeni sürüm; güncel = kodun en yüksek sürümü, active=false ise devre dışı).
-- Kayıt: değişmez; yeniden kontrol yeni kayıttır, başarısız kayıt kalır. Karar (geçti/kaldı) sunucuda verilir.

create table check_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  version_no int not null,
  name text not null,
  stage text not null check (stage in ('incoming', 'in_process', 'final', 'packing')),
  product_revision_id uuid references product_revisions(id),
  work_center_id uuid references work_centers(id),
  item_id uuid references items(id),
  items jsonb not null,
  active boolean not null default true,
  note text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, code, version_no),
  check (stage = 'incoming' or item_id is null),
  check (stage in ('in_process', 'packing') or work_center_id is null)
);
create trigger check_plans_append_only before update or delete on check_plans for each row execute function forbid_mutation();

create table check_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  plan_id uuid not null references check_plans(id),
  context_type text not null check (context_type in ('operation', 'receipt_line', 'work_order')),
  context_id uuid not null,
  results jsonb not null,
  passed boolean not null,
  findings jsonb not null,
  recorded_by uuid references users(id),
  recorded_at timestamptz not null default now()
);
create trigger check_records_append_only before update or delete on check_records for each row execute function forbid_mutation();
create index check_records_context_idx on check_records (context_type, context_id, plan_id, recorded_at desc);

do $$
declare t text;
begin
  foreach t in array array['check_plans', 'check_records'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert on check_plans, check_records to apis_app;
