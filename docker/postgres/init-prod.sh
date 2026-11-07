#!/bin/sh
# First boot of the production Postgres volume: create the runtime login the
# app uses (member of app_user, so row-level security applies). app_user
# itself is created by the RLS migration; creating it here too is harmless.
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"
psql -v ON_ERROR_STOP=1 -v app_pw="$APP_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user NOLOGIN; END IF;
END $$;
SELECT format('CREATE ROLE postpilot_app LOGIN PASSWORD %L IN ROLE app_user', :'app_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postpilot_app')\gexec
SQL
