# Signalpost — Milestone 0: Inspection Findings and Implementation Plan

Product name: **Signalpost** (original name and design). WordPress plugin slug:
**`signalpost-connector`**.

## 1. Inspection findings (2026-10-21)

| Item | Finding |
|---|---|
| Repository (`main`, working branch) | Empty apart from the initial commit. New project. |
| `MASTER_SPEC.md` | Not present. The specification was supplied in chat and has been committed verbatim as `MASTER_SPEC.md`. |
| Other remote branches | `geoblocker-plugin` / `claude/determined-maxwell-*` contain an unrelated "GeoBlocker" WordPress plugin (open PR #1). `claude/tender-tesla-*` contains a Claude skill. **Not touched, not merged, not reused.** |
| PHP (local) | 8.3.6 CLI with PDO, pdo_mysql, mbstring, openssl, sodium, intl, json, zip, curl. |
| Database (local) | No server initially; MariaDB 10.11 installed in the dev container for real tests. |
| Tools | Composer 2, Node 22 / npm (dev only), zip/unzip, Chromium + Playwright (dev only), WP-CLI phar (from GitHub). |
| WordPress for testing | wordpress.org is blocked by the sandbox proxy; WordPress 6.8.3 core obtained from the official GitHub mirror for local plugin integration tests. |
| Production hosting | **Not accessible from this session.** No deployment will be performed; a package plus cPanel instructions will be produced. |

## 2. cPanel compatibility constraints (design inputs)

* No daemons, WebSockets, Redis, Docker, root, or Node at runtime → short polling over plain PHP + MySQL.
* **Zero runtime Composer dependencies.** The central app ships as plain PHP with its own PSR-4 autoloader, so upload-and-run works without SSH. Composer is used only for PHPUnit in development.
* Minimum supported PHP: **8.1** (code avoids 8.2+/8.3-only syntax). MySQL 5.7.8+/MariaDB 10.3+ (JSON + utf8mb4).
* cPanel subdomains allow a custom document root → web root is `public/`; code, config, storage and migrations stay outside it. An `.htaccess` deny file is included as defence in depth if a host forces a different root.
* Cron via cPanel "Cron Jobs" calling `php bin/console cron:run`.
* Mail via PHP `mail()` (available on cPanel) or a file transport in development. Invitation and reset links are also shown once to the acting user in the dashboard where safe (invitations), so the platform works if mail is misconfigured.
* Optional web installer for hosts without SSH, protected by a one-time setup token written to a non-public file.

## 3. Key design decisions

* **Trust boundaries** are separate route groups with separate authentication:
  1. `/api/v1/dashboard/*` + HTML pages: DB-backed sessions (hashed session tokens, idle and absolute expiry, revocable), CSRF on every state change.
  2. `/api/v1/integration/*`: WordPress server-to-server. Bearer credential `spk_<prefix>.<secret>`; only a SHA-256 hash of the secret is stored. Pairing uses a short-lived one-time pairing code (hashed) generated in the dashboard.
  3. `/api/v1/widget/{sitePublicKey}/*`: public visitor API. Identifies the website by a non-secret public key; the visitor by an opaque random token whose HMAC is stored (lookup without a recoverable copy). Origin is validated against the website's canonical origin but **never treated as authentication**.
* **Tenant isolation**: a single `Authorizer` resolves workspace membership + role + permission for every dashboard request; every repository query that reads tenant data is parameterised by `workspace_id` taken from the authorised context, never from the client alone.
* **Platform owner** has platform-level permissions only. Access to a workspace's conversations requires a time-limited **support grant** created by that workspace's owner; it is read-only and every access is audited.
* **Tracking**: essential chat by default. Analytics (page views, sessions/visit counts, referrer, browser/OS, estimated country) are off by default per website and additionally require the visitor's consent state = `analytics` when the website's legal basis is consent. The server fails closed: events are discarded unless both website policy and stored consent permit them.
* **Geo**: optional local IP→country table imported from a CSV (e.g. DB-IP Lite, CC BY 4.0), or a country header from an explicitly trusted proxy (e.g. Cloudflare). No paid or remote API. Raw IPs are not stored in visitor profiles.
* **Blocking**: by internal visitor ID only, scoped to website + workspace; enforced server-side on every visitor write. No IP blocking exists.
* **Transport**: server `MessageNotifier` interface (no-op for polling) and client `PollingTransport` objects, so a push transport can be added later.

## 4. Milestones and acceptance criteria

| # | Milestone | Acceptance criteria (verified by tests) |
|---|---|---|
| 0 | Inspect | This document + spec committed. |
| 1 | Foundation | Config loader, PDO connection, migration runner with version table, router, JSON/HTML error handling without stack traces, redacting logger. Tests: migrations apply on clean DB; router 404/405; error responses contain no internals; logger redacts secrets. |
| 2 | Auth & tenancy | Secure install of first owner, registration (setting-controlled), email verification, login/logout, throttling, reset, session revocation, suspension, workspaces, invites, roles, admin area, support grants. Tests for every item in spec §19 "Authentication and tenancy". |
| 3 | Website integration | Website CRUD, pairing codes, credentials (hashed), rotation with grace period, revocation, disconnect/reconnect, connection status, origin validation; WP plugin settings/pairing/diagnostics. Tests per §19 "WordPress connection", including against a real WordPress install. |
| 4 | Messaging | Widget (launcher, states, retry, a11y), widget message API with idempotency, polling cursors, operator inbox with filters, search, unread, statuses, pagination. Tests per §19 "Chat" incl. browser XSS test. |
| 5 | Visitor profiles | Opaque visitor tokens, token rotation, pre-chat form, contact submissions, profile with provenance labels. |
| 6 | Analytics | Consent states and records, page-view batching, path sanitisation, exclusions, dedupe, sessions/visit counts, live visitors with documented activity timeout, geo estimation, coarse UA. Tests per §19 "Visitor tracking". |
| 7 | Blocking | Block/unblock, policy read-only vs closed, enforcement, audit. Tests per §19 "Visitor blocking". |
| 8 | Privacy & ops | Export, workspace/visitor deletion, retention cleanup (dry-run, batched, cron), audit viewer, backup docs. Tests per §19 "Retention and privacy". |
| 9 | Security & QA | Full suite, authorisation review, clean install test, end-to-end browser test with real WordPress. |
| 10 | Packaging | `dist/signalpost-central-<ver>.zip`, `dist/signalpost-connector-<ver>.zip`, verified contents, complete docs and test report. |

## 5. Risks and missing information

* **Hosting specifics unknown** (PHP version, MySQL version, `mail()` deliverability, whether subdomain docroot can be set). Mitigated by PHP 8.1 floor, documented checks, and a health page.
* **Polling load on shared hosting**: capacity not measured on the real host; intervals are configurable and documented, no capacity promise is made.
* **Legal compliance** cannot be determined by software; documentation explains bases and limits and makes no compliance claim.
* **Geo database licensing**: no database is bundled; the operator downloads one under its own licence.
* **Email deliverability** via `mail()` may be poor; SMTP is listed as a future extension.
