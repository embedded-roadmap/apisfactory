-- apisfactory — iş alanı şeması: kalem/MPN, ürün, revizyon ve devir, BOM, stok defteri, satış, satın alma, içe aktarım

-- Üretici MPN'si şirket içi koddan ayrıdır (prompt §6).
create table items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  kind text not null check (kind in ('component', 'product', 'subassembly')),
  manufacturer text,
  mpn text,
  unit text not null default 'pcs',
  created_at timestamptz not null default now(),
  unique (company_id, code)
);
create unique index items_mfr_mpn_uq on items (company_id, lower(manufacturer), lower(mpn)) where mpn is not null and manufacturer is not null;
create index items_mpn_idx on items (company_id, lower(mpn));

create table products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  item_id uuid not null references items(id),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table bom_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  product_id uuid not null references products(id),
  version_no int not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  source_import_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (product_id, version_no)
);

create table bom_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  bom_version_id uuid not null references bom_versions(id),
  line_no int not null,
  item_id uuid not null references items(id),
  qty_per numeric(18, 6) not null check (qty_per > 0),
  refdes text,
  description text,
  dnp boolean not null default false,
  unique (bom_version_id, line_no)
);

-- Yayımlanmış BOM satırları değiştirilemez (prompt §4: yayımlanmış BOM üzerine yazılamaz).
create or replace function guard_published_bom_lines() returns trigger
language plpgsql as $$
declare st text;
begin
  select status into st from bom_versions where id = coalesce(new.bom_version_id, old.bom_version_id);
  if st <> 'draft' then
    raise exception 'bom_published: yayımlanmış BOM sürümü değiştirilemez' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger bom_lines_guard before insert or update or delete on bom_lines for each row execute function guard_published_bom_lines();

create table product_revisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  product_id uuid not null references products(id),
  rev text not null,
  status text not null default 'draft'
    check (status in ('draft', 'development', 'pilot', 'handover_review', 'released', 'rejected', 'suspended', 'end_of_life')),
  bom_version_id uuid references bom_versions(id),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique (product_id, rev)
);

-- Devir onayları: Ar-Ge, üretim ve kalite. Her tur ayrı kayıttır; son tur geçerlidir.
create table handover_approvals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  revision_id uuid not null references product_revisions(id),
  round int not null,
  area text not null check (area in ('rd', 'production', 'quality')),
  decision text not null check (decision in ('approve', 'reject')),
  decided_by uuid not null references users(id),
  note text,
  decided_at timestamptz not null default now(),
  unique (revision_id, round, area)
);
create table handover_rounds (
  company_id uuid not null references companies(id),
  revision_id uuid primary key references product_revisions(id),
  current_round int not null default 0
);

-- ---------------------------------------------------------------------------
-- Stok: konum tipi kullanılabilirliği belirler; miktar yalnızca hareket defterinden türetilir.
-- ---------------------------------------------------------------------------
create table locations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  site_id uuid references sites(id),
  code text not null,
  name text not null,
  type text not null check (type in ('stock', 'incoming_inspection', 'quarantine', 'production', 'subcontractor', 'finished')),
  unique (company_id, code)
);

create table lots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  item_id uuid not null references items(id),
  lot_no text not null,
  product_revision_id uuid references product_revisions(id), -- bitmiş ürün lotları için revizyon
  parent_lot_id uuid references lots(id),                    -- lot bölme / makara kesme zinciri
  date_code text,
  supplier_name text,
  inspection_status text not null default 'not_required'
    check (inspection_status in ('not_required', 'pending', 'accepted', 'rejected', 'partial')),
  created_at timestamptz not null default now(),
  unique (company_id, item_id, lot_no)
);

create table stock_moves (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies(id),
  item_id uuid not null references items(id),
  lot_id uuid not null references lots(id),
  from_location_id uuid references locations(id),
  to_location_id uuid references locations(id),
  qty numeric(18, 6) not null check (qty > 0),
  move_type text not null check (move_type in ('receive', 'inspect_accept', 'inspect_reject', 'opening', 'adjust_in', 'adjust_out', 'issue', 'transfer', 'return', 'scrap')),
  ref_type text,
  ref_id uuid,
  idempotency_key text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (from_location_id is not null or to_location_id is not null),
  unique (company_id, idempotency_key)
);
create index stock_moves_item_idx on stock_moves (company_id, item_id);
create index stock_moves_lot_idx on stock_moves (company_id, lot_id);
create trigger stock_moves_append_only before update or delete on stock_moves for each row execute function forbid_mutation();

-- Lot × konum bakiyesi (hareketlerden türetilir).
create view stock_balances with (security_invoker = true) as
select m.company_id, m.item_id, m.lot_id, l.location_id, sum(l.delta) as qty
from stock_moves m
cross join lateral (values (m.to_location_id, m.qty), (m.from_location_id, -m.qty)) as l(location_id, delta)
where l.location_id is not null
group by m.company_id, m.item_id, m.lot_id, l.location_id
having sum(l.delta) <> 0;

-- Fiziksel bakiye negatife düşemez: her hareket sonrası kaynak konum kontrol edilir.
create or replace function guard_negative_stock() returns trigger
language plpgsql as $$
declare bal numeric;
begin
  if new.from_location_id is not null then
    select coalesce(sum(case when to_location_id = new.from_location_id then qty else 0 end)
                  - sum(case when from_location_id = new.from_location_id then qty else 0 end), 0)
      into bal
      from stock_moves
     where company_id = new.company_id and lot_id = new.lot_id
       and (to_location_id = new.from_location_id or from_location_id = new.from_location_id);
    if bal < 0 then
      raise exception 'negative_stock: lot % konumda yetersiz (bakiye %)', new.lot_id, bal using errcode = 'P0001';
    end if;
  end if;
  return null;
