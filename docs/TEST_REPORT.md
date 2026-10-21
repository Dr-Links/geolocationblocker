# Signalpost — Test Report and Known Limitations

Date: 2026-10-21 · Version: central 1.0.0, connector 1.0.0

## Environment actually used

| Component | Version |
|---|---|
| PHP | 8.3.6 (CLI and built-in web server) |
| Database | MariaDB 10.11.14 |
| WordPress | 6.8.3 (official GitHub mirror), default theme Twenty Twenty-Five, WP-CLI 2.12.0 |
| Browser | Chromium 141 via Playwright 1.56.1; axe-core 4.10.2 |
| PHPUnit | 10.5 |

All tests ran in a development container, **not** on your cPanel host. Apache/
LiteSpeed `.htaccess` handling was simulated with a router for PHP's built-in
server.

## Results (final run, after all fixes)

| Suite | Command | Result |
|---|---|---|
| PHP unit + feature tests (real MariaDB) | `cd central && vendor/bin/phpunit` | **121 passed, 0 failed** (1016 assertions) |
| WordPress connector integration (real WordPress) | `tests/integration/wordpress-connector.sh` | **28 passed, 0 failed** |
| Browser end-to-end (WP admin + visitor + operator + axe) | `tests/e2e/run.sh` | **49 passed, 0 failed** |
| Clean install from the built ZIPs | `tests/e2e/clean-install.sh` | **17 passed, 0 failed** |
| Package build and verification | `build/build.sh` | passed (contents, lint, no secrets, version consistency) |

## Spec §19 coverage

**Authentication and tenancy** — `AuthenticationTest`, `TenancyTest`
* Unauthenticated users cannot access the dashboard ✔ (`testUnauthenticatedUsersCannotAccessDashboard`)
* User A cannot read/modify User B's data ✔ (`testUserCannotReadOrModifyAnotherWorkspace`, `ChatTest::testDashboardPollingCannotReadOtherWorkspaces`, website/visitor/block/export variants)
* Agents cannot perform owner-only actions ✔ (`testAgentCannotPerformOwnerOnlyActions`, `WebsiteIntegrationTest::testAgentCanViewButNotManageWebsites`, `PrivacyOperationsTest::testUnauthorisedExportsAndDeletionsAreRejected`)
* Revoked members lose access ✔ (`testRevokedMemberLosesAccessImmediately`, `testRevokedMemberCannotRejoinWithStalePendingInvitation`)
* Suspended accounts/workspaces lose access ✔ (`testSuspendedAccountLosesAccessToProtectedOperations`, `testSuspendedWorkspaceIsInaccessible`, `testSuspendedWorkspaceCredentialsStopWorking`)
* Modified resource IDs cannot bypass authorisation ✔ (cross-ID tests in Tenancy, Website, Chat, Blocking, Privacy tests; `testNonNumericOrNegativeIdsAreNotFound`)
* Also: secure installer, session hashing/regeneration/expiry/revocation, CSRF (incl. login CSRF and cross-origin), throttling (incl. spelling-variant bypass), reset/verification token handling, invitations, support grants (expiry, revocation, read-only, audited polling).

**WordPress connection** — `WebsiteIntegrationTest` + integration script + E2E
* Valid / invalid / revoked credentials ✔ (`testValidInvalidRevokedCredentials`)
* Rotation incl. grace period and superseded-credential limits ✔ (`testRotationGracePeriodAndRequestFlag`; server-to-server rotation in real WordPress)
* Website A cannot access website B ✔ (`testWebsiteCredentialCannotAccessAnotherWebsite`)
* Plugin deactivation/uninstall does not erase central history ✔ (`testPluginDisconnectKeepsCentralHistory`; real WordPress deactivate + `wp plugin uninstall`)
* Plugin installed through **Plugins → Add New → Upload** from the built ZIP ✔ (clean-install)

**Chat** — `ChatTest` + E2E
* Visitor starts conversation, operator replies, polling delivers it ✔
* Messages persist centrally across reloads/sessions ✔
* Polling returns only authorised messages; cursor manipulation fails ✔
* Retries do not duplicate (visitor and operator) ✔
* Public users cannot retrieve arbitrary transcripts (no token, wrong site, public ID as token) ✔
* XSS: payloads stored verbatim, JSON-escaped, HTML-escaped server-side, rendered as text in widget and dashboard, no script execution in a real browser ✔

**Visitor tracking** — `VisitorTrackingTest` + E2E
* Essential chat works with analytics disabled; nothing optional stored ✔
* No optional analytics before consent (server fail-closed; no browser requests before consent) ✔
* Withdrawal stops collection and erases analytics ✔ (server and browser)
* Excluded pages not tracked; query strings and fragments removed ✔
* Repeated events deduplicated ✔
* Visit counts follow the 30-minute session rule; polling never counts ✔
* Unknown country does not break profiles ✔; local geo table and trusted-proxy header ✔ (fixture data)
* Coarse browser/OS only; fingerprint-like fields discarded; identical browsers never merged ✔
* Sensitive form values never collected — by construction: the tracking client only sends path, optional title and referrer origin, and contains no code that reads forms, inputs or keystrokes (verified by code review; no dedicated automated test)

