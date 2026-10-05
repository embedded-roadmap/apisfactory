-- Oturum 41 devamı — uçtan uca bot testi bulgusu (2026-10-05): yöneticinin kullanıcı eklerken verdiği geçici parola
-- kalıcı olarak geçerli kalıyordu. Artık yönetici eklediği yeni kullanıcı ilk girişte parolasını değiştirmeden
-- başka bir şey yapamaz (API düzeyinde zorlanır: http/context.ts + app.ts preHandler). Kurucu (şirket kurulumu) ve
-- seed kullanıcıları parolayı kendisi belirlediği için işaretlenmez.
alter table users add column must_change_password boolean not null default false;

-- Yönetici daveti: admin_ensure_user ile aynı, ama yeni açılan hesap ilk girişte parolayı değiştirmek zorunda.
-- (admin_ensure_user şirket kurulumu ve seed için olduğu gibi kalır: orada parolayı kişinin kendisi belirler.)
create or replace function admin_ensure_invited_user(p_email text, p_name text, p_hash text, out user_id uuid, out created boolean)
language plpgsql security definer set search_path = public as $$
begin
  select id into user_id from users where lower(email) = lower(p_email);
  created := user_id is null;
  if created then
    insert into users (email, name, password_hash, must_change_password) values (lower(p_email), p_name, p_hash, true) returning id into user_id;
  end if;
end $$;

-- Parola yalnızca oturumdaki kullanıcının kendisi için değiştirilebilir; değişince zorunluluk kalkar.
create or replace function auth_set_password(p_hash text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_user_id() is null then raise exception 'unauthenticated' using errcode = 'P0001'; end if;
  update users set password_hash = p_hash, must_change_password = false, updated_at = now() where id = app_user_id();
  update sessions set revoked_at = now() where user_id = app_user_id() and revoked_at is null
    and id <> nullif(current_setting('app.session_id', true), '')::uuid;
end $$;

create or replace function auth_must_change_password() returns boolean
language sql security definer set search_path = public stable as $$
  select coalesce((select must_change_password from users where id = app_user_id()), false)
$$;

grant execute on function auth_must_change_password(), admin_ensure_invited_user(text, text, text) to apis_app;
