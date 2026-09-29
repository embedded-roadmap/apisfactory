-- Oturum 41 devamı — R18 (ana talimat §16): "tekrarlayan hata düzeltici faaliyet ve etkinlik kontrolü açsın."
-- Uygunsuzluğa hata kodu (kalite kararında, isteğe bağlı). Aynı üründe aynı kod, şirket eşiği kadar (varsayılan 30 günde 3)
-- tekrar edince düzeltici faaliyet (DF) otomatik açılır; açık DF varken yeni tekrarlar ona bağlanır.
-- DF: kök neden + faaliyet → etkinlik kontrol tarihi → doğrulama (faaliyeti giren doğrulayamaz; faaliyetten sonra aynı hata
-- tekrar ettiyse "etkili" demek gerekçe ister); etkisizse yeniden açılır. Kök neden bir varsayımdır, doğrulama insan kararıdır.

alter table nonconformances add column defect_code text check (defect_code is null or defect_code ~ '^[A-Z0-9-]{2,30}$');
alter table nonconformances add column capa_id uuid;

create table capa_settings (
  company_id uuid primary key references companies(id),
  threshold int not null default 3 check (threshold between 2 and 100),
  window_days int not null default 30 check (window_days between 1 and 365),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table corrective_actions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  product_id uuid not null references products(id),
  defect_code text not null,
  status text not null default 'open' check (status in ('open', 'action_taken', 'closed')),
  trigger jsonb not null,
  root_cause text,
  action text,
  action_by uuid references users(id),
  action_at timestamptz,
  check_due date,
  verified_by uuid references users(id),
  verified_at timestamptz,
  verification_note text,
  reopen_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);
create unique index corrective_actions_one_active on corrective_actions (company_id, product_id, defect_code) where status <> 'closed';
alter table nonconformances add constraint nonconformances_capa_fk foreign key (capa_id) references corrective_actions(id);

do $$
declare t text;
begin
  foreach t in array array['capa_settings', 'corrective_actions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on capa_settings, corrective_actions to apis_app;
