-- Oturum 17 (W29): onaylı alternatif parça. Öneri (elle veya kural tabanlı aday) → kanıt → Ar-Ge ve üretim teknik onayı.
-- Onaylı alternatif, iş emrinde birincil parçanın yerine çıkılabilir (izlenebilir: hangi BOM kalemi yerine kullanıldığı).

create table item_alternates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  item_id uuid not null references items(id),
  alternate_item_id uuid not null references items(id),
  product_id uuid references products(id), -- null: tüm ürünlerde geçerli
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'revoked')),
  origin text not null default 'manual' check (origin in ('manual', 'rule_candidate')),
  reason text not null,
  pin_compatible boolean,
  footprint_same boolean,
  electrical_equivalent boolean,
  evidence text,
  proposed_by uuid references users(id),
  proposed_at timestamptz not null default now(),
  decided_at timestamptz,
  revoked_by uuid references users(id),
  revoked_at timestamptz,
  revoke_reason text,
  check (item_id <> alternate_item_id)
);
create unique index item_alternates_live on item_alternates (company_id, item_id, alternate_item_id, coalesce(product_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('proposed', 'approved');

create table alternate_approvals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  alternate_id uuid not null references item_alternates(id),
  area text not null check (area in ('rd', 'production')),
  decision text not null check (decision in ('approve', 'reject')),
  note text,
  decided_by uuid not null references users(id),
  decided_at timestamptz not null default now(),
  unique (alternate_id, area)
);
create trigger alternate_approvals_append_only before update or delete on alternate_approvals for each row execute function forbid_mutation();

alter table material_issues add column for_item_id uuid references items(id);
alter table material_issues add column alternate_id uuid references item_alternates(id);

do $$
declare t text;
begin
  foreach t in array array['item_alternates', 'alternate_approvals'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on item_alternates to apis_app;
grant select, insert on alternate_approvals to apis_app;
