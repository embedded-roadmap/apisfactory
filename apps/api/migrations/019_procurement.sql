-- Oturum 13 (W18): tedarikçi, teklif talebi (RFQ) ve teklifler, satın alma siparişi, tedarikçi teyidi,
-- gecikme takibi ve etki. Tedarikçiye gerçek gönderim yok: gönderim/hatırlatma test modundaki çıkış kutusuna yazılır.

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  contact_email text,
  default_lead_time_days int check (default_lead_time_days is null or default_lead_time_days between 0 and 365),
  status text not null default 'active' check (status in ('active', 'blocked')),
  blocked_reason text,
  note text,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table rfqs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  purchase_request_id uuid references purchase_requests(id),
  item_id uuid not null references items(id),
  qty numeric(18, 6) not null check (qty > 0),
  need_date date,
  status text not null default 'open' check (status in ('open', 'awarded', 'cancelled')),
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  awarded_quote_id uuid,
  award_reason text,
  unique (company_id, code)
);
create unique index rfqs_one_open_per_pr on rfqs (purchase_request_id) where status <> 'cancelled' and purchase_request_id is not null;

create table rfq_quotes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  rfq_id uuid not null references rfqs(id),
  supplier_id uuid not null references suppliers(id),
  unit_price numeric(18, 6) not null check (unit_price >= 0),
  currency char(3) not null,
  lead_time_days int not null check (lead_time_days between 0 and 365),
  moq numeric(18, 6),
  valid_until date,
  note text,
  source text not null default 'manual' check (source in ('manual', 'test_connector')),
  entered_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (rfq_id, supplier_id)
);
alter table rfqs add constraint rfqs_awarded_quote_fk foreign key (awarded_quote_id) references rfq_quotes(id);

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  supplier_id uuid not null references suppliers(id),
  currency char(3) not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'confirmed', 'partially_received', 'received', 'cancelled')),
  send_mode text not null default 'test' check (send_mode in ('test')),
  sent_at timestamptz,
  sent_by uuid references users(id),
  cancel_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

alter table purchase_order_lines add column po_id uuid references purchase_orders(id);
alter table purchase_order_lines add column supplier_id uuid references suppliers(id);
alter table purchase_order_lines add column unit_price numeric(18, 6);
alter table purchase_order_lines add column currency char(3);
alter table purchase_order_lines add column requested_date date;
alter table purchase_order_lines add column purchase_request_id uuid references purchase_requests(id);
alter table purchase_order_lines add column quote_id uuid references rfq_quotes(id);
alter table purchase_order_lines add column last_followup_at timestamptz;

-- Tedarikçi teyitleri: her teyit/değişiklik ayrı, değişmez kayıt (önceki tarih ve gecikme günü ile).
create table po_confirmations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  po_line_id uuid not null references purchase_order_lines(id),
  confirmed_date date not null,
  confirmed_qty numeric(18, 6) not null check (confirmed_qty > 0),
  previous_date date,
  slip_days int,
  supplier_reference text,
  source text not null default 'manual' check (source in ('manual', 'test_connector')),
  note text,
  entered_by uuid references users(id),
  created_at timestamptz not null default now()
);
create trigger po_confirmations_append_only before update or delete on po_confirmations for each row execute function forbid_mutation();

do $$
declare t text;
begin
  foreach t in array array['suppliers', 'rfqs', 'rfq_quotes', 'purchase_orders', 'po_confirmations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on suppliers, rfqs, rfq_quotes, purchase_orders to apis_app;
grant select, insert on po_confirmations to apis_app;

-- Rol izinleri ve mevcut serbest metin tedarikçilerin kayda dönüştürülmesi
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm from roles r
      join (values ('purchasing', 'purchase.order.manage'), ('purchasing', 'supplier.manage'), ('manager', 'purchase.order.manage')) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
    insert into suppliers (company_id, code, name)
    select c.id, 'TED-' || lpad(row_number() over (order by supplier_name)::text, 3, '0'), supplier_name
      from (select distinct supplier_name from purchase_order_lines where company_id = c.id) s;
    update purchase_order_lines po set supplier_id = s.id from suppliers s where s.company_id = po.company_id and s.name = po.supplier_name and po.company_id = c.id;
  end loop;
end $$;
