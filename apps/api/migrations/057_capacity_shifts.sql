-- Oturum 41 (kalan işler 7c) — R29: kaynak kapasitesi ve vardiya.
-- Önce: her iş merkezinin sabit günlük dakikası (hafta içi) ve şirket tatilleri. Şimdi: vardiya şablonları, iş
-- merkezine tarih aralıklı vardiya ataması (paralel istasyon sayısıyla) ve tarihli kapasite istisnaları. Vardiya
-- ataması olmayan merkezde eski davranış (hafta içi × daily_minutes) aynen sürer.

create table shift_patterns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  name text not null,
  start_time time not null,
  end_time time not null,             -- başlangıçtan küçük/eşitse gece yarısını geçer (başladığı güne sayılır)
  break_minutes int not null default 0 check (break_minutes >= 0 and break_minutes < 1440),
  weekdays smallint[] not null check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

-- Atama: geçerlilik aralığı değişmez başlar; yalnız bitiş tarihi (valid_to) sonradan verilebilir (atamayı sonlandırma).
create table work_center_shifts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  work_center_id uuid not null references work_centers(id),
  shift_pattern_id uuid not null references shift_patterns(id),
  stations int not null default 1 check (stations between 1 and 100),
  valid_from date not null,
  valid_to date,
  reason text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  ended_by uuid references users(id),
  check (valid_to is null or valid_to >= valid_from)
);
create index work_center_shifts_wc_idx on work_center_shifts (work_center_id, valid_from);

-- İstisna: bir gün için kapasiteye eklenen (fazla mesai) veya düşülen (bakım, arıza, eğitim) dakika. İş merkezi boşsa
-- tüm merkezlere uygulanır. Değişmez; düzeltme ters işaretli yeni kayıtla.
create table capacity_exceptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  work_center_id uuid references work_centers(id),
  day date not null,
  minutes_delta int not null check (minutes_delta <> 0 and abs(minutes_delta) <= 14400),
  reason text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create trigger capacity_exceptions_append_only before update or delete on capacity_exceptions for each row execute function forbid_mutation();
create index capacity_exceptions_day_idx on capacity_exceptions (company_id, day);

do $$
declare t text;
begin
  foreach t in array array['shift_patterns', 'work_center_shifts', 'capacity_exceptions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert on shift_patterns, capacity_exceptions to apis_app;
grant select, insert on work_center_shifts to apis_app;
grant update (valid_to, ended_by) on work_center_shifts to apis_app;
