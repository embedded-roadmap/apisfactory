-- Oturum 38 (W30, kullanıcının 2026-09-26 devam talimatı §6/§7): yönetici raporları + stratejik AI
-- bulgu/öneri altyapısı (W31'in öneri→görev→ölçüm akışının temeli).
--
-- `report_findings`: her üretilen bulgunun sabit bir kopyası (hesaplama tekrar çalıştırıldığında
-- eski bulgu değişmez — "hesaplama sürümü" ayrı sütunla izlenir). `cause_type` asla 'confirmed'
-- olarak makine tarafından üretilmez (bkz. lib/report-findings.ts) — yalnız 'hypothesis' veya
-- 'insufficient_data'; "doğrulanmış neden" insan kararı gerektirir (talimat §6).
create table report_findings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  area text not null check (area in (
    'fire_rework', 'cost_margin', 'supplier_performance', 'stock_shortage',
    'capacity_leadtime', 'revision_impact', 'project_budget', 'collections'
  )),
  period_kind text not null check (period_kind in ('weekly', 'monthly', 'yearly')),
  period_from date not null,
  period_to date not null,
  scope jsonb not null default '{}'::jsonb,
  calc_version int not null default 1,
  finding text not null,
  evidence jsonb not null,
  source_refs jsonb not null default '[]'::jsonb,
  cause_type text not null check (cause_type in ('hypothesis', 'insufficient_data')),
  cause_text text,
  action_options jsonb not null default '[]'::jsonb,
  expected_impact jsonb,
  uncertainty text,
  responsible_role text not null,
  requires_approval boolean not null default true,
  success_metric text not null,
  measurement_due_at date,
  -- 'unavailable': bu oturumda hiçbir LLM/AI sağlayıcısı yapılandırılmadı (dış bağımlılık) —
  -- yukarıdaki alanlar kural tabanlı (deterministik) üretildi, serbest metin bir AI yorumu değil.
  ai_status text not null default 'unavailable' check (ai_status in ('unavailable', 'generated')),
  ai_narrative text,
  generated_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index report_findings_company_area_idx on report_findings (company_id, area, created_at desc);

-- W31: bir bulgunun insan kararıyla göreve dönüşmesi ve etkisinin ayrı ölçülmesi.
create table ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  finding_id uuid not null references report_findings(id),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'deferred', 'closed')),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_reason text,
  baseline_metric text,
  baseline_value numeric(18, 6),
  baseline_scope jsonb,
  target_value numeric(18, 6),
  measurement_interval_days int,
  data_source text,
  implementation_cost numeric(18, 6),
  task_id uuid references tasks(id),
  measured_value numeric(18, 6),
  measured_at timestamptz,
  measured_by uuid references users(id),
  -- Bağımsız doğrulama: measured_by ile aynı kişi olamaz (uygulama katmanında zorlanır).
  verified_by uuid references users(id),
  closed_at timestamptz,
  reopened_count int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index ai_suggestions_company_idx on ai_suggestions (company_id, status);

do $$
declare t text;
begin
  foreach t in array array['report_findings', 'ai_suggestions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on report_findings, ai_suggestions to apis_app;
