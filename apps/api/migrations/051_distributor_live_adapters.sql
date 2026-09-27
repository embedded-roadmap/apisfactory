-- Oturum 41 (dış bağımlılık maddesi 4 — distribütör API'leri): her şirket istediği distribütörü seçip kendi
-- geliştirici hesabıyla bağlayabilsin. Kargo/e-belge ile aynı desen: şirket başına şifreli erişim bilgisi,
-- distribütöre özel adaptör (lib/distributor-providers.ts), adaptörü olmayan distribütör 'live' moda alınamaz.
-- Mevcut önbellek (part_offers, TTL), günlük kota ve çağrı kaydı (connector_calls) canlı modda da aynen geçerlidir.

alter table distributor_connectors drop constraint distributor_connectors_mode_check;
alter table distributor_connectors add constraint distributor_connectors_mode_check check (mode in ('not_connected', 'test', 'price_file', 'live'));
alter table distributor_connectors add column environment text check (environment in ('sandbox', 'production'));
alter table distributor_connectors add column credentials_enc text;
alter table distributor_connectors add column credentials_updated_by uuid references users(id);
alter table distributor_connectors add column credentials_updated_at timestamptz;
alter table distributor_connectors add constraint distributor_connectors_live_ready
  check (mode <> 'live' or (credentials_enc is not null and environment is not null));

-- Canlı API'den gelen teklif: kaynağı 'api', source_ref distribütörün ürün bağlantısı/kimliği.
alter table part_offers drop constraint part_offers_source_check;
alter table part_offers add constraint part_offers_source_check check (source in ('test_connector', 'price_file', 'api'));
