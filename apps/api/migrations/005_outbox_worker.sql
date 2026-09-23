-- Çıkış kutusu işleyicisi şema sahibi rolüyle tüm şirketlerin kuyruğunu işler; bu tabloda RLS sahibi bağlamaz.
-- Uygulama rolü (apis_app) için şirket politikası geçerliliğini korur.
alter table outbox no force row level security;
