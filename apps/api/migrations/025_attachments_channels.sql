-- Oturum 19 (W27 devamı): mesajlara dosya/fotoğraf eki ve serbest grup kanalları.
-- Ek dosya harici depolamaya (S3 vb.) gitmez — veri tabanında saklanır; boyut ve tür sınırlıdır.
-- Kanal, herhangi bir iş kaydına bağlı olmayan, tüm şirket çalışanlarının görebildiği serbest konuşma odasıdır
-- (toplantı/görev ile aynı görünürlük tabanı: task.view); mevcut thread/message altyapısını aynen kullanır.

create table message_attachments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  message_id uuid not null references messages(id),
  file_name text not null check (length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv')),
  size_bytes int not null check (size_bytes between 1 and 6000000),
  sha256 text not null,
  content bytea not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index message_attachments_message on message_attachments (message_id);
create trigger message_attachments_append_only before update or delete on message_attachments for each row execute function forbid_mutation();

create table channels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null check (length(name) between 2 and 100),
  description text,
  archived_at timestamptz,
  archived_by uuid references users(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

do $$
declare t text;
begin
  foreach t in array array['message_attachments', 'channels'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert on message_attachments to apis_app;
grant select, insert, update on channels to apis_app;