**Visitor blocking** — `BlockingTest` + E2E
* Block/unblock with operator, reason, timestamps, audit ✔
* Scoped to website and workspace ✔
* Blocked visitors cannot message, start conversations, submit contact, consent or analytics; generic denial ✔
* Visitor-ID substitution cannot reach another profile ✔
* No IP-based blocking (schema check + same-IP visitor can chat) ✔
* Clearing-storage limitation documented ✔ (test reads docs/PRIVACY.md and the UI text)

**Retention and privacy** — `PrivacyOperationsTest`
* Dry run deletes nothing ✔ · bounded batches with continuation ✔ · independent category retention ✔
* Unauthorised export/deletion rejected ✔ · workspace deletion isolated ✔
* Export contains no secrets or other tenants' data ✔
* Audit logs contain no credentials, passwords or message bodies ✔ (`ChatTest::testAuditLogsNeverContainMessageBodies`, `AuthenticationTest::testAuditLogsNeverContainPasswords`, website credential tests)

**Accessibility** — axe-core (serious/critical rules) on login, overview, inbox, live, visitors, websites, members, privacy and the open widget: no violations after fixes. Keyboard: Escape closes the widget and returns focus to the launcher.

## Defects found and fixed during QA

| Found by | Defect | Fix |
|---|---|---|
| Integration script | A secret beginning with `-` made `grep` error, producing a **false pass** | `grep -F --`; added a length check |
| Screenshots | Dashboard showed raw ISO timestamps (script order) | Lazy formatter lookup; E2E assertion added |
| Screenshots | Mobile launcher overlapped the full-screen panel (`:host` selector) | `:host(.sp-is-open)`; E2E assertion added |
| Clean install | Fresh database: `/login` returned 500 instead of pointing to the installer | Redirect to `/install` when the schema is missing; regression test |
| Security review | Login throttle bypass via accent-variant emails | Email validation, per-user-ID bucket, binary email collation (migration 0007) |
| Security review | Support reads via polling endpoints not audited | Always audited, deduplicated per route per 10 min |
| Security review | Displayed invite link allowed creating a "verified" account for someone else's address | Invited accounts must verify by email when verification is required |
| Security review | Stale invitation allowed a removed member to rejoin | Pending invitations invalidated on accept and on removal |
| Security review | Support could write read markers; superseded credential could disconnect | New `conversations.mark_read` permission; grace check on disconnect |
| Security review | Blocked visitors could still post consent/analytics | Denied |
| axe-core | Insufficient colour contrast (muted text, pills, widget footer) | Darker text tokens |

Several of my own test assertions were also found to be wrong or vacuous
during development and were corrected before results were recorded.

## Not tested / requires your environment

* **Deployment to your cPanel host** — not performed (no access). Apache/LiteSpeed rewrite rules, AutoSSL, PHP-FPM user permissions and `mail()` delivery are untested on real shared hosting.
* **PHP 8.1 / 8.2 and MySQL** — code targets PHP ≥ 8.1 and MySQL ≥ 5.7.8, but only PHP 8.3 + MariaDB 10.11 were run.
* **Plugin on PHP 7.4/8.0 and WordPress 6.0–6.7** — declared minimums, not tested.
* **Page builders** — only the Elementor preview marker was exercised; Divi, Beaver Builder, Bricks, Oxygen, Thrive, WPBakery and Brizy markers are implemented but untested with the real builders. Only the default theme was used.
* **WP Consent API with a real consent plugin** — the bridge is implemented; tested only via the widget's own prompt and the JS API path, not with an installed consent plugin.
* **Real IP-geolocation data** (e.g. DB-IP Lite) and real Cloudflare headers — tested with a fixture CSV and simulated trusted proxy.
* **Email delivery** — tested with an in-memory/file transport only.
* **Load / capacity** — not measured. No traffic capacity is claimed.
* **Dark mode, RTL languages, screen readers** — not manually verified (axe covers structural issues only).
* **Independent penetration test** — not done.

## Known limitations (by design or deferred)

* Short polling (no WebSockets); reply latency ≈ polling interval.
* No multi-factor authentication yet; no SMTP transport (PHP `mail()` only).
* No WooCommerce integration (extension points only).
* Visitor-ID blocking does not follow people who clear storage or switch browsers.
* Visitor tokens live in the customer site's `localStorage`; scripts running on that site can read them (limited to that visitor's own conversation).
* Audit history is kept for the life of the workspace (no separate retention).
* No in-dashboard UI for platform-wide geolocation configuration; set `geo.provider` in `config.php` and import with `bin/console geo:import`.
