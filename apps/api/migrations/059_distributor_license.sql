-- Oturum 41 devamı — W03 açık engeli: distribütör lisans teyidi olmadan canlı mod açılmasın (ana talimat §27:
-- "İzin çıkmayan özelliği canlı açma; etkisini açık engel olarak kaydet"). Bkz. docs/w03-distributor-erisim-matrisi.md.
-- Teyit değişmez ve sürümlüdür: sekiz iznin her biri allowed / denied / unknown, belge referansı zorunlu.

create table distributor_license_confirmations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  connector_id uuid not null references distributor_connectors(id),
  version_no int not null,
  permissions jsonb not null,
  cache_max_minutes int check (cache_max_minutes is null or cache_max_minutes >= 5),
  document_ref text not null,
  note text,
  confirmed_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (connector_id, version_no)
);
create trigger distributor_license_confirmations_append_only before update or delete on distributor_license_confirmations for each row execute function forbid_mutation();

alter table distributor_license_confirmations enable row level security;
alter table distributor_license_confirmations force row level security;
create policy tenant_isolation on distributor_license_confirmations using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on distributor_license_confirmations to apis_app;

-- Bağlayıcının geçerli teyidi; canlı mod teyitsiz olamaz (veri tabanı düzeyinde de).
alter table distributor_connectors add column license_confirmation_id uuid references distributor_license_confirmations(id);
-- Mevcut 'live' satırı olamaz: canlı mod adaptör ister ve adaptör kaydı (lib/distributor-providers.ts) boştur; olsaydı
-- aşağıdaki kısıt eklenirken migration açıkça hata verirdi (sessizce kapatılmaz).
alter table distributor_connectors add constraint distributor_connectors_live_licensed check (mode <> 'live' or license_confirmation_id is not null);
