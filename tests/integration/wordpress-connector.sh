#!/usr/bin/env bash
# Integration test: real WordPress + Signalpost Connector + central app.
set -euo pipefail
source "$(dirname "$0")/env.sh"

echo "== Preparing environment"
reset_env
ln -s "${ROOT}/wordpress-plugin/signalpost-connector" "${WORK}/wp/wp-content/plugins/signalpost-connector"
start_servers
trap stop_servers EXIT

SETUP=$(helper setup "${WP_URL}")
SITE_ID=$(echo "$SETUP" | php -r 'echo json_decode(stream_get_contents(STDIN), true)["website_id"];')

echo "== Activation and safe disconnected state"
"${WPCLI[@]}" plugin activate signalpost-connector --quiet
check "plugin active" '"${WPCLI[@]}" plugin is-active signalpost-connector'
HTML=$(curl -fsS "${WP_URL}/")
check "no widget before pairing" '! grep -q "SignalpostConfig" <<<"$HTML"'

echo "== Pairing"
BAD=$(wpeval 'var_export(is_wp_error(Signalpost_Connection::pair("'"${CENTRAL_URL}"'", "AAAA-BBBB-CCCC-DDDD")));')
check "invalid pairing code rejected" '[ "$BAD" = "true" ]'
CODE=$(helper pairing-code "$SITE_ID")
RES=$(wpeval 'var_export(Signalpost_Connection::pair("'"${CENTRAL_URL}"'", "'"${CODE}"'"));')
check "pairing succeeds" '[ "$RES" = "true" ]'
STATUS=$(helper query "SELECT status FROM websites WHERE id = ${SITE_ID}")
check "central marks website connected" 'grep -q connected <<<"$STATUS"'
CRED=$(wpeval 'echo get_option("signalpost_credential");')
check "credential stored locally" '[[ "$CRED" =~ ^spk_[0-9a-f]{12}\. ]]'
AUTOLOAD=$("${WPCLI[@]}" db query "SELECT autoload FROM wp_options WHERE option_name='signalpost_credential'" --skip-column-names)
check "credential option not autoloaded" '[[ "$AUTOLOAD" =~ ^(no|off)$ ]]'

echo "== Front-end output"
HTML=$(curl -fsS "${WP_URL}/")
check "widget script enqueued from central" 'grep -q "${CENTRAL_URL}/widget/v1/widget.js" <<<"$HTML"'
check "client config printed" 'grep -q "window.SignalpostConfig" <<<"$HTML"'
SECRET="${CRED#*.}"
check "secret extracted for checks" '[ ${#SECRET} -eq 43 ]'
check "secret never in HTML" '! grep -qF -- "$SECRET" <<<"$HTML"'
check "no credential prefix in HTML" '! grep -q "spk_" <<<"$HTML"'
check "analytics disabled by default in config" 'grep -q "\"analyticsEnabled\":false" <<<"$HTML"'

echo "== Hidden paths and builder previews"
helper settings "$SITE_ID" widget '{"hidden_paths":["/sample-page"]}' >/dev/null
wpeval 'Signalpost_Connection::refresh();'
PAGE=$(curl -fsS "${WP_URL}/sample-page/")
check "sample page rendered" 'grep -qi "sample page" <<<"$PAGE"'
check "widget hidden on configured path" '! grep -q "SignalpostConfig" <<<"$PAGE"'
HOME_HTML=$(curl -fsS "${WP_URL}/")
check "widget still on home page" 'grep -q "SignalpostConfig" <<<"$HOME_HTML"'
PREVIEW=$(curl -fsS "${WP_URL}/?elementor-preview=1")
check "widget skipped in page-builder preview" '! grep -q "SignalpostConfig" <<<"$PREVIEW"'

echo "== Settings push from WordPress"
RES=$(wpeval 'var_export(Signalpost_Connection::push_settings(["widget" => ["primary_color" => "#123456", "greeting_title" => "Hello from WP"]]));')
check "push settings" '[ "$RES" = "true" ]'
CENTRAL=$(helper query "SELECT widget_config FROM website_settings WHERE website_id = ${SITE_ID}")
check "central received settings" 'grep -q "Hello from WP" <<<"$CENTRAL"'
RES=$(wpeval '$r = Signalpost_Connection::push_settings(["tracking" => ["analytics_enabled" => true]]); echo get_option("signalpost_config_cache")["tracking"]["analytics_enabled"] ? "on" : "off";')
check "plugin cannot enable analytics" '[ "$RES" = "off" ]'

echo "== Rotation requested from dashboard"
OLD_PREFIX=$(wpeval 'echo Signalpost_Store::connection()["key_prefix"];')
helper request-rotation "$SITE_ID" >/dev/null
wpeval 'var_export(Signalpost_Connection::refresh());' >/dev/null
NEW_PREFIX=$(wpeval 'echo Signalpost_Store::connection()["key_prefix"];')
check "credential rotated server-to-server" '[ -n "$NEW_PREFIX" ] && [ "$OLD_PREFIX" != "$NEW_PREFIX" ]'
FLAG=$(helper query "SELECT rotation_requested_at FROM websites WHERE id = ${SITE_ID}")
check "rotation flag cleared" 'grep -q "null" <<<"$FLAG"'

echo "== Seed central history, then deactivate and uninstall"
helper query "INSERT INTO visitors (public_id, workspace_id, website_id, token_hash, token_issued_at, first_seen_at, last_seen_at, created_at, updated_at) SELECT 'vit1', workspace_id, id, REPEAT('c',64), NOW(), NOW(), NOW(), NOW(), NOW() FROM websites WHERE id = ${SITE_ID}" >/dev/null
helper query "INSERT INTO conversations (workspace_id, website_id, visitor_id, created_at, updated_at) SELECT workspace_id, website_id, id, NOW(), NOW() FROM visitors WHERE public_id = 'vit1'" >/dev/null
helper query "INSERT INTO messages (workspace_id, conversation_id, sender_type, client_message_id, body, created_at) SELECT workspace_id, id, 'visitor', 'it-1', 'history', NOW() FROM conversations LIMIT 1" >/dev/null
"${WPCLI[@]}" plugin deactivate signalpost-connector --quiet
HTML=$(curl -fsS "${WP_URL}/")
check "widget gone after deactivation" '! grep -q "SignalpostConfig" <<<"$HTML"'
COUNT=$(helper query "SELECT COUNT(*) AS n FROM messages")
check "central history kept after deactivation" 'grep -q "\"n\":1" <<<"$COUNT"'
check "connection kept for reactivation" '[ -n "$(wpeval "echo get_option(\"signalpost_credential\");")" ]'

"${WPCLI[@]}" plugin uninstall signalpost-connector --quiet --skip-delete
sleep 1
check "local options removed on uninstall" '[ -z "$(wpeval "echo get_option(\"signalpost_credential\", \"\");")" ]'
COUNT=$(helper query "SELECT COUNT(*) AS n FROM messages")
check "central history kept after uninstall" 'grep -q "\"n\":1" <<<"$COUNT"'
check "central website record kept" 'grep -q "\"n\":1" <<<"$(helper query "SELECT COUNT(*) AS n FROM websites")"'

echo
echo "WordPress connector integration: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
