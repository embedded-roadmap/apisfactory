-- Oturum 6 (W25): lot maliyeti, sürümlü maliyet politikası, deterministik ve sürümlü maliyet hesapları (prompt §18).
-- Kural: geçmiş tüketim maliyetinin üzerine yazılmaz; her değişiklik yeni kayıt/yeni hesap sürümüdür.

-- ---------------------------------------------------------------------------
-- Lot birim maliyeti: değişmez kayıt defteri. Güncel değer = en son kayıt. Geç gelen fatura yeni kayıt ekler.
-- ---------------------------------------------------------------------------
create table lot_costs (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies(id),
  lot_id uuid not null references lots(id),
  unit_cost numeric(18, 6) not null check (unit_cost >= 0),
  currency char(3) not null,
  source text not null check (source in ('receipt', 'invoice', 'opening', 'manual', 'production')),
  reference text,
  recorded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index lot_costs_lot on lot_costs (lot_id, id desc);
create trigger lot_costs_append_only before update or delete on lot_costs for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------
-- Maliyet politikası (muhasebe): sürümlü, geçerlilik tarihli, değişmez.
-- ---------------------------------------------------------------------------
create table cost_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  version_no int not null,
  valid_from date not null,
  currency char(3) not null,
  labor_rate_per_hour numeric(18, 4) not null check (labor_rate_per_hour >= 0),
  overhead_per_labor_hour numeric(18, 4) not null default 0 check (overhead_per_labor_hour >= 0),
  overhead_pct_of_material numeric(9, 4) not null default 0 check (overhead_pct_of_material >= 0 and overhead_pct_of_material <= 1000),
  valuation text not null default 'lot_actual' check (valuation in ('lot_actual')),
  scrap_treatment text not null default 'absorb_into_good' check (scrap_treatment in ('absorb_into_good')),
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, version_no)
);
create trigger cost_policies_append_only before update or delete on cost_policies for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------
-- Maliyet hesabı sürümleri. Aynı girdiler aynı parmak izini verir; yalnızca değişiklikte yeni sürüm açılır.
-- ---------------------------------------------------------------------------
create table cost_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  scope text not null check (scope in ('work_order')),
  ref_id uuid not null,
  version_no int not null,
  policy_id uuid references cost_policies(id),
  fingerprint text not null,
  complete boolean not null,
  result jsonb not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, scope, ref_id, version_no)
);
create trigger cost_runs_append_only before update or delete on cost_runs for each row execute function forbid_mutation();

do $$
declare t text;
begin
  foreach t in array array['lot_costs', 'cost_policies', 'cost_runs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
    execute format('grant select, insert on %I to apis_app', t);
  end loop;
end $$;

do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm
      from roles r
      join (values
        ('accounting', 'cost.manage'), ('manager', 'cost.manage'), ('accounting', 'lot.cost.record'), ('purchasing', 'lot.cost.record'),
        ('manager', 'report.view'), ('accounting', 'report.view'), ('production', 'report.view'), ('quality', 'report.view'), ('sales', 'report.view')
      ) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
