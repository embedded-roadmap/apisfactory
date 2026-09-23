-- Oturum 14 (W24): tedarikçi faturası, üç yönlü eşleştirme (sipariş – kabul – fatura), fark onayı (görev ayrılığı),
-- vade ve ödeme planı. Ödeme YAPILMAZ: yalnızca dışarıda yapılmış ödemenin kaydı tutulur (banka bağlantısı yok).

alter table suppliers add column payment_terms_days int not null default 30 check (payment_terms_days between 0 and 365);

-- Eşleştirme toleransı: sürümlü, değişmez.
create table ap_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  version_no int not null,
  price_tolerance_pct numeric(6, 3) not null check (price_tolerance_pct between 0 and 50),
  qty_tolerance_pct numeric(6, 3) not null check (qty_tolerance_pct between 0 and 50),
  amount_tolerance numeric(18, 2) not null default 0 check (amount_tolerance >= 0),
  note text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, version_no)
);
create trigger ap_policies_append_only before update or delete on ap_policies for each row execute function forbid_mutation();

create table supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  supplier_id uuid not null references suppliers(id),
  invoice_no text not null,
  invoice_date date not null,
  due_date date not null,
  currency char(3) not null,
  net_amount numeric(18, 2) not null,
  tax_amount numeric(18, 2) not null default 0 check (tax_amount >= 0),
  gross_amount numeric(18, 2) not null,
  status text not null default 'received' check (status in ('received', 'variance', 'approved', 'rejected', 'paid', 'cancelled')),
  match_result jsonb,
  ap_policy_version int,
  entered_by uuid references users(id),
  created_at timestamptz not null default now(),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text,
  unique (company_id, code),
  unique (supplier_id, invoice_no),
  check (gross_amount = net_amount + tax_amount)
);

create table supplier_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  invoice_id uuid not null references supplier_invoices(id),
  line_no int not null,
  po_line_id uuid references purchase_order_lines(id),
  item_id uuid references items(id),
  description text,
  qty numeric(18, 6) not null check (qty > 0),
  unit_price numeric(18, 6) not null check (unit_price >= 0),
  amount numeric(18, 2) not null,
  unique (invoice_id, line_no)
);

-- Dışarıda yapılmış ödemenin kaydı (değişmez). Sistem ödeme başlatmaz.
create table supplier_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  invoice_id uuid not null references supplier_invoices(id),
  amount numeric(18, 2) not null check (amount > 0),
  paid_on date not null,
  reference text not null,
  recorded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create trigger supplier_payments_append_only before update or delete on supplier_payments for each row execute function forbid_mutation();

do $$
declare t text;
begin
  foreach t in array array['ap_policies', 'supplier_invoices', 'supplier_invoice_lines', 'supplier_payments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert on ap_policies, supplier_invoice_lines, supplier_payments to apis_app;
grant select, insert, update on supplier_invoices to apis_app;

do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm from roles r
      join (values ('accounting', 'invoice.manage'), ('accounting', 'invoice.approve'), ('manager', 'invoice.approve'), ('manager', 'invoice.view'),
                   ('accounting', 'invoice.view'), ('purchasing', 'invoice.view'), ('accounting', 'payment.record')) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
