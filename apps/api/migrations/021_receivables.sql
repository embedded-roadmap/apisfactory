-- Oturum 15 (W24 devamı): müşteri faturası (sevkiyattan taslak), tahsilat kaydı, alacak yaşlandırma, kredi limiti.
-- Resmi e-fatura/e-arşiv gönderimi YOK (W36); tahsilat YAPILMAZ, yalnızca dışarıda alınmış ödemenin kaydı tutulur.

alter table customers add column payment_terms_days int not null default 30 check (payment_terms_days between 0 and 365);
alter table customers add column credit_limit numeric(18, 2) check (credit_limit is null or credit_limit >= 0);
alter table customers add column credit_currency char(3) not null default 'TRY';
alter table customers add column overdue_block_days int check (overdue_block_days is null or overdue_block_days between 0 and 365);

-- Kredi engelinin gerekçeli kaldırılması (sipariş bazında, tek seferlik)
alter table sales_orders add column credit_release_reason text;
alter table sales_orders add column credit_released_by uuid references users(id);
alter table sales_orders add column credit_released_at timestamptz;

create table customer_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  customer_id uuid not null references customers(id),
  sales_order_id uuid not null references sales_orders(id),
  shipment_id uuid references shipments(id),
  status text not null default 'draft' check (status in ('draft', 'issued', 'paid', 'cancelled')),
  document_mode text not null default 'draft' check (document_mode in ('draft')),
  invoice_date date,
  due_date date,
  currency char(3) not null,
  tax_rate numeric(5, 2) not null check (tax_rate between 0 and 100),
  net_amount numeric(18, 2) not null,
  tax_amount numeric(18, 2) not null,
  gross_amount numeric(18, 2) not null,
  note text,
  cancel_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  issued_by uuid references users(id),
  issued_at timestamptz,
  unique (company_id, code),
  check (gross_amount = net_amount + tax_amount)
);
create unique index customer_invoices_one_per_shipment on customer_invoices (shipment_id) where status <> 'cancelled' and shipment_id is not null;

create table customer_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  invoice_id uuid not null references customer_invoices(id),
  line_no int not null,
  sales_order_line_id uuid references sales_order_lines(id),
  description text not null,
  qty numeric(18, 6) not null check (qty > 0),
  unit_price numeric(18, 4) not null check (unit_price >= 0),
  amount numeric(18, 2) not null,
  unique (invoice_id, line_no)
);

-- Kesilen faturanın satırları ve tutarı değişmez (düzeltme iptal + yeni fatura ile).
create or replace function guard_issued_customer_invoice() returns trigger
language plpgsql as $$
declare st text;
begin
  if tg_table_name = 'customer_invoices' then
    if old.status <> 'draft' and (new.net_amount <> old.net_amount or new.tax_amount <> old.tax_amount or new.currency <> old.currency
        or new.customer_id <> old.customer_id or new.invoice_date is distinct from old.invoice_date or new.due_date is distinct from old.due_date) then
      raise exception 'invoice_issued: kesilmiş fatura değiştirilemez; iptal edip yenisini kesin' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then select status into st from customer_invoices where id = old.invoice_id;
  else select status into st from customer_invoices where id = new.invoice_id; end if;
  if st <> 'draft' then raise exception 'invoice_issued: kesilmiş faturanın satırı değiştirilemez' using errcode = 'P0001'; end if;
  return coalesce(new, old);
end $$;
create trigger customer_invoices_guard before update on customer_invoices for each row execute function guard_issued_customer_invoice();
create trigger customer_invoice_lines_guard before insert or update or delete on customer_invoice_lines for each row execute function guard_issued_customer_invoice();

create table customer_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  invoice_id uuid not null references customer_invoices(id),
  amount numeric(18, 2) not null check (amount > 0),
  received_on date not null,
  reference text not null,
  recorded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create trigger customer_receipts_append_only before update or delete on customer_receipts for each row execute function forbid_mutation();

do $$
declare t text;
begin
  foreach t in array array['customer_invoices', 'customer_invoice_lines', 'customer_receipts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on customer_invoices to apis_app;
grant select, insert, update, delete on customer_invoice_lines to apis_app;
grant select, insert on customer_receipts to apis_app;

do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm from roles r
      join (values ('accounting', 'receivable.view'), ('accounting', 'receivable.manage'), ('accounting', 'credit.override'),
                   ('manager', 'receivable.view'), ('manager', 'credit.override'), ('sales', 'receivable.view')) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
