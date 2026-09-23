-- Oturum 5 (W34): müşteri iadesi, garanti ve saha arızası (prompt §17 son paragraf, §22).
-- İade malı otomatik sağlam stoğa girmez: iade kabul alanına (kullanılamaz) alınır, kalite kararıyla yönlenir.

alter table locations drop constraint locations_type_check;
alter table locations add constraint locations_type_check
  check (type in ('stock', 'incoming_inspection', 'quarantine', 'production', 'subcontractor', 'finished', 'returns'));

alter table devices drop constraint devices_status_check;
alter table devices add constraint devices_status_check
  check (status in ('in_process', 'test_failed', 'rework', 'passed', 'scrapped', 'released', 'shipped', 'returned', 'in_repair', 'quarantined'));

alter table products add column warranty_months int not null default 24 check (warranty_months between 0 and 240);

-- Mevcut şirketlere iade kabul konumu (RLS zorunlu olduğundan şirket bağlamı her şirket için ayarlanır)
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into locations (company_id, site_id, code, name, type)
    select c.id, (select s.id from sites s where s.company_id = c.id order by s.code limit 1), 'IAD', 'İade kabul alanı', 'returns'
     where not exists (select 1 from locations l where l.company_id = c.id and l.type = 'returns');
  end loop;
end $$;

create table rmas (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  customer_id uuid not null references customers(id),
  kind text not null check (kind in ('return', 'warranty', 'field_failure')),
  device_id uuid references devices(id),
  lot_id uuid not null references lots(id),
  item_id uuid not null references items(id),
  qty numeric(18, 6) not null check (qty > 0),
  shipment_id uuid references shipments(id),
  sales_order_id uuid references sales_orders(id),
  complaint text not null,
  -- Garanti durumu açılışta sevk tarihinden hesaplanır ve saklanır (sonradan süre değişse de karar gerekçesi kalır).
  shipped_at timestamptz,
  warranty_until date,
  in_warranty boolean,
  status text not null default 'open'
    check (status in ('open', 'received', 'inspected', 'decided', 'closed', 'cancelled')),
  received_at timestamptz,
  received_by uuid references users(id),
  finding text,
  cause text check (cause in ('manufacturing', 'component', 'design', 'firmware', 'customer_damage', 'no_fault_found', 'unknown')),
  inspected_by uuid references users(id),
  inspected_at timestamptz,
  disposition text check (disposition in ('return_as_is', 'repair', 'replace', 'scrap', 'restock')),
  disposition_note text,
  credit_note_requested boolean not null default false,
  change_request_id uuid references change_requests(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  repair_note text,
  retest_passed boolean,
  replacement_device_id uuid references devices(id),
  replacement_lot_id uuid references lots(id),
  outbound_carrier text,
  outbound_tracking text,
  outbound_address jsonb,
  closed_at timestamptz,
  cancel_reason text,
  opened_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);
-- Aynı seri için aynı anda tek açık iade.
create unique index rmas_one_open_per_device on rmas (device_id) where device_id is not null and status not in ('closed', 'cancelled');

alter table rmas enable row level security;
alter table rmas force row level security;
create policy tenant_isolation on rmas using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert, update on rmas to apis_app;

do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm
      from roles r
      join (values
        ('sales', 'rma.view'), ('sales', 'rma.create'), ('quality', 'rma.view'), ('quality', 'rma.create'), ('quality', 'rma.decide'),
        ('warehouse', 'rma.view'), ('manager', 'rma.view'), ('rd', 'rma.view'), ('accounting', 'rma.view'), ('technician', 'rma.view')
      ) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
