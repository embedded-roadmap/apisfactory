-- apisfactory — çekirdek şema (F1: kimlik, şirket ayrımı, yetki, olay kaydı, çıkış kutusu, tekrar koruması)
-- Bu dosya apis_owner rolüyle çalıştırılır. Uygulama apis_app rolüyle bağlanır ve RLS'e tabidir.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Yardımcılar
-- ---------------------------------------------------------------------------
create or replace function app_company_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.company_id', true), '')::uuid $$;

create or replace function app_user_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

-- Değişmez (append-only) tablolar için: güncelleme ve silme yasak. Düzeltme yeni kayıtla yapılır (prompt §4, §22).
create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'append_only: % tablosunda % yapılamaz; düzeltme yeni kayıtla yapılır', tg_table_name, tg_op
    using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------------------
-- Kimlik ve organizasyon
-- ---------------------------------------------------------------------------
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  password_hash text not null,
  mfa_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_demo boolean not null default false,
  default_currency char(3) not null default 'TRY',
  timezone text not null default 'Europe/Istanbul',
  created_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table sites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  unique (company_id, code)
);

create table departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  parent_id uuid references departments(id),
  unique (company_id, code)
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  user_id uuid not null references users(id),
  status text not null default 'active' check (status in ('active', 'invited', 'suspended')),
  is_external boolean not null default false, -- fason/dış kullanıcı
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);

create table roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  unique (company_id, code)
);

create table role_permissions (
  company_id uuid not null references companies(id),
  role_id uuid not null references roles(id) on delete cascade,
  permission text not null,
  primary key (role_id, permission)
);

create table membership_roles (
  company_id uuid not null references companies(id),
  membership_id uuid not null references memberships(id) on delete cascade,
  role_id uuid not null references roles(id),
  department_id uuid references departments(id),
  primary key (membership_id, role_id)
);

-- ---------------------------------------------------------------------------
-- İş olayı defteri (teknik logdan ayrı). Değiştirilemez.
-- ---------------------------------------------------------------------------
create table events (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies(id),
  entity_type text not null,
  entity_id uuid not null,
  event_type text not null,
  actor_user_id uuid references users(id),
  actor_kind text not null check (actor_kind in ('human', 'import', 'api', 'automation')),
  source text,
  before_state jsonb,
  after_state jsonb,
  reason text,
  correlation_id uuid,
  created_at timestamptz not null default now()
);
create index events_entity_idx on events (company_id, entity_type, entity_id, created_at);
create index events_time_idx on events (company_id, created_at desc);
create trigger events_append_only before update or delete on events for each row execute function forbid_mutation();

-- İşlem çıkış kutusu: veri tabanı değişikliği ile arka plan olayı aynı işlemde yazılır (prompt §7).
create table outbox (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies(id),
  topic text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed', 'unknown')),
  attempts int not null default 0,
  last_error text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index outbox_pending_idx on outbox (status, available_at);

-- Tekrar koruması: aynı anahtarlı istek ikinci kez işlenmez, kayıtlı yanıt döner.
create table idempotency_keys (
  company_id uuid not null references companies(id),
  scope text not null,
  key text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (company_id, scope, key)
);

-- Günlük iş listesi: rolüne veya kişiye atanmış görevler.
create table tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  title text not null,
  assignee_role text,
  assignee_user_id uuid references users(id),
  entity_type text not null,
  entity_id uuid not null,
  kind text not null,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  due_at timestamptz,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (company_id, kind, entity_id, assignee_role)
);
create index tasks_open_idx on tasks (company_id, status, assignee_role);
