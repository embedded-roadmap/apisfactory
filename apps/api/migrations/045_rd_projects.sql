-- R04: Ar-Ge malzeme talebinin proje ve muhasebeyle bağlantısı (ana talimat §3).
-- "Ar-Ge malzeme talebinde proje, MPN veya tanımlı genel ihtiyaç, miktar, gerekçe, ihtiyaç tarihi
--  ve maliyet merkezi bulunsun. Önce mevcut stoktan karşılama değerlendirilsin, kalan satın almaya
--  aktarılsın. Muhasebe her giderin hangi projeye ait olduğunu görebilsin. Ortak alım ve giderler
--  paylaştırılsın."
--
-- "MPN veya tanımlı genel ihtiyaç": mevcut items tablosunda mpn/manufacturer zaten opsiyonel —
-- MPN'siz "genel ihtiyaç" kalemi mevcut POST /api/items ile zaten oluşturulabiliyor, yeni bir
-- şema alanı gerekmiyor. "Önce stoktan karşılama": mevcut manuel satın alma talebi ucu (POST
-- /api/purchase-requests) bugüne kadar hiç stok kontrolü yapmıyordu — bu migration'ın eklediği
-- proje/maliyet merkezi alanlarıyla birlikte, ilgili route (workflow.ts) artık serbest stoğu
-- düşüp yalnızca kalanı satın almaya yönlendirecek şekilde güncellendi (bkz. kod değişikliği).

create table rd_projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  cost_center text,
  -- Bütçe opsiyonel; verildiyse para birimi de verilmeli (ikisi birlikte var/yok).
  budget_amount numeric(18, 2),
  currency char(3),
  status text not null default 'open' check (status in ('open', 'closed')),
  owner_user_id uuid references users(id),
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references users(id),
  closed_reason text,
  unique (company_id, code),
  check ((budget_amount is null) = (currency is null))
);

-- Malzeme talebinin hangi projeye ve maliyet merkezine ait olduğu (yeni, opsiyonel — mevcut
-- production_need/change_request kaynaklı talepler etkilenmez, yalnızca elle açılan talepler
-- proje seçebilir).
alter table purchase_requests add column project_id uuid references rd_projects(id);
alter table purchase_requests add column cost_center text;

-- Ortak alım/gider paylaştırma: birden çok projeye yayılan bir gideri (ör. ortak sarf malzeme,
-- paylaşılan kargo) muhasebenin gerekçeyle elle bölüştürdüğü, değişmez bir defter. Otomatik/
-- tahmini bölüştürme YAPILMAZ — her satır insan kararıdır ve gerekçe zorunludur.
create table project_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  project_id uuid not null references rd_projects(id),
  amount numeric(18, 2) not null check (amount > 0),
  currency char(3) not null,
  description text not null,
  source_ref text,
  reason text not null,
  allocated_by uuid references users(id),
  allocated_at timestamptz not null default now()
);
create trigger project_cost_allocations_append_only before update or delete on project_cost_allocations for each row execute function forbid_mutation();

create index rd_projects_status_idx on rd_projects (company_id, status);
create index purchase_requests_project_idx on purchase_requests (project_id) where project_id is not null;
create index project_cost_allocations_project_idx on project_cost_allocations (project_id);

alter table rd_projects enable row level security;
alter table rd_projects force row level security;
create policy tenant_isolation on rd_projects using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert, update on rd_projects to apis_app;

alter table project_cost_allocations enable row level security;
alter table project_cost_allocations force row level security;
create policy tenant_isolation on project_cost_allocations using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on project_cost_allocations to apis_app;

-- Yeni izinler: proje oluşturma/kapatma (Ar-Ge + yönetici), proje ve harcama görünümü
-- (Ar-Ge + yönetici + muhasebe — "muhasebe her giderin hangi projeye ait olduğunu görebilsin").
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm from roles r
      join (values ('rd', 'rd.project.manage'), ('rd', 'rd.project.view'),
                   ('manager', 'rd.project.manage'), ('manager', 'rd.project.view'),
                   ('accounting', 'rd.project.view')) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
