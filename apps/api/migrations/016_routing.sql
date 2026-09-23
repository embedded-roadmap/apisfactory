-- Oturum 10 (W20): revizyon bazında sürümlü rota ve standart süre. Yayımlanan rota değişmez;
-- iş emri açıldığı andaki rotayı ve standart süreleri kopyalar (sonraki sürüm açık işi değiştirmez).

create table routings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  product_revision_id uuid not null references product_revisions(id),
  version_no int not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  published_by uuid references users(id),
  published_at timestamptz,
  unique (product_revision_id, version_no)
);
create unique index routings_one_draft on routings (product_revision_id) where status = 'draft';

create table routing_operations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  routing_id uuid not null references routings(id),
  seq int not null check (seq > 0),
  name text not null,
  work_center_id uuid not null references work_centers(id),
  setup_minutes numeric(10, 3) not null default 0 check (setup_minutes >= 0),
  minutes_per_unit numeric(10, 3) not null default 0 check (minutes_per_unit >= 0),
  is_quality_gate boolean not null default false,
  instructions text,
  unique (routing_id, seq)
);

create or replace function guard_published_routing() returns trigger
language plpgsql as $$
declare st text;
begin
  select status into st from routings where id = coalesce(new.routing_id, old.routing_id);
  if st <> 'draft' then
    raise exception 'routing_published: yayımlanmış rota değiştirilemez; yeni sürüm açın' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger routing_operations_guard before insert or update or delete on routing_operations for each row execute function guard_published_routing();

-- İş emri rotayı ve planlanan standart süreleri sabitler
alter table work_orders add column routing_id uuid references routings(id);
alter table work_order_operations add column planned_setup_minutes numeric(10, 3);
alter table work_order_operations add column planned_minutes_per_unit numeric(10, 3);
alter table work_order_operations add column instructions text;

do $$
declare t text;
begin
  foreach t in array array['routings', 'routing_operations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update, delete on routings, routing_operations to apis_app;

-- Mevcut iş emri operasyonlarına o anki iş merkezi standart süreleri yazılır (geçmiş iş için en iyi bilinen değer).
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    update work_order_operations o set planned_setup_minutes = wc.setup_minutes, planned_minutes_per_unit = wc.minutes_per_unit
      from work_centers wc where wc.id = o.work_center_id and o.planned_setup_minutes is null;
  end loop;
end $$;
