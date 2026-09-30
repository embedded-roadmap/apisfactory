-- Oturum 41 devamı — dış bağımlılık 4: bildirim e-postası (kullanıcı kararı: müşteri hangi sağlayıcıyı kullanırsa seçebilsin).
-- Şirket başına SMTP ayarı: SMTP standart olduğu için her e-posta sağlayıcısıyla çalışır (Google Workspace, Microsoft 365,
-- Yandex, barındırma firmaları, SES vb.). Parola şifreli (CONNECTOR_SECRET_KEY) ve hiçbir yanıtta dönmez.
-- mode: off (gönderilmez) · test (gönderilmeden kaydedilir) · live (gerçekten gönderilir).

create table email_channels (
  company_id uuid primary key references companies(id),
  mode text not null default 'off' check (mode in ('off', 'test', 'live')),
  host text,
  port int check (port between 1 and 65535),
  secure boolean not null default false,
  username text,
  credentials_enc text,
  from_address text,
  from_name text,
  reply_to text,
  topics text[] not null default array['mention', 'meeting_invite', 'meeting_minutes', 'meeting_cancelled', 'escalation', 'customer_reminder'],
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  check (mode <> 'live' or (host is not null and port is not null and from_address is not null))
);

create table email_deliveries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  outbox_id bigint, -- kuyruk işi (yeniden denemede gönderilmiş alıcılar atlanır); deneme gönderiminde boş
  topic text not null,
  recipient text not null,
  subject text not null,
  status text not null check (status in ('sent', 'test', 'skipped', 'failed')),
  error text,
  message_id text,
  created_at timestamptz not null default now()
);
create trigger email_deliveries_append_only before update or delete on email_deliveries for each row execute function forbid_mutation();
create index email_deliveries_company_idx on email_deliveries (company_id, created_at desc);
create index email_deliveries_outbox_idx on email_deliveries (outbox_id) where outbox_id is not null;

do $$
declare t text;
begin
  foreach t in array array['email_channels', 'email_deliveries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on email_channels to apis_app;
grant select, insert on email_deliveries to apis_app;
