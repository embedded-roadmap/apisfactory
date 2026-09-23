-- Depo, sevkiyat için siparişi ve teslim bilgisini görmelidir (fiyat alan izniyle gizli kalır).
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, 'sales.view' from roles r where r.company_id = c.id and r.code = 'warehouse'
    on conflict do nothing;
  end loop;
end $$;
