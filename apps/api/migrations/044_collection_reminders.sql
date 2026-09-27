-- R21: vadesi geçmiş açık bakiye için müşteriye veya muhasebeye tanımlı kuralla hatırlatma.
--
-- Ana talimat §17: "Vadesi geçmiş açık bakiye için müşteriye veya muhasebeye tanımlı kuralla
-- hatırlatma gönderilebilsin. Gönderimden hemen önce güncel bakiye ve ödeme durumu yeniden
-- doğrulansın. Sıklık limiti, alıcı, şablon, son hatırlatma ve durdurma koşulu olsun. Ödenmiş
-- faturaya gecikme bildirimi gitmesin."
--
-- Şirket başına tek bir kural (birden çok adlandırılmış kural istenmedi — basit ve denetlenebilir
-- tutuldu). Gerçek e-posta gönderimi yok (dış bağlayıcı yok, mevcut outbox test deseni kullanılır);
-- alıcı "muhasebe" ise iç görev açılır (mevcut po_followup/credit_note görev deseniyle aynı).

alter table customers add column billing_email text;

create table collection_reminder_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) unique,
  enabled boolean not null default false,
  min_overdue_days int not null default 1 check (min_overdue_days >= 0),
  frequency_days int not null default 7 check (frequency_days >= 1),
  recipient text not null default 'accounting' check (recipient in ('customer', 'accounting', 'both')),
  template text not null default '{musteri} - {fatura} numaralı fatura vadesi {gecikme} gündür geçti. Açık bakiye: {tutar} {para_birimi}. Vade tarihi: {vade}.',
  max_reminders int check (max_reminders is null or max_reminders >= 1),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

-- Durdurma koşulu: azami hatırlatma sayısına ulaşma (otomatik) veya elle duraklatma (ör. uyuşmazlık).
alter table customer_invoices add column last_reminder_at timestamptz;
alter table customer_invoices add column reminder_count int not null default 0;
alter table customer_invoices add column reminders_paused boolean not null default false;
alter table customer_invoices add column reminders_paused_reason text;

alter table collection_reminder_rules enable row level security;
alter table collection_reminder_rules force row level security;
create policy tenant_isolation on collection_reminder_rules using (company_id = app_company_id()) with check (company_id = app_company_id());
grant select, insert, update on collection_reminder_rules to apis_app;
