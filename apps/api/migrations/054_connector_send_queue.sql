-- Oturum 41 (kalan işler 3): CANLI e-belge gönderimi ve kargo kaydı arka plana (outbox) taşındı. Dış çağrı artık istek
-- içinde, fatura/sevkiyat satırı kilitliyken yapılmaz. Resmi belge / ücretli kargo kaydı çift oluşmasın diye durum
-- makinesi: queued → sending → sent|created | failed (sağlayıcı kesin reddetti — hiçbir şey oluşmadı, yeniden
-- gönderilebilir) | unknown (zaman aşımı/ağ/5xx — oluşup oluşmadığı belirsiz; OTOMATİK TEKRAR YOK, kullanıcı sağlayıcı
-- panelinden doğrulayıp sonucu elle işaretler).

alter table customer_invoices add column einvoice_status text check (einvoice_status in ('queued', 'sending', 'sent', 'failed', 'unknown'));
alter table customer_invoices add column einvoice_error text;
alter table customer_invoices add column einvoice_requested_by uuid references users(id);
alter table customer_invoices add column einvoice_requested_at timestamptz;
update customer_invoices set einvoice_status = 'sent' where einvoice_sent_at is not null;

alter table shipments add column cargo_request_status text check (cargo_request_status in ('queued', 'sending', 'created', 'failed', 'unknown'));
alter table shipments add column cargo_request_error text;
alter table shipments add column cargo_requested_by uuid references users(id);
alter table shipments add column cargo_requested_at timestamptz;
update shipments set cargo_request_status = 'created' where tracking_no is not null and cargo_connector_id is not null;
