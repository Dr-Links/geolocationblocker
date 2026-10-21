#!/usr/bin/env bash
# Builds the deployable packages and verifies their contents.
#   dist/signalpost-central-<version>.zip    (folder: signalpost/)
#   dist/signalpost-connector-<version>.zip  (folder: signalpost-connector/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${ROOT}/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

CENTRAL_VERSION=$(php -r "preg_match(\"/SIGNALPOST_VERSION', '([^']+)'/\", file_get_contents('${ROOT}/central/bootstrap.php'), \$m); echo \$m[1];")
PLUGIN_VERSION=$(sed -n 's/^ \* Version: *//p' "${ROOT}/wordpress-plugin/signalpost-connector/signalpost-connector.php" | tr -d '[:space:]')
PLUGIN_CONST=$(sed -n "s/.*SIGNALPOST_CONNECTOR_VERSION', '\([^']*\)'.*/\1/p" "${ROOT}/wordpress-plugin/signalpost-connector/signalpost-connector.php")
STABLE_TAG=$(sed -n 's/^Stable tag: *//p' "${ROOT}/wordpress-plugin/signalpost-connector/readme.txt" | tr -d '[:space:]')

fail() { echo "BUILD FAILED: $*" >&2; exit 1; }
[ -n "${CENTRAL_VERSION}" ] || fail "cannot read central version"
[ "${PLUGIN_VERSION}" = "${PLUGIN_CONST}" ] || fail "plugin header version ${PLUGIN_VERSION} != constant ${PLUGIN_CONST}"
[ "${PLUGIN_VERSION}" = "${STABLE_TAG}" ] || fail "plugin version ${PLUGIN_VERSION} != readme stable tag ${STABLE_TAG}"

mkdir -p "${DIST}"
echo "== Central application ${CENTRAL_VERSION}"
APP="${STAGE}/signalpost"
mkdir -p "${APP}"
# Runtime files only. Development tooling, tests, vendor and local secrets are excluded.
( cd "${ROOT}/central" && tar cf - \
    --exclude='./vendor' --exclude='./tests' --exclude='./.phpunit.cache' \
    --exclude='./composer.json' --exclude='./composer.lock' --exclude='./phpunit.xml' \
    --exclude='./config/config.php' --exclude='./storage/setup-token.txt' \
    --exclude='./storage/logs/*.log' --exclude='./storage/mail/*.eml' --exclude='./storage/cache/*.lock' \
    --exclude='./bin/dev-router.php' \
    . ) | ( cd "${APP}" && tar xf - )
mkdir -p "${APP}/docs"
cp "${ROOT}"/docs/*.md "${APP}/docs/"
cp "${ROOT}/README.md" "${APP}/README.md"
printf 'Require all denied\n' > "${APP}/docs/.htaccess"

echo "-- verifying central package"
for f in public/index.php public/.htaccess .htaccess bootstrap.php routes.php bin/console config/config.example.php \
         public/widget/v1/widget.js public/widget/v1/widget.css public/assets/app.css public/assets/app.js \
         public/assets/inbox.js public/assets/live.js storage/logs/.gitkeep config/.htaccess storage/.htaccess src/.htaccess; do
  [ -e "${APP}/${f}" ] || fail "missing ${f}"
done
[ ! -e "${APP}/config/config.php" ] || fail "config.php must not be packaged"
[ ! -e "${APP}/vendor" ] || fail "vendor/ must not be packaged"
[ ! -e "${APP}/tests" ] || fail "tests/ must not be packaged"
[ -z "$(find "${APP}" -name '*.log' -o -name 'setup-token.txt' -o -name '*.eml')" ] || fail "runtime files leaked into package"
MIGS=$(ls "${APP}/migrations"/[0-9]*.php | wc -l); [ "${MIGS}" -ge 6 ] || fail "migrations missing"
while IFS= read -r -d '' php; do php -l "$php" >/dev/null || fail "syntax error in ${php#${STAGE}/}"; done < <(find "${APP}" -name '*.php' -print0)
# No credentials or keys in the package (the example config has an empty key and password).
if grep -rEn "spk_[0-9a-f]{12}\.[A-Za-z0-9_-]{43}|'key' => '[0-9a-f]{64}'" "${APP}"; then
  fail "possible credential or application key found in package"
fi
if grep -En "'password' => '[^']+'" "${APP}"/config/*.php; then
  fail "configuration in package contains a password"
fi
grep -q "'key' => ''" "${APP}/config/config.example.php" || fail "example config must not contain a key"
CENTRAL_ZIP="${DIST}/signalpost-central-${CENTRAL_VERSION}.zip"
rm -f "${CENTRAL_ZIP}"
( cd "${STAGE}" && zip -qrX "${CENTRAL_ZIP}" signalpost )
echo "   $(unzip -l "${CENTRAL_ZIP}" | tail -1 | awk '{print $2}') files"

echo "== WordPress plugin ${PLUGIN_VERSION}"
PLUG="${STAGE}/signalpost-connector"
cp -r "${ROOT}/wordpress-plugin/signalpost-connector" "${PLUG}"
for f in signalpost-connector.php uninstall.php readme.txt includes/class-signalpost-admin.php includes/class-signalpost-api.php \
         includes/class-signalpost-connection.php includes/class-signalpost-frontend.php includes/class-signalpost-store.php assets/admin.css index.php; do
  [ -e "${PLUG}/${f}" ] || fail "plugin missing ${f}"
done
while IFS= read -r -d '' php; do php -l "$php" >/dev/null || fail "syntax error in ${php#${STAGE}/}"; done < <(find "${PLUG}" -name '*.php' -print0)
grep -q "defined( 'ABSPATH' )" "${PLUG}/includes/class-signalpost-admin.php" || fail "ABSPATH guard missing"
PLUGIN_ZIP="${DIST}/signalpost-connector-${PLUGIN_VERSION}.zip"
rm -f "${PLUGIN_ZIP}"
( cd "${STAGE}" && zip -qrX "${PLUGIN_ZIP}" signalpost-connector )
echo "   $(unzip -l "${PLUGIN_ZIP}" | tail -1 | awk '{print $2}') files"

( cd "${DIST}" && sha256sum "$(basename "${CENTRAL_ZIP}")" "$(basename "${PLUGIN_ZIP}")" > SHA256SUMS )
echo "== Done"
cat "${DIST}/SHA256SUMS"
