-- Oturum 41 devamı — toplantı çevrim içi bağlantısı (dış bağımlılık maddesi 6, kullanıcı kararı: kendi görüntülü görüşme
-- altyapısı yok; Teams / Google Meet / Zoom toplantısı açılıp bağlantısı toplantı kaydına eklenir).
-- online_auto: düzenleyenin bağlı takvimi uygunsa (Google → Meet, Microsoft → Teams) bağlantı takvime yazılırken otomatik
-- oluşturulur; Zoom ve "diğer" için bağlantı elle girilir.
alter table meetings add column online_provider text check (online_provider in ('teams', 'meet', 'zoom', 'other'));
alter table meetings add column online_url text check (online_url is null or online_url ~ '^https://');
alter table meetings add column online_auto boolean not null default false;
alter table meetings add constraint meetings_online_auto_provider check (not online_auto or online_provider in ('teams', 'meet'));
