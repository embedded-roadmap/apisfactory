-- Oturum 41 (kalan işler 7d) — R12: AI ile pin uyumlu alternatif araştırması (ana talimat §11).
-- "Model, prompt, kaynak sürümü ve insan kararı loglansın." Her koşu ve aday sonucu değişmezdir; aday yalnız insan
-- kararıyla mevcut onay akışına (item_alternates, Ar-Ge + üretim onayı) öneri olarak girer.

create table alternate_research_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  item_id uuid not null references items(id),
  product_id uuid references products(id),
  category text not null,
  rules_version int not null,
  prompt_version text not null,
  model text not null,
  inputs jsonb not null,           -- belge metinleri yerine kimlik/başlık/uzunluk/sha256 özeti
  missing_inputs text[] not null default '{}',
  input_hash text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create trigger alternate_research_runs_append_only before update or delete on alternate_research_runs for each row execute function forbid_mutation();
create index alternate_research_runs_item_idx on alternate_research_runs (item_id, created_at desc);

create table alternate_research_candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  run_id uuid not null references alternate_research_runs(id),
  ref text not null,
  candidate_item_id uuid references items(id),
  mpn text,
  manufacturer text,
  name text not null,
  source text not null check (source in ('item_master', 'user_supplied')),
  verdict text not null check (verdict in ('candidate', 'insufficient_evidence', 'rejected_by_rules', 'research_only')),
  fields jsonb not null,
  pin_map jsonb not null,
  rule_findings jsonb not null,
  test_needs jsonb not null,
  design_changes jsonb not null,
  summary text,
  supply jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, ref)
);
create trigger alternate_research_candidates_append_only before update or delete on alternate_research_candidates for each row execute function forbid_mutation();

alter table item_alternates drop constraint item_alternates_origin_check;
alter table item_alternates add constraint item_alternates_origin_check check (origin in ('manual', 'rule_candidate', 'ai_research'));
alter table item_alternates add column research_candidate_id uuid references alternate_research_candidates(id);

do $$
declare t text;
begin
  foreach t in array array['alternate_research_runs', 'alternate_research_candidates'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert on alternate_research_runs, alternate_research_candidates to apis_app;
