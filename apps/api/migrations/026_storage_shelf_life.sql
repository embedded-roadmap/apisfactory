-- W33: MSL, raf ömrü, ambalaj ve koşul (prompt §14 — "İlgili malzemelerde MSL, paket açılış zamanı,
-- kullanım ortamı/süresi, raf ömrü ve saklama şartları bulunsun... AI süre uydurmasın.").
-- Bütün alanlar isteğe bağlıdır; gereksiz alanlar bütün parçalara zorunlu tutulmaz.

alter table items
  add column msl_level text check (msl_level is null or msl_level in ('1', '2', '2a', '3', '4', '5', '5a', '6')),
  add column floor_life_hours int check (floor_life_hours is null or floor_life_hours > 0),  -- paket açıldıktan sonra kullanım süresi
  add column shelf_life_days int check (shelf_life_days is null or shelf_life_days > 0),      -- kapalı paket raf ömrü
  add column storage_condition text,                                                          -- örn. "≤10°C, kuru dolap"
  add column issue_policy text not null default 'fifo' check (issue_policy in ('fifo', 'fefo'));

alter table lots
  add column mfg_date date,
  add column expires_at timestamptz,   -- mal kabulde/üretimde elle girilir; AI hesaplamaz
  add column opened_at timestamptz,
  add column opened_by uuid references users(id);

create index lots_expires_idx on lots (company_id, item_id, expires_at) where expires_at is not null;
