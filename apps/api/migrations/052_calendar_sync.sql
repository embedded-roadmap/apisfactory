-- Oturum 41 (dış bağımlılık maddesi 5 — takvim canlı senkronu, W28): Google Calendar / Microsoft 365.
-- OAuth UYGULAMASI platform düzeyindedir (GOOGLE_OAUTH_* / MS_OAUTH_* ortam değişkenleri); her KULLANICI kendi
-- hesabını yetkilendirir. Token'lar AES-256-GCM ile şifreli (CONNECTOR_SECRET_KEY), düz metin asla dönmez.
-- Uygulama → takvim: toplantı, düzenleyenin bağlı takvimine etkinlik olarak yazılır (davetleri sağlayıcı gönderir).
-- Takvim → uygulama: artımlı senkron (Google syncToken / Microsoft Graph delta); yalnız bağlı etkinliklerdeki
-- saat/süre/başlık değişikliği ve iptal toplantıya yansır.

create table calendar_connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  user_id uuid not null references users(id),
  provider text not null check (provider in ('google', 'microsoft')),
  account_email text,
  token_enc text,
  status text not null default 'active' check (status in ('active', 'revoked', 'error')),
  sync_cursor text,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id, provider),
  check (status <> 'active' or token_enc is not null)
);

create table calendar_event_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  meeting_id uuid not null references meetings(id) unique,
  connection_id uuid not null references calendar_connections(id),
  external_event_id text not null,
  last_pushed_at timestamptz not null default now(),
  last_pulled_at timestamptz,
  unique (connection_id, external_event_id)
);

do $$
declare t text;
begin
  foreach t in array array['calendar_connections', 'calendar_event_links'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on calendar_connections, calendar_event_links to apis_app;

-- Kapanmış toplantı değişmez kuralı (guard_closed_meeting) aynen geçerli: takvimden gelen değişiklik yalnız 'planned'
-- toplantıya uygulanır.
