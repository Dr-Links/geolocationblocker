# Troubleshooting

Start with **Platform admin → Health** (central) and **Settings → Signalpost
Chat → Diagnostics** (WordPress). Error pages show a reference such as
`Reference: 3f9a1c2b7d0e`; search for it in `signalpost/storage/logs/app-*.log`
(JSON lines, secrets redacted).

## Central application

| Symptom | Cause / fix |
|---|---|
| "Signalpost is not configured yet" | `config/config.php` missing, `db.name` empty, or `app.key` not 64 hex characters. |
| 500 error on every page | Database credentials wrong or DB server unreachable → check `storage/logs`. PHP < 8.1 → select a newer PHP in MultiPHP Manager. Missing `pdo_mysql` → enable the extension. |
| Redirect loop / "HTTPS is required" | SSL not active on the subdomain (run AutoSSL), or behind a proxy that terminates TLS: add the proxy to `security.trusted_proxies` so `X-Forwarded-Proto` is honoured. Only as a temporary diagnostic, set `force_https` to false. |
| "Your form has expired" (419) | The page sat open past the session lifetime, or cookies are blocked, or `app.url` does not match the address in the browser (Origin check). Reload; make sure `app.url` is exact (scheme, host, no trailing slash). |
| 404 for every route except `/` | `.htaccess` not applied: `mod_rewrite`/AllowOverride disabled. Ask the host to enable it, or use Nginx rules routing to `public/index.php`. |
| `/install` shows 404 | An account already exists — sign in instead. Use "Forgot password" if needed. |
| Setup token file not created | `storage/` not writable by PHP. Fix permissions (755/775). |
| No invitation/reset emails | Host's `mail()` blocked or emails rejected (SPF/DKIM). Invitation links are shown to the owner after inviting; copy and send them manually. Check cPanel → Email Deliverability. |
| "Too many sign-in attempts" | Wait 15 minutes. Repeated failures are listed under Platform admin → Audit & security. |
| Health says migrations pending | Run them from Health (after a backup) or `php bin/console migrate`. |
| Last cron run "never" | Configure the cron job (docs/CRON.md); check the PHP path in the command. |

## WordPress connection

| Symptom | Cause / fix |
|---|---|
| "Could not reach the Signalpost server" | Wrong address, SSL problem on the central server, or the WordPress host blocks outbound HTTPS. Test from the WordPress server: `curl -I https://chat.example.com/api/v1/health`. |
| "The Signalpost address must use HTTPS" | Use `https://`. Plain HTTP is only allowed for local development hosts. |
| "The pairing code is invalid or has expired" | Codes work once and expire after 30 minutes. Generate a new one. |
| `origin_mismatch` | The WordPress *Site Address (URL)* differs from the address registered in Signalpost (common: `www.` vs no `www`, `http` vs `https`). Fix the website address in the dashboard (Websites → Details) or in WordPress, and generate a new code. |
| Status "Credential rejected" | The website was disconnected centrally, its credential was revoked, or the workspace was suspended. Generate a new pairing code and reconnect. |
| Widget does not appear | Check: plugin connected; **Show the chat widget** enabled; current path not in *Hide widget on paths*; page caching plugin served an old page (purge cache); you are not in a page-builder editor (the widget is skipped there on purpose); browser console for CSP errors from your site's own Content-Security-Policy (allow `script-src`/`connect-src`/`style-src` for your Signalpost domain). |
| Settings changes not visible | The plugin refreshes config every 15 minutes via WP-Cron. Click **Test connection** to refresh now. If `DISABLE_WP_CRON` is set, make sure a system cron calls `wp-cron.php`. |
| "Chat is not available right now" for everyone | Website disconnected, widget disabled, or workspace suspended. For a single visitor it may mean they are blocked. |

## Widget / visitor side

| Symptom | Cause / fix |
|---|---|
| Visitor history lost | The visitor cleared site data, used a private window or another browser. This starts a new visitor (by design). |
| Messages stay "Sending…" then "Not sent" | Network problem or rate limit (max 20 messages/minute/visitor). The visitor can press **Retry**; retries never duplicate messages. |
| Analytics never recorded | Analytics disabled for the website (default); visitor has not consented; page path excluded; with *WP Consent API* the consent plugin is missing or the "statistics" category is not granted. |

## Performance on shared hosting

Every open chat polls about every 4 s, closed chats with a conversation every
15 s, background tabs every 30 s; dashboards every 5 s. If the host
throttles (HTTP 508/503, "Resource limit reached"), raise the `polling`
intervals in `config.php`. Capacity depends on your plan's CPU/entry-process
limits and has not been measured on your host.
