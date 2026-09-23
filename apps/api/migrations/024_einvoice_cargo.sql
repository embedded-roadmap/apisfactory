-- Oturum 18 (W36): e-fatura/e-arşiv ve kargo bağlayıcıları.
-- GERÇEK ENTEGRASYON YOK: resmi e-belge gönderimi bir GİB özel entegratör sözleşmesi ve test/canlı ortam onayı gerektirir;
-- kargo firması entegrasyonu da ayrı bir ticari sözleşme gerektirir. İkisi de yazılım kararı değil, şirketin sağlayıcı
-- seçimidir (prompt §31/32) — bu yüzden yalnız TEST modu vardır: sentetik ETTN / takip no üretir, her yerde
-- "TEST — resmiyeti yok" ile işaretlenir, hiçbir dış sisteme gönderilmez. Aşağıdaki anahtarlar yaygın seçenekler
-- olarak taslak listelenmiştir; şirket gerçek sağlayıcısını seçtiğinde bağlanacaktır.

create table einvoice_connectors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  key text not null check (key in ('gib_portal', 'uyumsoft', 'foriba', 'logo', 'parasut', 'nesbilgi')),
  name text not null,
  mode text not null default 'not_connected' check (mode in ('not_connected', 'test')),
  note text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  unique (company_id, key)
);

create table cargo_connectors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  key text not null check (key in ('yurtici', 'aras', 'mng', 'ptt', 'surat', 'ups')),
  name text not null,
  mode text not null default 'not_connected' check (mode in ('not_connected', 'test')),
  note text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  unique (company_id, key)
);

-- Sentetik e-belge gönderim izi (resmi değildir; GİB'e iletilmez)
alter table customer_invoices add column einvoice_connector_id uuid references einvoice_connectors(id);
alter table customer_invoices add column einvoice_kind text check (einvoice_kind in ('e_fatura', 'e_arsiv'));
alter table customer_invoices add column einvoice_ettn text;
alter table customer_invoices add column einvoice_sent_by uuid references users(id);
alter table customer_invoices add column einvoice_sent_at timestamptz;
alter table customer_invoices drop constraint customer_invoices_document_mode_check;
alter table customer_invoices add constraint customer_invoices_document_mode_check check (document_mode in ('draft', 'test'));

-- Sentetik kargo etiketi / takip no (resmi değildir; kargo firmasına iletilmez)
alter table shipments add column cargo_connector_id uuid references cargo_connectors(id);
alter table shipments add column label_ref text;

-- Gönderim kaydı (değişmez): e-belge veya kargo etiketi üretimi
create table document_dispatches (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies(id),
  kind text not null check (kind in ('einvoice', 'cargo_label')),
  connector_id uuid not null,
  entity_type text not null,
  entity_id uuid not null,
  ref text,
  dispatched_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index document_dispatches_entity on document_dispatches (entity_type, entity_id);
create trigger document_dispatches_append_only before update or delete on document_dispatches for each row execute function forbid_mutation();

do $$
declare t text;
begin
  foreach t in array array['einvoice_connectors', 'cargo_connectors', 'document_dispatches'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on einvoice_connectors, cargo_connectors to apis_app;
grant select, insert on document_dispatches to apis_app;

do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into einvoice_connectors (company_id, key, name) values
      (c.id, 'gib_portal', 'GİB e-Belge Portalı'), (c.id, 'uyumsoft', 'Uyumsoft'), (c.id, 'foriba', 'Foriba'),
      (c.id, 'logo', 'Logo e-Fatura'), (c.id, 'parasut', 'Paraşüt'), (c.id, 'nesbilgi', 'Nesbilgi')
    on conflict do nothing;
    insert into cargo_connectors (company_id, key, name) values
      (c.id, 'yurtici', 'Yurtiçi Kargo'), (c.id, 'aras', 'Aras Kargo'), (c.id, 'mng', 'MNG Kargo'),
      (c.id, 'ptt', 'PTT Kargo'), (c.id, 'surat', 'Sürat Kargo'), (c.id, 'ups', 'UPS')
    on conflict do nothing;
  end loop;
end $$;
