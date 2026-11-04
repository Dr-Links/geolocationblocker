#!/usr/bin/env bash
# Smoke test of the server image: creates a database and users, migrates, starts the API with the web app,
# and checks the important responses. Usage: deploy/server/smoke-test.sh <image> (PG* variables: a superuser).
set -euo pipefail
IMAGE=${1:-allwebmails:latest}
export PGHOST=${PGHOST:-localhost} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
DB=awm_smoke
PORT=${SMOKE_PORT:-3900}
WORK=$(mktemp -d)
cleanup() { docker rm -f awm-smoke >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

psql -v ON_ERROR_STOP=1 -q postgres <<SQL
DROP DATABASE IF EXISTS $DB WITH (FORCE);
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smoke_owner') THEN CREATE ROLE smoke_owner LOGIN PASSWORD 'smoke-owner-pw'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smoke_auth') THEN CREATE ROLE smoke_auth LOGIN NOINHERIT PASSWORD 'smoke-pw'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smoke_api') THEN CREATE ROLE smoke_api LOGIN NOINHERIT PASSWORD 'smoke-pw'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smoke_admin') THEN CREATE ROLE smoke_admin LOGIN NOINHERIT PASSWORD 'smoke-pw'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smoke_worker') THEN CREATE ROLE smoke_worker LOGIN NOINHERIT PASSWORD 'smoke-pw'; END IF;
END \$\$;
CREATE DATABASE $DB OWNER smoke_owner;
SQL

mkdir -p "$WORK/secrets"
openssl rand -base64 32 > "$WORK/secrets/credential_key"
openssl genpkey -algorithm ed25519 -out "$WORK/secrets/jwt.pem"
chmod 644 "$WORK/secrets/"*
cat > "$WORK/env" <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
PUBLIC_API_URL=http://127.0.0.1:$PORT
ADMIN_WEB_URL=http://127.0.0.1:3901
DB_HOST=$PGHOST
DB_PORT=$PGPORT
DB_NAME=$DB
DB_USER_OWNER=smoke_owner
DB_USER_AUTH=smoke_auth
DB_USER_API=smoke_api
DB_USER_ADMIN=smoke_admin
DB_USER_WORKER=smoke_worker
DB_PASSWORD_OWNER=smoke-owner-pw
DB_PASSWORD_AUTH=smoke-pw
DB_PASSWORD_API=smoke-pw
DB_PASSWORD_ADMIN=smoke-pw
DB_PASSWORD_WORKER=smoke-pw
CREDENTIAL_KEY_FILE=/run/secrets/credential_key
JWT_PRIVATE_KEY_FILE=/run/secrets/jwt.pem
SMTP_HOST=127.0.0.1
SMTP_PORT=2525
SMTP_FROM=no-reply@smoke.test
ENV
run() { docker run --rm --network host --env-file "$WORK/env" -v "$WORK/secrets:/run/secrets:ro" "$IMAGE" "$@"; }

run node dist/cli.js db:migrate
docker run -d --name awm-smoke --network host --env-file "$WORK/env" -v "$WORK/secrets:/run/secrets:ro" "$IMAGE" >/dev/null
for i in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 1; done

fail() { echo "SMOKE TEST FAILED: $*"; docker logs awm-smoke | tail -30; exit 1; }
curl -fs "http://127.0.0.1:$PORT/healthz" | grep -q '"ok":true' || fail "healthz"
curl -fs "http://127.0.0.1:$PORT/readyz" | grep -q '"db":"ok"' || fail "readyz (database)"
curl -fsI "http://127.0.0.1:$PORT/" | grep -qi "content-security-policy: default-src 'self'" || fail "web app CSP header"
curl -fs "http://127.0.0.1:$PORT/inbox" | grep -q 'id="root"' || fail "web app route"
curl -fs "http://127.0.0.1:$PORT/manifest.webmanifest" | grep -q AllWebMails || fail "manifest"
curl -fs "http://127.0.0.1:$PORT/sw.js" | grep -q showNotification || fail "service worker"
curl -s "http://127.0.0.1:$PORT/v1/me" | grep -q unauthorized || fail "API auth"
[ "$(docker exec awm-smoke id -u)" != "0" ] || fail "container runs as root"
if [ "${SKIP_PG_CLIENT:-0}" != "1" ]; then docker exec awm-smoke /usr/lib/postgresql/17/bin/pg_dump --version | grep -q 17 || fail "pg_dump"; fi
echo "SMOKE TEST PASSED"
