-- W42: SaaS abonelik ve şirket yaşam döngüsü.
-- Kullanıcı kararı (2026-09-27): şirketler-arası (cross-tenant) yeni bir yetki sınırı AÇILMAZ. Her şirketin
-- kendi "manager"/"accounting" rolü YALNIZCA KENDİ şirketinin abonelik durumunu/paket hakkını görür ve
-- değiştirir. Platform işletmecisinin onayı pilot aşamasında manuel/DB üzerinden kalır — bu, ana talimat
-- dokümanının "İlk pilotta manuel abonelik/fatura/ödeme teyidiyle ilerlenebilir" ilkesiyle uyumludur.

-- Paket tanımları: platform genelinde paylaşılan, şirkete özgü olmayan referans veri. Uygulama üzerinden
-- oluşturulmaz/değiştirilmez (yalnızca okunur) — bu bilinçli bir kapsam sınırlaması: gerçek bir "platform
-- operatörü" arayüzü olmadığı için paket tanımları migration/DB üzerinden yönetilir (dürüstçe: "manuel").
create table subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  max_active_users int, -- null = sınırsız
  max_components int, -- null = sınırsız
  includes_ai boolean not null default false,
  includes_video boolean not null default false,
  created_at timestamptz not null default now()
);
grant select on subscription_plans to apis_app;

insert into subscription_plans (code, name, max_active_users, max_components, includes_ai, includes_video) values
  ('trial', 'Deneme', 5, 200, false, false),
  ('starter', 'Başlangıç', 15, 2000, false, true),
  ('growth', 'Büyüme', 50, null, true, true);

alter table companies add column subscription_plan_id uuid references subscription_plans(id);
alter table companies add column subscription_status text not null default 'trial'
  check (subscription_status in ('trial', 'active', 'delinquent', 'restricted', 'cancelled'));
alter table companies add column subscription_status_reason text;
alter table companies add column subscription_status_changed_at timestamptz not null default now();
alter table companies add column trial_ends_at date;

-- Mevcut (demo/pilot) şirketler boş pakette kalmasın: en geniş paket + aktif durum ile başlatılır.
-- Bu, üretim davranışını değiştirmez (yalnızca bilgilendirici bir alan; kısıtlama yalnızca 'restricted'
-- durumunda devreye girer — bkz. subscription.ts).
update companies set subscription_plan_id = (select id from subscription_plans where code = 'growth'),
                     subscription_status = 'active'
 where subscription_plan_id is null;

-- Yaşam döngüsü olay geçmişi (durum değişikliği, paket değişikliği, ödeme kaydı) — denetim izi.
-- Ödeme kaydında mükerrer işlenmeyi önlemek için mevcut genel idempotency_keys mekanizması kullanılır
-- (idempotency-key başlığı + idempotent() sarmalayıcı — rfq_award/wo_issue ile aynı, yeni bir mekanizma
-- icat edilmedi).
create table subscription_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies(id),
  event_type text not null check (event_type in ('status_changed', 'plan_changed', 'payment_recorded')),
  from_status text,
  to_status text,
  from_plan_id uuid references subscription_plans(id),
  to_plan_id uuid references subscription_plans(id),
  amount numeric(18, 6),
  currency char(3),
  reference text,
  note text,
  recorded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index subscription_events_company on subscription_events (company_id, created_at desc);
alter table subscription_events enable row level security;
alter table subscription_events force row level security;
create policy tenant_isolation on subscription_events using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert on subscription_events to apis_app;

-- Mevcut şirketlerin rolleri, kendi oluşturulma anındaki izin listesiyle sabitlenmiş; yeni izinler geriye
-- dönük olarak eklenmez. Bu yüzden yeni subscription.view/subscription.manage izinleri, DEFAULT_ROLES'teki
-- gibi manager/accounting'e (yönetim/muhasebe) ve subscription.view olarak admin'e (görünürlük, onay yetkisi
-- değil — "teknik yönetici iş kararı onaylayamaz" kuralına uyar) mevcut her şirket için ayrıca eklenir.
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm from roles r
      join (values ('manager', 'subscription.view'), ('manager', 'subscription.manage'),
                   ('accounting', 'subscription.view'), ('accounting', 'subscription.manage'),
                   ('admin', 'subscription.view')) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
