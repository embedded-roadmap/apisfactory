-- Oturum 41 (kalan işler 7b): maliyet motorunun üç eksiği (ana talimat §6, §18).
--  1) Kur: "Para birimi, kur kaynağı/tarihi … açık tut"; "kur/vergi etkisi muhasebe politikasıyla tanımlansın".
--  2) Bütçe: metrik sözlüğündeki "Bütçe sapması = gerçekleşen − onaylı baz bütçe" için onaylı baz bütçe kaydı.
--  3) İade tamiri ve hurda maliyeti: tamir işçiliği + kullanılan parça, hurdaya ayrılan iade, değişim ürünü.

-- 1) Kur tablosu: 1 birim `base_currency` = `rate` × `quote_currency`. Değişmez; düzeltme aynı tarih için yeni kayıtla
-- yapılır (aynı çift ve tarihte en son girilen geçerlidir). Kaynak zorunlu (ör. TCMB döviz alış, banka, elle).
create table exchange_rates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  base_currency char(3) not null,
  quote_currency char(3) not null,
  rate numeric(20, 10) not null check (rate > 0),
  rate_date date not null,
  source text not null,
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (base_currency <> quote_currency)
);
create trigger exchange_rates_append_only before update or delete on exchange_rates for each row execute function forbid_mutation();
create index exchange_rates_pair_idx on exchange_rates (company_id, base_currency, quote_currency, rate_date desc, created_at desc);

-- Politika: bir işlemin tarihine en fazla kaç gün eski kur kullanılabilir (hafta sonu/tatil için). Aşılırsa dönüştürülmez,
-- eksik olarak gösterilir.
alter table cost_policies add column fx_max_age_days int not null default 7 check (fx_max_age_days between 0 and 31);

alter table exchange_rates enable row level security;
alter table exchange_rates force row level security;
create policy tenant_isolation on exchange_rates using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on exchange_rates to apis_app;

-- 2) Ar-Ge projesi onaylı baz bütçe sürümleri. Proje açılırken verilen bütçe sürüm 1'dir; revizyon gerekçeyle yeni sürüm.
create table rd_project_budgets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  project_id uuid not null references rd_projects(id),
  version_no int not null,
  amount numeric(18, 2) not null check (amount >= 0),
  currency char(3) not null,
  reason text not null,
  approved_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (project_id, version_no)
);
create trigger rd_project_budgets_append_only before update or delete on rd_project_budgets for each row execute function forbid_mutation();

alter table rd_project_budgets enable row level security;
alter table rd_project_budgets force row level security;
create policy tenant_isolation on rd_project_budgets using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on rd_project_budgets to apis_app;

-- Mevcut bütçeli projeler: açılıştaki bütçe sürüm 1 olarak (RLS altında şirket şirket).
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into rd_project_budgets (company_id, project_id, version_no, amount, currency, reason, approved_by, created_at)
    select p.company_id, p.id, 1, p.budget_amount, p.currency, 'Proje açılış bütçesi (geçiş)', p.created_by, p.created_at
      from rd_projects p where p.company_id = c.id and p.budget_amount is not null;
  end loop;
end $$;

-- 3) İade tamir denemeleri: her deneme değişmez (işçilik saati, not, tekrar test sonucu). Kullanılan parçalar stok
-- hareketi olarak (`move_type = 'issue'`, `ref_type = 'rma_repair'`, `ref_id` = deneme) düşülür.
create table rma_repair_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  rma_id uuid not null references rmas(id),
  attempt_no int not null,
  labor_hours numeric(8, 2) not null default 0 check (labor_hours >= 0 and labor_hours <= 200),
  note text not null,
  retest_passed boolean not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (rma_id, attempt_no)
);
create trigger rma_repair_attempts_append_only before update or delete on rma_repair_attempts for each row execute function forbid_mutation();

alter table rma_repair_attempts enable row level security;
alter table rma_repair_attempts force row level security;
create policy tenant_isolation on rma_repair_attempts using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on rma_repair_attempts to apis_app;
