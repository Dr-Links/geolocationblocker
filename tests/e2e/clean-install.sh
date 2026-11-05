#!/usr/bin/env bash
# Clean-install test of the packaged artifacts:
#  - extracts dist/signalpost-central-*.zip into an empty directory
#  - configures it as documented in docs/INSTALL.md and runs the web installer in a browser
#  - installs dist/signalpost-connector-*.zip through WordPress's "Upload Plugin" screen
set -euo pipefail
source "$(dirname "$0")/../integration/env.sh"
cd "$(dirname "$0")"
[ -d node_modules/playwright ] || npm install --no-audit --no-fund >/dev/null

bash "${ROOT}/build/build.sh" >/dev/null
# LAYOUT=cpanel (default): docroot = signalpost/public.  LAYOUT=hostinger: docroot = public_html, app in sibling signalpost/.
LAYOUT="${LAYOUT:-cpanel}"
CENTRAL_ZIP=$(ls "${ROOT}"/dist/signalpost-central-*.zip)
HOSTINGER_ZIP=$(ls "${ROOT}"/dist/alllivechats-hostinger-*.zip)
PLUGIN_ZIP=$(ls "${ROOT}"/dist/signalpost-connector-*.zip)

reset_env                      # fresh databases + fresh WordPress (no plugin installed)
rm -f "${SIGNALPOST_CONFIG}"; unset SIGNALPOST_CONFIG
APPDIR="${WORK}/hosting"
mkdir -p "${APPDIR}"
APP="${APPDIR}/signalpost"
if [ "${LAYOUT}" = "hostinger" ]; then
  unzip -q "${HOSTINGER_ZIP}" -d "${APPDIR}"
  DOCROOT="${APPDIR}/public_html"
  export CONFIG_TEMPLATE="config.alllivechats.example.php"
else
  unzip -q "${CENTRAL_ZIP}" -d "${APPDIR}"
  DOCROOT="${APP}/public"
  export CONFIG_TEMPLATE="config.example.php"
fi
# Simulates the server's .htaccess rewrite for PHP's built-in server (test only, not packaged).
cat > "${WORK}/central-router.php" <<PHP
<?php
\$f = '${DOCROOT}' . parse_url(\$_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (is_file(\$f) && !str_ends_with(\$f, '.php')) { return false; }
\$_SERVER['SCRIPT_NAME'] = '/index.php';
require '${DOCROOT}/index.php';
PHP

pkill -f "php -S 127.0.0.[1]:${CENTRAL_PORT}" 2>/dev/null || true
(php -S "127.0.0.1:${CENTRAL_PORT}" -t "${DOCROOT}" "${WORK}/central-router.php" >"${WORK}/central-server.log" 2>&1 &)
cat > "${WORK}/wp-router.php" <<'PHP'
<?php
$f = __DIR__ . '/wp' . parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (is_file($f) || (is_dir($f) && is_file($f . '/index.php'))) { return false; }
$_SERVER['SCRIPT_NAME'] = '/index.php';
require __DIR__ . '/wp/index.php';
PHP
(php -S "localhost:${WP_PORT}" -t "${WORK}/wp" "${WORK}/wp-router.php" >"${WORK}/wp-server.log" 2>&1 &)
trap stop_servers EXIT
for _ in $(seq 1 50); do curl -s -o /dev/null "${CENTRAL_URL}/" && curl -s -o /dev/null "${WP_URL}/" && break; sleep 0.2; done

export APP CENTRAL_URL WP_URL PLUGIN_ZIP CENTRAL_DB DB_USER DB_PASS
node clean-install.mjs
