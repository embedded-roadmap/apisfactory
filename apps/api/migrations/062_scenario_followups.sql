-- Oturum 41 devamı — R42: senaryoyu göreve / değişiklik talebine çevirme. Görev zaten entity_type/entity_id ile bağlanır
-- (tasks, 'scenario'); değişiklik talebine kaynak senaryo bağı eklenir (izlenebilirlik: hangi ne-olurdu hesabından doğdu).
alter table change_requests add column scenario_id uuid references scenarios(id);
create index change_requests_scenario_idx on change_requests (scenario_id) where scenario_id is not null;
