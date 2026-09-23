-- Oturum 4 (W23): teslim adresi, sevkiyat hazırlığı, paketleme (seri/lot okutma, paket kontrol listesi),
-- kısmi sevk, takip numarası, teslim teyidi ve teslim sorunu (prompt §17).

-- ---------------------------------------------------------------------------
-- Müşteri teslim adresleri. Sevkiyat adresin o anki kopyasını saklar; adres sonradan değişse de geçmiş belge değişmez.
-- ---------------------------------------------------------------------------
create table customer_addresses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  customer_id uuid not null references customers(id),
  label text not null,
  recipient text not null,
  phone text,
  line1 text not null,
  line2 text,
  district text,
  city text not null,
  postal_code text,
  country text not null default 'TR',
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index customer_addresses_one_default on customer_addresses (customer_id) where is_default and active;

-- Kısmi teslim izni sipariş bazındadır; kapalıysa sevkiyat kalan miktarın tamamını kapsamalıdır.
alter table sales_orders add column allow_partial boolean not null default true;
alter table sales_orders add column delivery_address_id uuid references customer_addresses(id);
alter table sales_orders drop constraint sales_orders_status_check;
alter table sales_orders add constraint sales_orders_status_check check (status in ('draft', 'availability_review', 'firm', 'shipped', 'cancelled'));

-- ---------------------------------------------------------------------------
-- Sevkiyat belgesi: hazırlanıyor → paketlendi → sevk edildi → teslim edildi / teslim sorunu. Hazırlıkta iptal edilebilir.
-- ---------------------------------------------------------------------------
alter table shipments alter column sales_order_line_id drop not null;
alter table shipments alter column qty drop not null;
alter table shipments alter column shipped_at drop not null;
alter table shipments alter column shipped_at drop default;
alter table shipments add column status text not null default 'shipped'
  check (status in ('preparing', 'packed', 'shipped', 'delivered', 'problem', 'cancelled'));
alter table shipments add column address_id uuid references customer_addresses(id);
alter table shipments add column address_snapshot jsonb;
alter table shipments add column carrier text;
alter table shipments add column tracking_no text;
alter table shipments add column delivered_at timestamptz;
alter table shipments add column problem_note text;
alter table shipments add column cancel_reason text;
alter table shipments add column created_by uuid references users(id);
alter table shipments add column created_at timestamptz not null default now();
alter table shipments alter column status set default 'preparing';

create table shipment_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  shipment_id uuid not null references shipments(id),
  sales_order_line_id uuid not null references sales_order_lines(id),
  qty numeric(18, 6) not null check (qty > 0),
  unique (shipment_id, sales_order_line_id)
);

-- Eski (paketsiz) sevkiyatlar satır tablosuna taşınır.
insert into shipment_lines (company_id, shipment_id, sales_order_line_id, qty)
select company_id, id, sales_order_line_id, qty from shipments where sales_order_line_id is not null;

create table packages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  shipment_id uuid not null references shipments(id),
  seq int not null,
  code text not null,
  -- Paket kontrolü: kutu, aksesuar, ürün/seri etiketi, son görsel kontrol (prompt §17)
  checklist jsonb not null default '{}'::jsonb,
  weight_kg numeric(10, 3),
  closed_at timestamptz,
  closed_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (shipment_id, seq),
  unique (company_id, code)
);

create table package_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  package_id uuid not null references packages(id),
  shipment_line_id uuid not null references shipment_lines(id),
  lot_id uuid not null references lots(id),
  device_id uuid references devices(id),
  qty numeric(18, 6) not null check (qty > 0),
  check (device_id is null or qty = 1),
  created_at timestamptz not null default now()
);
-- Bir seri aynı anda yalnızca bir pakette olabilir.
create unique index package_items_device on package_items (device_id) where device_id is not null;

do $$
declare t text;
begin
  foreach t in array array['customer_addresses', 'shipment_lines', 'packages', 'package_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
    execute format('grant select, insert, update, delete on %I to apis_app', t);
  end loop;
end $$;

-- Satış teslim adresini yönetir; depo teslim teyidini ve sorununu kaydeder.
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm
      from roles r
      join (values ('sales', 'customer.address.manage'), ('warehouse', 'shipment.deliver'), ('sales', 'shipment.deliver'), ('manager', 'shipment.view')) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
