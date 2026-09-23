-- Oturum 8 (W10): onay politikaları (kendi talebini onaylama, parasal limit, zaman aşımı ve üst sorumluya yükseltme),
-- süreli ve kapsamlı vekâlet, vekâleten yapılan işlemin olay kaydı, elle müdahale ve çıkış kutusu uzlaştırma (prompt §5, §7).

-- ---------------------------------------------------------------------------
-- Onay politikası: tür başına sürümlü, değişmez. Güncel = en yüksek sürüm. Limitler sürüme bağlıdır.
-- ---------------------------------------------------------------------------
create table approval_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  kind text not null check (kind in ('purchase_request', 'change_request', 'rma_decision', 'incoming_inspection', 'device_disposition')),
  version_no int not null,
  allow_self_approval boolean not null default false,
  timeout_hours int check (timeout_hours is null or timeout_hours between 1 and 2160),
  escalate_to_role text,
  note text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, kind, version_no)
);
create trigger approval_policies_append_only before update or delete on approval_policies for each row execute function forbid_mutation();

create table approval_limits (
  company_id uuid not null references companies(id),
  policy_id uuid not null references approval_policies(id),
  role_code text not null,
  max_amount numeric(18, 2), -- null: sınırsız
  currency char(3) not null,
  primary key (policy_id, role_code)
);
create trigger approval_limits_append_only before update or delete on approval_limits for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------
-- Vekâlet: yalnızca vekâlet verenin sahip olduğu onay izinleri, süreli. İptal edilir, silinmez.
-- ---------------------------------------------------------------------------
create table delegations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  delegator_user_id uuid not null references users(id),
  delegate_user_id uuid not null references users(id),
  permissions text[] not null check (cardinality(permissions) > 0),
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  reason text not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references users(id),
  check (delegator_user_id <> delegate_user_id),
  check (valid_to > valid_from)
);
create index delegations_active on delegations (company_id, delegate_user_id) where revoked_at is null;

-- Vekâleten yapılan işlem kimin adına yapıldığını taşır.
alter table events add column on_behalf_of uuid references users(id);

-- Görev süresi ve yükseltme
alter table tasks add column escalated_at timestamptz;
alter table tasks add column escalation_level int not null default 0;

-- Elle açılan satın alma talebi: talep eden, gerekçe ve tahmini tutar (son lot maliyetinden)
alter table purchase_requests add column requested_by uuid references users(id);
alter table purchase_requests add column note text;
alter table purchase_requests add column estimated_amount numeric(18, 2);
alter table purchase_requests add column currency char(3);
alter table purchase_requests add column amount_source text;
alter table purchase_requests drop constraint purchase_requests_company_id_source_type_source_id_item_id_key;
create unique index purchase_requests_source_unique on purchase_requests (company_id, source_type, source_id, item_id) where source_type <> 'manual';

-- Çıkış kutusu: elle uzlaştırma notu
alter table outbox add column resolved_by uuid references users(id);
alter table outbox add column resolution_note text;

do $$
declare t text;
begin
  foreach t in array array['approval_policies', 'approval_limits', 'delegations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert on approval_policies, approval_limits to apis_app;
grant select, insert, update on delegations to apis_app;
grant select, update on outbox to apis_app;

do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm
      from roles r
      join (values
        ('manager', 'workflow.manage'), ('manager', 'delegation.manage'), ('admin', 'delegation.manage'),
        ('rd', 'purchase.request.create'), ('production', 'purchase.request.create'), ('purchasing', 'purchase.request.create'), ('quality', 'purchase.request.create'),
        ('manager', 'purchase.request.approve'), ('manager', 'purchase.view')
      ) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
