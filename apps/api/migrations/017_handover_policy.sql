-- Oturum 11: devir (handover) politikası — şirket ayarı olarak test planı, firmware, firmware özeti ve
-- yayımlanmış rota zorunluluğu. Sürümlü ve değişmez; revizyon bazında gerekçeli muafiyet; yayımda kontrol listesi saklanır.

create table handover_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  version_no int not null,
  require_test_plan boolean not null default false,
  require_firmware boolean not null default false,
  require_firmware_sha boolean not null default false,
  require_routing boolean not null default false,
  note text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, version_no),
  check (not require_firmware_sha or require_firmware)
);
create trigger handover_policies_append_only before update or delete on handover_policies for each row execute function forbid_mutation();

create table handover_waivers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  revision_id uuid not null references product_revisions(id),
  requirement text not null check (requirement in ('test_plan', 'firmware', 'firmware_sha', 'routing')),
  reason text not null,
  granted_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (revision_id, requirement)
);
create trigger handover_waivers_append_only before update or delete on handover_waivers for each row execute function forbid_mutation();

-- Yayım anındaki kontrol listesi (hangi politika sürümüyle, neler sağlandı / muaf tutuldu)
alter table product_revisions add column handover_checklist jsonb;

do $$
declare t text;
begin
  foreach t in array array['handover_policies', 'handover_waivers'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert on handover_policies, handover_waivers to apis_app;