end $$;
create constraint trigger stock_moves_no_negative after insert on stock_moves
  deferrable initially immediate for each row execute function guard_negative_stock();

-- ---------------------------------------------------------------------------
-- Satış
-- ---------------------------------------------------------------------------
create table customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  unique (company_id, code)
);

create table sales_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  customer_id uuid not null references customers(id),
  status text not null default 'draft' check (status in ('draft', 'availability_review', 'firm', 'cancelled')),
  requested_date date not null,
  promised_date date, -- müşteriye taahhüt edilen tarih; tahmini terminden ayrı (prompt §4)
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (company_id, code)
);

create table sales_order_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  order_id uuid not null references sales_orders(id),
  line_no int not null,
  product_revision_id uuid not null references product_revisions(id),
  qty numeric(18, 6) not null check (qty > 0),
  unit_price numeric(18, 4),
  currency char(3) not null default 'TRY',
  unique (order_id, line_no)
);

-- Rezervasyon: aynı miktar iki işe ayrılamaz. Toplam aktif rezervasyon kullanılabilir stoğu aşamaz (servis katmanı kilitle).
create table reservations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  item_id uuid not null references items(id),
  lot_id uuid references lots(id),
  qty numeric(18, 6) not null check (qty > 0),
  demand_type text not null check (demand_type in ('sales_order_line', 'production_need')),
  demand_id uuid not null,
  status text not null default 'active' check (status in ('active', 'released', 'consumed')),
  created_at timestamptz not null default now()
);
create index reservations_item_idx on reservations (company_id, item_id) where status = 'active';

-- Eksik ürün için üretim ihtiyacı. Satış satırı başına tek ihtiyaç (T04: tekrarlı olay tek ihtiyaç).
create table production_needs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  sales_order_line_id uuid not null references sales_order_lines(id),
  product_revision_id uuid not null references product_revisions(id),
  bom_version_id uuid not null references bom_versions(id), -- sürüm sabitlenir
  qty numeric(18, 6) not null check (qty > 0),
  status text not null default 'planned' check (status in ('planned', 'released', 'cancelled', 'done')),
  created_at timestamptz not null default now(),
  unique (sales_order_line_id)
);

-- ---------------------------------------------------------------------------
-- Satın alma (bu fazda: talep ve açık sipariş miktarı; dış gönderim yok)
-- ---------------------------------------------------------------------------
create table purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  po_code text not null,
  supplier_name text not null,
  item_id uuid not null references items(id),
  qty_ordered numeric(18, 6) not null check (qty_ordered > 0),
  qty_received numeric(18, 6) not null default 0,
  confirmed_date date,
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  created_at timestamptz not null default now()
);

create table purchase_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  item_id uuid not null references items(id),
  qty numeric(18, 6) not null check (qty > 0),
  need_date date,
  status text not null default 'open' check (status in ('open', 'approved', 'rejected', 'converted', 'cancelled')),
  source_type text not null check (source_type in ('production_need', 'rd_project', 'manual')),
  source_id uuid,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, code),
  unique (company_id, source_type, source_id, item_id)
);

-- Açık alımın hangi ihtiyaca ayrıldığı (aynı açık alım iki kez sayılmaz).
create table purchase_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  po_line_id uuid not null references purchase_order_lines(id),
  production_need_id uuid not null references production_needs(id),
  qty numeric(18, 6) not null check (qty > 0)
);

-- ---------------------------------------------------------------------------
-- Mal kabul ve giriş kalite
-- ---------------------------------------------------------------------------
create table goods_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  supplier_name text not null,
  po_line_id uuid references purchase_order_lines(id),
  received_by uuid references users(id),
  received_at timestamptz not null default now(),
  unique (company_id, code)
);

create table goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  receipt_id uuid not null references goods_receipts(id),
  item_id uuid not null references items(id),
  lot_id uuid not null references lots(id),
  qty numeric(18, 6) not null check (qty > 0)
);

create table inspections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  receipt_line_id uuid not null references goods_receipt_lines(id),
  lot_id uuid not null references lots(id),
  accepted_qty numeric(18, 6) not null check (accepted_qty >= 0),
  rejected_qty numeric(18, 6) not null check (rejected_qty >= 0),
  decided_by uuid not null references users(id),
  note text,
  decided_at timestamptz not null default now(),
  unique (receipt_line_id) -- tek karar; düzeltme ayrı uygunsuzluk süreciyle (sonraki faz)
);

-- ---------------------------------------------------------------------------
-- İçe aktarım işleri (önizleme → onay → işleme)
-- ---------------------------------------------------------------------------
create table import_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  kind text not null check (kind in ('bom', 'stock_opening')),
  target_id uuid, -- BOM için ürün
  file_name text not null,
  file_hash text not null,
  status text not null default 'previewed' check (status in ('previewed', 'committed', 'failed', 'discarded')),
  mapping jsonb not null,
  preview jsonb,
  result jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  committed_at timestamptz
);
-- Aynı dosya aynı hedefe iki kez işlenemez (T13).
create unique index import_jobs_once_uq on import_jobs (company_id, kind, coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid), file_hash)
  where status = 'committed';

create table counters (
  company_id uuid not null references companies(id),
  name text not null,
  value bigint not null default 0,
  primary key (company_id, name)
);
