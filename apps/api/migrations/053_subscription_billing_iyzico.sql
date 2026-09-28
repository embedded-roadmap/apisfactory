-- Oturum 41 (dış bağımlılık maddesi 6 — abonelik ücreti tahsilatı). Kullanıcı kararları (2026-09-28):
--  - Sağlayıcı: iyzico Abonelik (tekrarlı ödeme; kart bilgisi iyzico'nun ödeme formunda girilir, bize gelmez).
--  - Fiyat: her paket için aylık + yıllık, USD/EUR. Tutarlar platform işletmecisi tarafından girilir (burada tohumlanmaz).
--  - Ödeme alınamazsa / deneme biterse: otomatik 'gecikmiş' + 14 gün ek süre, sonra otomatik 'kısıtlı'.
--  - Resmi fatura (e-fatura/e-arşiv): muhasebe elle keser; sistem her başarılı tahsilat için kesilecek faturayı listeler.
-- iyzico erişim bilgisi PLATFORM düzeyindedir (tahsilatı platform işletmecisi yapar): IYZICO_API_KEY / IYZICO_SECRET_KEY.

-- Paket fiyatları (platform referans verisi; şirkete özgü değil). provider_plan_ref: iyzico ödeme planı referans kodu.
create table subscription_prices (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references subscription_plans(id),
  billing_interval text not null check (billing_interval in ('monthly', 'yearly')),
  currency char(3) not null check (currency in ('USD', 'EUR')),
  amount numeric(18, 2) not null check (amount > 0),
  provider_plan_ref text unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (plan_id, billing_interval, currency)
);
grant select on subscription_prices to apis_app;

alter table companies add column subscription_price_id uuid references subscription_prices(id);
alter table companies add column provider_subscription_ref text unique;
alter table companies add column provider_customer_ref text;
alter table companies add column provider_synced_at timestamptz;
alter table companies add column grace_until date;

-- Deneme bitince ek süreye (gecikmiş) geçiş otomatik yapılabilsin.
-- (Geçiş grafiği uygulamada: trial → active | delinquent | cancelled.)

-- Ödeme formu oturumları (iyzico checkout token → şirket). Token tahmin edilemez; geri çağrı bununla eşleşir.
create table subscription_checkouts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  price_id uuid not null references subscription_prices(id),
  provider_token text not null unique,
  form_content text not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed', 'expired')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Sağlayıcıdan gelen tahsilatlar (sipariş referansıyla tekil — aynı tahsilat iki kez işlenmez) ve fatura takibi.
create table subscription_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  provider text not null default 'iyzico',
  provider_order_ref text not null unique,
  status text not null check (status in ('success', 'failed')),
  amount numeric(18, 2),
  currency char(3),
  period_start date,
  period_end date,
  occurred_at timestamptz not null default now(),
  invoice_status text not null default 'to_invoice' check (invoice_status in ('to_invoice', 'invoiced', 'not_applicable')),
  invoice_no text,
  invoice_note text,
  invoiced_by uuid references users(id),
  invoiced_at timestamptz,
  check (status = 'success' or invoice_status = 'not_applicable'),
  check (invoice_status <> 'invoiced' or (invoice_no is not null and invoiced_at is not null))
);
create index subscription_payments_company on subscription_payments (company_id, occurred_at desc);

alter table subscription_events drop constraint subscription_events_event_type_check;
alter table subscription_events add constraint subscription_events_event_type_check
  check (event_type in ('status_changed', 'plan_changed', 'payment_recorded', 'payment_failed', 'invoice_recorded'));

do $$
declare t text;
begin
  foreach t in array array['subscription_checkouts', 'subscription_payments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on subscription_checkouts, subscription_payments to apis_app;

-- Oturumsuz uçlar (iyzico geri çağrısı / bildirimi / ödeme formu sayfası) şirketi, tahmin edilemez token veya
-- abonelik referansıyla bulur. Tablolarda FORCE RLS olduğundan (sahip rol dahil) security definer tek başına yetmez;
-- bunun yerine yalnız SEÇİM için ek, dar bir politika: satır ancak işlem içinde ayarlanan anahtarla BİREBİR
-- eşleşirse görünür (app.billing_lookup). Anahtarı yalnız aşağıdaki fonksiyonlar, kendi işlemleri içinde ayarlar.
create policy billing_lookup on subscription_checkouts for select
  using (provider_token = nullif(current_setting('app.billing_lookup', true), ''));
create policy billing_lookup on companies for select
  using (provider_subscription_ref = nullif(current_setting('app.billing_lookup', true), ''));

create or replace function subscription_company_by_checkout(p_token text)
returns uuid language plpgsql set search_path = public as $$
declare cid uuid;
begin
  perform set_config('app.billing_lookup', coalesce(p_token, ''), true);
  select company_id into cid from subscription_checkouts where provider_token = p_token;
  perform set_config('app.billing_lookup', '', true);
  return cid;
end $$;

create or replace function subscription_company_by_ref(p_ref text)
returns uuid language plpgsql set search_path = public as $$
declare cid uuid;
begin
  perform set_config('app.billing_lookup', coalesce(p_ref, ''), true);
  select id into cid from companies where provider_subscription_ref = p_ref;
  perform set_config('app.billing_lookup', '', true);
  return cid;
end $$;

-- Ödeme formu sayfası: yalnız bekleyen ve 30 dk'dan yeni formun içeriği.
create or replace function subscription_checkout_form(p_token text)
returns text language plpgsql set search_path = public as $$
declare c text;
begin
  perform set_config('app.billing_lookup', coalesce(p_token, ''), true);
  select form_content into c from subscription_checkouts where provider_token = p_token and status = 'pending' and created_at > now() - interval '30 minutes';
  perform set_config('app.billing_lookup', '', true);
  return c;
end $$;
grant execute on function subscription_company_by_checkout(text), subscription_company_by_ref(text), subscription_checkout_form(text) to apis_app;
