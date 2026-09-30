-- Oturum 41 devamı — dış bağımlılık 1a/2a (kullanıcı kararı: müşteri hangi entegratörü/kargoyu kullanırsa seçebilsin).
-- API adaptörü olmayan her sağlayıcı için elle çalışan, RESMİ sonuç üreten yollar:
--  * E-belge "portal" modu: uygulama UBL-TR XML'ini üretir, kullanıcı entegratörünün web portalına yükler, portalın verdiği
--    ETTN (ve fatura no) uygulamaya girilir → belge CANLI sayılır. Ara durum: einvoice_status = 'portal_pending'.
--  * Kargo "manual" modu: kayıt firmanın kendi sisteminde/şubesinde açılır, takip no uygulamaya girilir; durum elle güncellenir,
--    şirket isterse firmanın takip sayfası şablonunu ({no}) tanımlar.
--  * Listede olmayan sağlayıcı şirket tarafından eklenebilir (is_custom; anahtar custom_…).

alter table einvoice_connectors drop constraint einvoice_connectors_key_check;
alter table einvoice_connectors add constraint einvoice_connectors_key_check check (key ~ '^[a-z0-9_]{2,40}$');
alter table einvoice_connectors add column is_custom boolean not null default false;
alter table einvoice_connectors drop constraint einvoice_connectors_mode_check;
alter table einvoice_connectors add constraint einvoice_connectors_mode_check check (mode in ('not_connected', 'test', 'portal', 'live'));

alter table cargo_connectors drop constraint cargo_connectors_key_check;
alter table cargo_connectors add constraint cargo_connectors_key_check check (key ~ '^[a-z0-9_]{2,40}$');
alter table cargo_connectors add column is_custom boolean not null default false;
alter table cargo_connectors drop constraint cargo_connectors_mode_check;
alter table cargo_connectors add constraint cargo_connectors_mode_check check (mode in ('not_connected', 'test', 'manual', 'live'));
alter table cargo_connectors add column tracking_url_template text
  check (tracking_url_template is null or (tracking_url_template ~ '^https://[^\s]+$' and position('{no}' in tracking_url_template) > 0));

alter table customer_invoices drop constraint customer_invoices_einvoice_status_check;
alter table customer_invoices add constraint customer_invoices_einvoice_status_check
  check (einvoice_status in ('queued', 'sending', 'portal_pending', 'sent', 'failed', 'unknown'));
alter table customer_invoices add column einvoice_number text check (einvoice_number ~ '^[A-Z0-9]{3}[0-9]{13}$');

alter table shipments drop constraint shipments_cargo_label_mode_check;
alter table shipments add constraint shipments_cargo_label_mode_check check (cargo_label_mode in ('test', 'manual', 'live'));
