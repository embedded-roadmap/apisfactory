-- R05: Devirde Ar-Ge maliyetinin hesaplanması (ana talimat §8).
-- "Devirde Ar-Ge maliyeti raporlansın: prototip malzemesi, PCB/dizgi, mühendislik zamanı, dış hizmet, test ve diğer
--  tanımlı giderler. Gelmemiş faturalar varsa rapor geçici olsun; yeni giderler tarihçeli düzeltmeyle işlensin. Ar-Ge
--  payının ürün maliyetine aktarımında aynı gideri iki kez sayma."
--
-- Kaynaklar: (1) projeye bağlı satın alma talebi → sipariş satırı → tedarikçi faturası satırı (faturalanmış = gerçek,
-- teslim alınmış ama faturalanmamış = tahakkuk, geçici), (2) muhasebenin elle bölüştürdüğü giderler (R04), (3) yeni:
-- mühendislik zaman kaydı × tarihinde geçerli Ar-Ge saat ücreti. Para birimleri dönüştürülmez (mevcut desen).

-- Revizyonun hangi Ar-Ge projesinin ürünü olduğu. Devir onayında bu bağ varsa maliyet raporu oluşur.
alter table product_revisions add column rd_project_id uuid references rd_projects(id);
create index product_revisions_rd_project_idx on product_revisions (rd_project_id) where rd_project_id is not null;

-- Gider kategorisi. Talep tarafında yalnız projeye bağlı talepler için anlamlı; boşsa prototip malzemesi sayılır.
alter table purchase_requests add column rd_cost_category text
  check (rd_cost_category in ('prototype_material', 'pcb_assembly', 'external_service', 'test', 'other'));
alter table project_cost_allocations add column category text not null default 'other'
  check (category in ('prototype_material', 'pcb_assembly', 'external_service', 'test', 'other'));

-- Ar-Ge mühendislik saat ücreti: sürümlü, değişmez. Bir zaman kaydı, çalışma tarihinde geçerli olan (effective_from
-- <= work_date olan en yeni) ücretle fiyatlanır; ücret sonradan değişse de geçmiş tarihli kayıt eski ücreti kullanır.
create table rd_labor_rates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  version_no int not null,
  rate_per_hour numeric(18, 4) not null check (rate_per_hour >= 0),
  currency char(3) not null,
  effective_from date not null,
  note text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, version_no),
  unique (company_id, effective_from)
);
create trigger rd_labor_rates_append_only before update or delete on rd_labor_rates for each row execute function forbid_mutation();

-- Mühendislik zaman kaydı: değişmez. Düzeltme = asıl kaydı ters çeviren (negatif saatli) kayıt + gerekirse doğru
-- yeni kayıt. Bir kayıt yalnız bir kez ters çevrilebilir; ters kayıt ters çevrilemez.
create table rd_time_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  project_id uuid not null references rd_projects(id),
  user_id uuid not null references users(id),
  work_date date not null,
  hours numeric(6, 2) not null check (hours <> 0 and abs(hours) <= 24),
  activity text not null check (activity in ('design', 'layout', 'firmware', 'prototype', 'test', 'documentation', 'other')),
  note text,
  reverses_entry_id uuid unique references rd_time_entries(id),
  reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check ((hours < 0) = (reverses_entry_id is not null)),
  check (reverses_entry_id is null or reason is not null)
);
create trigger rd_time_entries_append_only before update or delete on rd_time_entries for each row execute function forbid_mutation();
create index rd_time_entries_project_idx on rd_time_entries (project_id, work_date);

-- Devir maliyet raporu: sürümlü, değişmez anlık görüntü. Sürüm 1 devir onayında otomatik; sonraki sürümler yeni
-- gider/fatura geldikçe gerekçeli yeniden hesaplamayla (tarihçeli düzeltme). Önceki sürüm silinmez.
create table rd_cost_reports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  revision_id uuid not null references product_revisions(id),
  project_id uuid not null references rd_projects(id),
  version_no int not null,
  status text not null check (status in ('provisional', 'final')),
  trigger text not null check (trigger in ('handover', 'recalculation')),
  report jsonb not null,
  reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (revision_id, version_no),
  check (trigger = 'handover' or reason is not null)
);
create trigger rd_cost_reports_append_only before update or delete on rd_cost_reports for each row execute function forbid_mutation();

alter table rd_labor_rates enable row level security;
alter table rd_labor_rates force row level security;
create policy tenant_isolation on rd_labor_rates using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on rd_labor_rates to apis_app;

alter table rd_time_entries enable row level security;
alter table rd_time_entries force row level security;
create policy tenant_isolation on rd_time_entries using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on rd_time_entries to apis_app;

alter table rd_cost_reports enable row level security;
alter table rd_cost_reports force row level security;
create policy tenant_isolation on rd_cost_reports using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on rd_cost_reports to apis_app;
