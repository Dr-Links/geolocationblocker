#!/usr/bin/env bash
# Browser end-to-end test: real WordPress + Signalpost Connector + central app + Chromium.
set -euo pipefail
source "$(dirname "$0")/../integration/env.sh"
cd "$(dirname "$0")"
[ -d node_modules/playwright ] || npm install --no-audit --no-fund >/dev/null

reset_env
ln -s "${ROOT}/wordpress-plugin/signalpost-connector" "${WORK}/wp/wp-content/plugins/signalpost-connector"
"${WPCLI[@]}" plugin activate signalpost-connector --quiet
start_servers
trap stop_servers EXIT

SETUP=$(helper setup "${WP_URL}")
export SITE_ID=$(echo "$SETUP" | php -r 'echo json_decode(stream_get_contents(STDIN), true)["website_id"];')
export WS_ID=$(echo "$SETUP" | php -r 'echo json_decode(stream_get_contents(STDIN), true)["workspace_id"];')
export PAIRING_CODE=$(helper pairing-code "$SITE_ID")
export CENTRAL_URL WP_URL ROOT
export HELPER="php ${ROOT}/tests/integration/central-helper.php"
export WPCLI_CMD="wp --allow-root --path=${WORK}/wp"
mkdir -p artifacts
node run.mjs
