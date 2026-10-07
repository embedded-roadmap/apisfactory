-- Oturum 41 devamı — kişiler paneli (Teams benzeri): şirket içi çevrimiçi durumu.
-- Kişi durumunu kendisi seçer (çevrimiçi / meşgul / dışarıda / çevrimdışı görün); açık sekme dakikada bir sinyal gönderir.
-- Son sinyal 2 dakikadan eskiyse ya da "çevrimdışı görün" seçiliyse başkalarına çevrimdışı görünür (hesap: presence.ts).
-- Şirket içindeki herkes durumları görür; herkes yalnız KENDİ satırını yazabilir (RLS ile zorlanır).
create table user_presence (
  company_id uuid not null references companies(id),
  user_id uuid not null references users(id),
  status text not null default 'available' check (status in ('available', 'busy', 'away', 'invisible')),
  last_seen_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

alter table user_presence enable row level security;
alter table user_presence force row level security;
create policy presence_read on user_presence for select using (company_id = app_company_id());
create policy presence_insert_self on user_presence for insert with check (company_id = app_company_id() and user_id = app_user_id());
create policy presence_update_self on user_presence for update
  using (company_id = app_company_id() and user_id = app_user_id())
  with check (company_id = app_company_id() and user_id = app_user_id());
grant select, insert, update on user_presence to apis_app;
