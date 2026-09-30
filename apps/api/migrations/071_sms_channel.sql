-- Oturum 41 devamı — dış bağımlılık 4 (SMS): şirket başına SMS sağlayıcısı (Netgsm veya Verimor), e-postayla aynı konu seçimi.
-- Alıcı telefonu: iç bildirimlerde kişinin KENDİ girdiği üyelik telefonu (başkası yazamaz), müşteri hatırlatmasında
-- müşterinin varsayılan teslim adresindeki telefon. Erişim bilgisi şifreli (CONNECTOR_SECRET_KEY), hiçbir yanıtta dönmez.
-- Gönderimler bilgilendirme amaçlıdır (ticari ileti değildir → İYS kapsamı dışı).

alter table memberships add column notify_phone text check (notify_phone ~ '^905[0-9]{9}$');

create table sms_channels (
  company_id uuid primary key references companies(id),
  mode text not null default 'off' check (mode in ('off', 'test', 'live')),
  provider text check (provider in ('netgsm', 'verimor')),
  sender text check (sender ~ '^[A-Za-z0-9 .\-]{2,11}$'),
  credentials_enc text,
  topics text[] not null default array['escalation', 'customer_reminder'],
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  check (mode <> 'live' or (provider is not null and sender is not null and credentials_enc is not null))
);

create table sms_deliveries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  outbox_id bigint,
  topic text not null,
  recipient text not null,
  status text not null check (status in ('sent', 'test', 'skipped', 'failed')),
  error text,
  provider_ref text,
  created_at timestamptz not null default now()
);
create trigger sms_deliveries_append_only before update or delete on sms_deliveries for each row execute function forbid_mutation();
create index sms_deliveries_company_idx on sms_deliveries (company_id, created_at desc);
create index sms_deliveries_outbox_idx on sms_deliveries (outbox_id) where outbox_id is not null;

do $$
declare t text;
begin
  foreach t in array array['sms_channels', 'sms_deliveries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on sms_channels to apis_app;
grant select, insert on sms_deliveries to apis_app;
