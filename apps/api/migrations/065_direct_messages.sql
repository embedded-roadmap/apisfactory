-- Oturum 41 devamı — R25: birebir mesajlaşma. Mevcut konuşma altyapısı (threads/messages/ekler/okundu) 'direct'
-- türünde bir başlıkla kullanılır; başlığın kaydı iki katılımcılı bir konuşmadır.
-- GİZLİLİK VERİ TABANINDA: kısıtlayıcı (RESTRICTIVE) RLS politikaları birebir konuşmayı ve ona bağlı mesaj, ek,
-- bahsetme ve okundu kayıtlarını yalnız iki katılımcıya gösterir — rol izni (yönetici, yönetim dahil) yetmez.
-- İstisna yalnız yedek/geri yükleme betikleri: app.system_scope = 'backup' (uygulama isteklerinde hiç ayarlanmaz).

create table direct_conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  user_a uuid not null references users(id),
  user_b uuid not null references users(id),
  created_at timestamptz not null default now(),
  check (user_a < user_b),
  unique (company_id, user_a, user_b)
);

create or replace function app_system_scope() returns text
language sql stable as $$ select coalesce(current_setting('app.system_scope', true), '') $$;

alter table direct_conversations enable row level security;
alter table direct_conversations force row level security;
create policy tenant_isolation on direct_conversations using (company_id = app_company_id()) with check (company_id = app_company_id());
create policy participants_only on direct_conversations as restrictive
  using (app_system_scope() = 'backup' or app_user_id() in (user_a, user_b))
  with check (app_system_scope() = 'backup' or app_user_id() in (user_a, user_b));
grant select, insert on direct_conversations to apis_app;

create policy direct_participants on threads as restrictive
  using (entity_type <> 'direct' or app_system_scope() = 'backup'
         or exists (select 1 from direct_conversations d where d.id = threads.entity_id));

-- Politika alt sorguları da RLS'e tabidir: görünmeyen başlığın mesajı, eki, bahsetmesi ve okundu kaydı da görünmez.
create policy thread_visible on messages as restrictive
  using (app_system_scope() = 'backup' or exists (select 1 from threads t where t.id = messages.thread_id));
create policy message_visible on message_attachments as restrictive
  using (app_system_scope() = 'backup' or exists (select 1 from messages m where m.id = message_attachments.message_id));
create policy message_visible on message_mentions as restrictive
  using (app_system_scope() = 'backup' or exists (select 1 from messages m where m.id = message_mentions.message_id));
create policy thread_visible on thread_reads as restrictive
  using (app_system_scope() = 'backup' or exists (select 1 from threads t where t.id = thread_reads.thread_id));
