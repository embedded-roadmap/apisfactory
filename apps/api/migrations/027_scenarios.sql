-- W35: senaryo, maliyet/termin kıyası ve uygulama (prompt §22).
-- Gerçek operasyonu değiştirmez; baz planın kopyası üzerinde ne-olurdu hesabı yapar.
-- Kaynak veri zamanı, varsayımlar ve hesap sürümü saklanır (prompt: "kaynak veri zamanı,
-- varsayımlar ve hesap sürümü saklansın").

create table scenarios (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  product_revision_id uuid not null references product_revisions(id),
  qty numeric(18, 6) not null check (qty > 0),
  overrides jsonb not null default '{}'::jsonb,
  result jsonb not null,
  source_asof timestamptz not null default now(),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index scenarios_revision_idx on scenarios (company_id, product_revision_id, created_at desc);

alter table scenarios enable row level security;
alter table scenarios force row level security;
create policy tenant_isolation on scenarios using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on scenarios to apis_app;
