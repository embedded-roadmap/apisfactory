-- Geliştirme rolleri: apis_owner şemanın sahibidir (migration), apis_app çalışma zamanı rolüdür (RLS'e tabidir).
create role apis_owner login password 'owner_dev_pw';
create role apis_app login password 'app_dev_pw';
create database apisfactory owner apis_owner;
create database apisfactory_test owner apis_owner;
