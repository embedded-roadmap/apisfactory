#!/bin/sh
# İlk açılışta (boş veri dizini) bir kez çalışır. Roller: apis_owner şemanın sahibi (migration, işçi, yedek),
# apis_app çalışma zamanı rolü (RLS'e tabi, BYPASSRLS yok). Parolalar .env'den gelir; burada sabit parola yoktur.
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD gerekli}"
: "${OWNER_DB_PASSWORD:?OWNER_DB_PASSWORD gerekli}"

psql -v ON_ERROR_STOP=1 --username postgres \
  -v app_pw="$APP_DB_PASSWORD" -v owner_pw="$OWNER_DB_PASSWORD" <<'SQL'
create role apis_owner login password :'owner_pw';
create role apis_app login password :'app_pw' nobypassrls;
create database apisfactory owner apis_owner;
SQL
