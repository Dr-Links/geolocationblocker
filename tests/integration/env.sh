#!/usr/bin/env bash
# Shared environment for integration tests (local development only).
# Starts the central app and a real WordPress on PHP's built-in server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${SP_IT_WORK:-/tmp/signalpost-it}"
CENTRAL_PORT="${SP_IT_CENTRAL_PORT:-8090}"
WP_PORT="${SP_IT_WP_PORT:-8091}"
CENTRAL_URL="http://127.0.0.1:${CENTRAL_PORT}"
WP_URL="http://localhost:${WP_PORT}"
WP_CORE="${SP_IT_WP_CORE:-/opt/wp-core}"
DB_USER="${SP_IT_DB_USER:-lc}"
DB_PASS="${SP_IT_DB_PASS:-lc_local_dev}"
CENTRAL_DB="${SP_IT_CENTRAL_DB:-lc_e2e_test}"
WP_DB="${SP_IT_WP_DB:-lc_wp_test}"
export SIGNALPOST_CONFIG="${WORK}/central-config.php"
WPCLI=(wp --allow-root --path="${WORK}/wp")

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

reset_env() {
  pkill -f "php -S 127.0.0.1:${CENTRAL_PORT}" 2>/dev/null || true
  pkill -f "php -S localhost:${WP_PORT}" 2>/dev/null || true
  rm -rf "${WORK}"; mkdir -p "${WORK}/storage/logs" "${WORK}/storage/mail"
  for db in "${CENTRAL_DB}" "${WP_DB}"; do
    mariadb -u"${DB_USER}" -p"${DB_PASS}" -h127.0.0.1 -e "DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  done
  cat > "${SIGNALPOST_CONFIG}" <<PHP
<?php
return [
  'app' => ['url' => '${CENTRAL_URL}', 'env' => 'development', 'key' => '$(php -r 'echo bin2hex(random_bytes(32));')'],
  'db' => ['host' => '127.0.0.1', 'name' => '${CENTRAL_DB}', 'user' => '${DB_USER}', 'password' => '${DB_PASS}'],
  'security' => ['force_https' => false],
  'mail' => ['transport' => 'file'],
  'paths' => ['storage' => '${WORK}/storage'],
];
PHP
  chmod 600 "${SIGNALPOST_CONFIG}"
  cp -r "${WP_CORE}" "${WORK}/wp"
  rm -rf "${WORK}/wp/.git"
  "${WPCLI[@]}" config create --dbname="${WP_DB}" --dbuser="${DB_USER}" --dbpass="${DB_PASS}" --dbhost=127.0.0.1 --skip-check --quiet
  "${WPCLI[@]}" core install --url="${WP_URL}" --title="Signalpost IT" --admin_user=admin --admin_password=admin-pass-123 --admin_email=admin@example.test --skip-email --quiet
  "${WPCLI[@]}" rewrite structure '/%postname%/' --quiet
}

start_servers() {
  (cd "${ROOT}/central" && php -S "127.0.0.1:${CENTRAL_PORT}" -t public bin/dev-router.php >"${WORK}/central-server.log" 2>&1 &)
  cat > "${WORK}/wp-router.php" <<'PHP'
<?php
$f = __DIR__ . '/wp' . parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (is_file($f) || (is_dir($f) && is_file($f . '/index.php'))) { return false; }
$_SERVER['SCRIPT_NAME'] = '/index.php';
require __DIR__ . '/wp/index.php';
PHP
  (php -S "localhost:${WP_PORT}" -t "${WORK}/wp" "${WORK}/wp-router.php" >"${WORK}/wp-server.log" 2>&1 &)
  for _ in $(seq 1 50); do
    if curl -fsS "${CENTRAL_URL}/api/v1/health" >/dev/null 2>&1 && curl -fsS -o /dev/null "${WP_URL}/" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  echo "servers did not start"; return 1
}

stop_servers() {
  pkill -f "php -S 127.0.0.1:${CENTRAL_PORT}" 2>/dev/null || true
  pkill -f "php -S localhost:${WP_PORT}" 2>/dev/null || true
}

helper() { php "${ROOT}/tests/integration/central-helper.php" "$@"; }
wpeval() { "${WPCLI[@]}" eval "$1"; }
