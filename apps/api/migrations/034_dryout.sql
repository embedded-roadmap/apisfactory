-- Oturum 39 (W33 devamı, kullanıcının 2026-09-26 devam talimatı §12 sırası): kurutma/yeniden uygunluk
-- (bake-out) takibi. JEDEC J-STD-033 tablosu (MSL seviyesine göre standart sıcaklık/süre) burada
-- sabit kodlanmaz — cihaz kalınlığına ve üreticinin kendi prosedürüne göre değişir; bunun yerine şirketin
-- kalite ekibinin tanımlayıp onayladığı SÜRÜMLÜ bir "kurutma reçetesi" (cost_policies ile aynı desen:
-- sürümler değişmez, yeni sürüm eskisini geçersiz kılmaz) ve gerçek çevrim kaydı tutulur.

-- Bake-out fırını da bir ekipmandır: hizmet dışı/kalibrasyonu geçmiş fırınla çevrim başlatılamaz
-- (mevcut equipment/calibration_records altyapısı, T12'deki test ekipmanı kısıtıyla aynı desen).
alter table equipment drop constraint equipment_kind_check;
alter table equipment add constraint equipment_kind_check check (kind in ('test_station', 'measuring', 'fixture', 'programmer', 'oven'));

create table dryout_recipes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  version_no int not null,
  msl_level text check (msl_level is null or msl_level in ('1', '2', '2a', '3', '4', '5', '5a', '6')),
  item_id uuid references items(id), -- boşsa msl_level'e göre geneldir; doluysa yalnız bu kaleme özeldir
  temperature_c numeric(6, 2) not null check (temperature_c > 0),
  duration_hours numeric(8, 2) not null check (duration_hours > 0),
  source text not null, -- üreticinin datasheet/prosedür referansı (elle girilir, uydurulmaz)
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index dryout_recipes_company_idx on dryout_recipes (company_id, version_no desc);

-- Bir lotun kurutma çevrimi: başlar, biter (tamamlandı/yarıda kesildi), gerçekleşen sıcaklık/süre
-- kaydedilir (reçeteden farklı olabilir — uydurulmaz). Tamamlanan bir çevrim, kullanım süresi (floor
-- life) saatini sıfırlar (lots.floor_life_reset_at) — raf ömrünü (toplam maruziyet) DEĞİL.
create table dryout_cycles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  lot_id uuid not null references lots(id),
  recipe_id uuid not null references dryout_recipes(id),
  equipment_id uuid not null references equipment(id),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'aborted')),
  started_at timestamptz not null default now(),
  started_by uuid references users(id),
  ended_at timestamptz,
  ended_by uuid references users(id),
  actual_temperature_c numeric(6, 2),
  actual_duration_hours numeric(8, 2),
  note text
);
create unique index dryout_cycles_one_open_per_lot on dryout_cycles (lot_id) where status = 'in_progress';
create index dryout_cycles_lot_idx on dryout_cycles (company_id, lot_id, started_at desc);

alter table lots add column floor_life_reset_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['dryout_recipes', 'dryout_cycles'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on dryout_recipes, dryout_cycles to apis_app;
