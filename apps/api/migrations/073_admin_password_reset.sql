-- Oturum 41 devamı: yönetici, parolasını unutan üyeye geçici parola verebilir (e-postalı "parolamı unuttum" canlı SMTP
-- gerektirir; o gelene kadar bu yol). Geçici parolayla girişte parola değişimi zorunludur (072).
-- Güvenlik: kullanıcı başka bir şirketin de üyesiyse sıfırlanmaz — aksi halde A şirketinin yöneticisi, B şirketindeki
-- hesabı da ele geçirebilirdi. memberships ve sessions RLS'i yalnız oturumdaki şirketin / kullanıcının satırlarını
-- gösterdiği için (membership_visibility: company_id = şirket OR user_id = kullanıcı) diğer şirket üyeliklerinin
-- kontrolü ve oturumların kapatılması hedef kullanıcı kapsamında yapılır, ardından yöneticinin kimliği geri yüklenir.
-- (İlk sürümde bu yapılmadığı için kontrol hep "başka üyelik yok" diyordu — test/admin-password-reset.test.ts yakaladı.)
create or replace function admin_reset_member_password(p_membership uuid, p_hash text) returns text
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_actor text; v_other boolean;
begin
  if app_company_id() is null or app_user_id() is null then raise exception 'unauthenticated' using errcode = 'P0001'; end if;
  select user_id into v_user from memberships where id = p_membership and company_id = app_company_id();
  if v_user is null then return 'not_found'; end if;
  if v_user = app_user_id() then return 'self'; end if;

  v_actor := current_setting('app.user_id', true);
  perform set_config('app.user_id', v_user::text, true);
  select exists (select 1 from memberships where user_id = v_user and company_id <> app_company_id()) into v_other;
  if v_other then
    perform set_config('app.user_id', v_actor, true);
    return 'multi_company';
  end if;
  update users set password_hash = p_hash, must_change_password = true, updated_at = now() where id = v_user;
  update sessions set revoked_at = now() where user_id = v_user and revoked_at is null;
  perform set_config('app.user_id', v_actor, true);
  return 'ok';
end $$;

grant execute on function admin_reset_member_password(uuid, text) to apis_app;
