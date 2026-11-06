-- Runs once when the docker-compose postgres volume is first created.
-- The app connects as `postpilot_app` (member of `app_user`, NOT a superuser)
-- so row-level security is enforced. Migrations run as the `postgres` owner.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postpilot_app') THEN
    CREATE ROLE postpilot_app LOGIN PASSWORD 'postpilot_app' IN ROLE app_user;
  END IF;
END
$$;
SELECT 'CREATE DATABASE socialai_test' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'socialai_test')\gexec
