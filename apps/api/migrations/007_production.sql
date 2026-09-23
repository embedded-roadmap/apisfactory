-- F2/F4 başlangıcı: iş emri, rota, malzeme çıkışı, cihaz seri ve test, son kalite, sevkiyat, kullanıcı yönetimi.

-- Yeni hareket tipleri
alter table stock_moves drop constraint stock_moves_move_type_check;
alter table stock_moves add constraint stock_moves_move_type_check check (move_type in (
  'receive', 'inspect_accept', 'inspect_reject', 'opening', 'adjust_in', 'adjust_out', 'issue', 'transfer', 'return', 'scrap',
  'consume', 'produce', 'ship'));

create table work_centers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  kind text not null check (kind in ('prep', 'smt', 'manual', 'programming', 'test', 'assembly', 'packing')),
  unique (company_id, code)
);

-- İş emri: yayımlanmış ürün sürümünü ve BOM sürümünü sabitler (prompt §4). Yeni revizyon açık işi değiştirmez (T06).
create table work_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  production_need_id uuid references production_needs(id),
  product_revision_id uuid not null references product_revisions(id),
  bom_version_id uuid not null references bom_versions(id),
  qty numeric(18, 6) not null check (qty > 0 and qty = trunc(qty)),
  status text not null default 'planned'
    check (status in ('planned', 'released', 'in_progress', 'on_hold', 'completed', 'cancelled')),
  due_date date,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  completed_at timestamptz,
  unique (company_id, code),
  unique (production_need_id)
);

-- Operasyonlar yayımda iş emrine kopyalanır (rota sürümü sabitlenir).
create table work_order_operations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  work_order_id uuid not null references work_orders(id),
  seq int not null,
  name text not null,
  work_center_id uuid references work_centers(id),
  is_quality_gate boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'paused', 'done')),
  started_at timestamptz,
  finished_at timestamptz,
  worked_seconds int not null default 0,
  last_started_at timestamptz,
  unique (work_order_id, seq)
);

-- Cihaz seri numarası: test ve izlenebilirlik birimi.
create table devices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  serial text not null,
  work_order_id uuid not null references work_orders(id),
  product_revision_id uuid not null references product_revisions(id),
  status text not null default 'in_process'
    check (status in ('in_process', 'test_failed', 'rework', 'passed', 'scrapped', 'released', 'shipped')),
  finished_lot_id uuid references lots(id),
  created_at timestamptz not null default now(),
  unique (company_id, serial)
);

-- Test çalışmaları: ilk başarısız test silinmez, tekrar test ilk test başarısını değiştirmez (T09).
create table test_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  device_id uuid not null references devices(id),
  run_no int not null,
  external_run_id text, -- istasyonun tekil test çalışma kimliği (tekrarları ayıklamak için)
  result text not null check (result in ('pass', 'fail')),
  measurements jsonb not null default '[]',
  station text,
  firmware_version text,
  operator_id uuid references users(id),
  created_at timestamptz not null default now(),
  unique (device_id, run_no),
  unique (company_id, external_run_id)
);
create trigger test_runs_append_only before update or delete on test_runs for each row execute function forbid_mutation();

-- Başarısız cihaz için kalite kararı: yeniden işleme veya hurda.
create table nonconformances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  device_id uuid not null references devices(id),
  test_run_id uuid references test_runs(id),
  decision text check (decision in ('rework', 'scrap')),
  note text,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- İş emrine malzeme çıkışı (hareket defterindeki issue kaydının iş özeti).
create table material_issues (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  work_order_id uuid not null references work_orders(id),
  item_id uuid not null references items(id),
  lot_id uuid not null references lots(id),
  qty numeric(18, 6) not null check (qty > 0),
  issued_by uuid references users(id),
  issued_at timestamptz not null default now()
);

create table shipments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  sales_order_id uuid not null references sales_orders(id),
  sales_order_line_id uuid not null references sales_order_lines(id),
  qty numeric(18, 6) not null check (qty > 0),
  document_mode text not null default 'draft' check (document_mode in ('draft', 'test', 'official')),
  shipped_by uuid references users(id),
  shipped_at timestamptz not null default now(),
  unique (company_id, code)
);

-- Sipariş iptali için durum ve gerekçe
alter table sales_orders add column cancel_reason text;
alter table sales_orders add column cancelled_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['work_centers', 'work_orders', 'work_order_operations', 'devices', 'test_runs', 'nonconformances', 'material_issues', 'shipments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
    execute format('grant select, insert, update, delete on %I to apis_app', t);
  end loop;
end $$;
revoke update, delete on test_runs from apis_app;

-- Kullanıcı yönetimi: uygulama rolü users tablosuna doğrudan yazamaz; dar kapsamlı fonksiyonlar kullanılır.
create or replace function admin_ensure_user(p_email text, p_name text, p_hash text, out user_id uuid, out created boolean)
language plpgsql security definer set search_path = public as $$
begin
  select id into user_id from users where lower(email) = lower(p_email);
  created := user_id is null;
  if created then
    insert into users (email, name, password_hash) values (lower(p_email), p_name, p_hash) returning id into user_id;
  end if;
end $$;

-- Parola yalnızca oturumdaki kullanıcının kendisi için değiştirilebilir.
create or replace function auth_set_password(p_hash text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_user_id() is null then raise exception 'unauthenticated' using errcode = 'P0001'; end if;
  update users set password_hash = p_hash, updated_at = now() where id = app_user_id();
  update sessions set revoked_at = now() where user_id = app_user_id() and revoked_at is null
    and id <> nullif(current_setting('app.session_id', true), '')::uuid;
end $$;

create or replace function auth_password_hash() returns text
language sql security definer set search_path = public stable as $$
  select password_hash from users where id = app_user_id()
$$;

grant execute on function admin_ensure_user(text, text, text), auth_set_password(text), auth_password_hash() to apis_app;

-- Yeni izinler mevcut şirketlerin rol şablonlarına eklenir.
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm
      from roles r
      join (values
        ('production', 'production.view'), ('production', 'production.plan'), ('production', 'production.execute'),
        ('technician', 'production.view'), ('technician', 'production.execute'), ('technician', 'production.test.record'),
        ('quality', 'production.view'), ('quality', 'production.test.record'), ('quality', 'quality.final.release'),
        ('warehouse', 'production.view'), ('warehouse', 'inventory.issue'), ('warehouse', 'shipment.create'),
        ('manager', 'production.view'), ('sales', 'shipment.view'), ('warehouse', 'shipment.view'), ('manager', 'shipment.view'),
        ('sales', 'sales.cancel')
      ) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
    insert into work_centers (company_id, code, name, kind) values
      (c.id, 'HAZ', 'Malzeme hazırlama', 'prep'),
      (c.id, 'SMT', 'Dizgi hattı', 'smt'),
      (c.id, 'LEH', 'Lehim / THT', 'manual'),
      (c.id, 'PRG', 'Programlama', 'programming'),
      (c.id, 'TST', 'Fonksiyon testi', 'test'),
      (c.id, 'MON', 'Mekanik montaj', 'assembly')
    on conflict do nothing;
  end loop;
end $$;
