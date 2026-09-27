-- Oturum 41 (dış bağımlılık maddesi 1 — e-fatura hazırlığı): sağlayıcıdan BAĞIMSIZ ön koşullar.
--  1) Vergi kimliği: hangi entegratör seçilirse seçilsin e-fatura/e-arşiv, satıcının (şirket) ve alıcının (müşteri)
--     VKN/TCKN'si, vergi dairesi ve resmi unvanı olmadan düzenlenemez. Bu alanlar daha önce hiç tutulmuyordu.
--     Biçim kısıtı burada (10 veya 11 hane); kontrol hanesi doğrulaması uygulamada (lib/tax-id.ts).
--  2) Canlı bağlayıcı altyapısı: bağlayıcılar şirket başınadır (çok kiracılı) — her şirket kendi entegratörüyle
--     sözleşme yapar, bu yüzden erişim bilgileri platform ortam değişkeninde DEĞİL, bağlayıcı satırında şifreli
--     (AES-256-GCM, anahtar CONNECTOR_SECRET_KEY) tutulur. Düz metin hiçbir uçtan geri döndürülmez.
--     'live' modu şemada tanımlıdır ama uygulama, o sağlayıcı için gerçek bir adaptör geliştirilmeden bu moda
--     geçişe izin vermez (sahte "bağlandı" durumu üretilmez).

alter table companies add column legal_name text;
alter table companies add column tax_no text check (tax_no ~ '^[0-9]{10,11}$');
alter table companies add column tax_office text;
alter table companies add column address_line text;
alter table companies add column district text;
alter table companies add column city text;
alter table companies add column postal_code text;
alter table companies add column country char(2) not null default 'TR';

alter table customers add column legal_name text;
alter table customers add column tax_no text check (tax_no ~ '^[0-9]{10,11}$');
alter table customers add column tax_office text;

alter table einvoice_connectors drop constraint einvoice_connectors_mode_check;
alter table einvoice_connectors add constraint einvoice_connectors_mode_check check (mode in ('not_connected', 'test', 'live'));
alter table einvoice_connectors add column environment text check (environment in ('sandbox', 'production'));
alter table einvoice_connectors add column credentials_enc text;
alter table einvoice_connectors add column credentials_updated_by uuid references users(id);
alter table einvoice_connectors add column credentials_updated_at timestamptz;
-- Canlı mod, kayıtlı erişim bilgisi ve ortam seçimi olmadan açılamaz.
alter table einvoice_connectors add constraint einvoice_connectors_live_ready
  check (mode <> 'live' or (credentials_enc is not null and environment is not null));

alter table customer_invoices drop constraint customer_invoices_document_mode_check;
alter table customer_invoices add constraint customer_invoices_document_mode_check check (document_mode in ('draft', 'test', 'live'));
