-- Oturum 41 (dış bağımlılık maddesi 2 — kargo): firmadan BAĞIMSIZ canlı altyapı.
-- Kargo firmaları arasında değişen şeyler adaptöre (lib/cargo-providers.ts) bırakılır: istenen erişim bilgisi alanları,
-- firmaya özel ayarlar (müşteri/sözleşme kodu, servis tipi, ödeme tipi), etiket biçimi (PDF/ZPL) ve takip durumu kodları.
-- Sistemin geri kalanı (hazırlık denetimi, şifreli erişim bilgisi, etiket saklama, normalize takip durumu) ortaktır.
-- Bağlayıcılar şirket başınadır: her şirket kendi kargo anlaşmasıyla çalışır.

alter table cargo_connectors drop constraint cargo_connectors_mode_check;
alter table cargo_connectors add constraint cargo_connectors_mode_check check (mode in ('not_connected', 'test', 'live'));
alter table cargo_connectors add column environment text check (environment in ('sandbox', 'production'));
alter table cargo_connectors add column credentials_enc text;
alter table cargo_connectors add column credentials_updated_by uuid references users(id);
alter table cargo_connectors add column credentials_updated_at timestamptz;
-- Gizli OLMAYAN, firmaya özel ayarlar (ör. servis tipi, ödeme tipi). Ekranda görünür, olay kaydına yazılır.
alter table cargo_connectors add column settings jsonb not null default '{}'::jsonb;
alter table cargo_connectors add constraint cargo_connectors_live_ready
  check (mode <> 'live' or (credentials_enc is not null and environment is not null));

-- Gönderici/alıcı iletişimi: kargo firmaları telefon ister.
alter table companies add column phone text;

-- Etiket ve takip: etiketin TEST mi CANLI mı üretildiği, firmanın döndürdüğü etiket dosyası (nesne depolamada),
-- firmadan bağımsız normalize takip durumu + firmanın ham durum metni.
alter table shipments add column cargo_label_mode text check (cargo_label_mode in ('test', 'live'));
alter table shipments add column label_object_key text;
alter table shipments add column label_content_type text check (label_content_type in ('application/pdf', 'application/zpl', 'image/png'));
alter table shipments add column cargo_status text
  check (cargo_status in ('created', 'in_transit', 'out_for_delivery', 'delivered', 'returned', 'problem', 'unknown'));
alter table shipments add column cargo_status_raw text;
alter table shipments add column cargo_status_at timestamptz;

-- Mevcut sentetik etiketler TEST olarak işaretlenir.
update shipments set cargo_label_mode = 'test' where cargo_connector_id is not null and label_ref is not null;
