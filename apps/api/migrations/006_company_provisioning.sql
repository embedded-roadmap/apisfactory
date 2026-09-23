-- Şirket açma platform işlemidir (SaaS yaşam döngüsü, W42): şema sahibi rolü sağlar.
-- Uygulama rolü için görünürlük politikası aynen geçerlidir.
alter table companies no force row level security;
