-- Şirket ayrımı: satır seviyesi güvenlik. Şirket kimliği istemciden değil, doğrulanmış üyelikten gelir (prompt §28).
-- Uygulama her istekte işlem içinde app.company_id ve app.user_id değerlerini ayarlar.

do $$
declare t text;
begin
  foreach t in array array[
    'sites', 'departments', 'roles', 'role_permissions', 'membership_roles',
    'events', 'outbox', 'idempotency_keys', 'tasks',
    'items', 'products', 'bom_versions', 'bom_lines', 'product_revisions', 'handover_approvals', 'handover_rounds',
    'locations', 'lots', 'stock_moves', 'customers', 'sales_orders', 'sales_order_lines', 'reservations',
    'production_needs', 'purchase_order_lines', 'purchase_requests', 'purchase_allocations',
    'goods_receipts', 'goods_receipt_lines', 'inspections', 'import_jobs', 'counters'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;

-- Üyelikler: kişi kendi üyeliklerini, şirket bağlamında o şirketin üyeliklerini görür.
alter table memberships enable row level security;
alter table memberships force row level security;
create policy membership_visibility on memberships
  using (company_id = app_company_id() or user_id = app_user_id())
  with check (company_id = app_company_id());

-- Şirketler: yalnızca üyesi olunan şirketler görünür.
alter table companies enable row level security;
alter table companies force row level security;
create policy company_visibility on companies
  using (id = app_company_id() or exists (select 1 from memberships m where m.company_id = companies.id and m.user_id = app_user_id() and m.status = 'active'));

-- Oturumlar: yalnızca kendi oturumları.
alter table sessions enable row level security;
alter table sessions force row level security;
create policy session_owner on sessions using (user_id = app_user_id()) with check (user_id = app_user_id());

-- Giriş sırasında kullanıcıyı e-postayla bulmak için dar kapsamlı fonksiyon (parola özeti dışarı sızmaz, yalnızca doğrulama).
create or replace function auth_lookup_user(p_email text)
returns table (id uuid, email text, name text, password_hash text)
language sql security definer set search_path = public stable as $$
  select u.id, u.email, u.name, u.password_hash from users u where lower(u.email) = lower(p_email)
$$;

-- Çalışma zamanı rolünün hakları. Olay defteri ve stok hareketleri için UPDATE/DELETE verilmez.
grant usage on schema public to apis_app;
grant select, insert, update, delete on all tables in schema public to apis_app;
revoke update, delete on events, stock_moves from apis_app;
revoke update, delete, insert on users from apis_app;
grant select (id, email, name) on users to apis_app;
grant usage, select on all sequences in schema public to apis_app;
grant execute on all functions in schema public to apis_app;
