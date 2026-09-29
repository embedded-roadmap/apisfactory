-- Oturum 41 devamı — Ar-Ge payının ürün maliyetine aktarımı (ana talimat §8 "Ar-Ge payının ürün maliyetine aktarımında aynı
-- gideri iki kez sayma", §18 "Ar-Ge payı … muhasebe politikasıyla tanımlansın").
-- Plan: devir maliyet raporunun (rd_cost_reports) toplamı ÷ planlanan adet = birim pay. İş emri maliyeti, politika izin
-- veriyorsa sağlam adet × birim payı ekler; aynı revizyonun diğer iş emirlerinin son hesaplarında aktarılan pay düşülür,
-- toplam aktarım plan tutarını aşamaz.

alter table cost_policies add column include_rd_share boolean not null default false;

create table rd_amortization_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  revision_id uuid not null references product_revisions(id),
  version_no int not null,
  report_id uuid not null references rd_cost_reports(id),
  amount numeric(18, 2) not null check (amount >= 0),
  currency char(3) not null,
  planned_units int not null check (planned_units > 0),
  basis jsonb not null,            -- raporun para birimi toplamları ve kullanılan kurlar
  reason text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (revision_id, version_no)
);
create trigger rd_amortization_plans_append_only before update or delete on rd_amortization_plans for each row execute function forbid_mutation();

alter table rd_amortization_plans enable row level security;
alter table rd_amortization_plans force row level security;
create policy tenant_isolation on rd_amortization_plans using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on rd_amortization_plans to apis_app;
