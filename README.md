# Signalpost

Self-hosted, multi-tenant live chat for WordPress websites, built to run on
ordinary cPanel shared hosting (PHP + MySQL, no daemons, no WebSockets, no
Node.js at runtime).

* **Central application** (`central/`) — dashboard, inbox, live visitors,
  visitor profiles, websites, members, privacy controls and platform
  administration. Plain PHP 8.1+, no runtime Composer packages.
* **WordPress connector** (`wordpress-plugin/signalpost-connector/`) — pairs a
  site with the central app and loads the widget.
* **Chat widget** (`central/public/widget/v1/`) — vanilla JS/CSS in a Shadow
  DOM, served by the central app.

The binding specification is in [`MASTER_SPEC.md`](MASTER_SPEC.md); the plan
and milestone criteria are in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Highlights

* Multiple users, each with isolated workspaces; owners and agents; invitations;
  platform owner without implicit access to customer conversations (audited,
  time-limited, read-only support grants instead).
* Multiple WordPress sites per workspace; one-time pairing codes; hashed,
  rotatable, revocable site credentials.
* Chat with pending/sent/failed states, idempotent retries, pre-chat form,
  reopening rules, mobile layout, keyboard and screen-reader support.
* **Essential chat by default.** Optional analytics (page views, visits,
  referrer, coarse browser/OS, estimated country) only when enabled per website
  and permitted per visitor; server-side fail-closed enforcement; withdrawal
  erases analytics.
* Visitor-ID-only blocking enforced by the server. No IP blocking, no
  fingerprinting.
* Retention per category with dry-run and bounded cron cleanup; workspace and
  visitor export; visitor, website and workspace deletion.

## Documentation

| Topic | File |
|---|---|
| Installation, cPanel deployment, database, first owner, upgrades | [docs/INSTALL.md](docs/INSTALL.md) |
| WordPress plugin | [docs/WORDPRESS_PLUGIN.md](docs/WORDPRESS_PLUGIN.md) |
| Cron | [docs/CRON.md](docs/CRON.md) |
| Backup and restoration | [docs/BACKUP.md](docs/BACKUP.md) |
| Troubleshooting | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| Security model and known limitations | [docs/SECURITY.md](docs/SECURITY.md) |
| Data collection, consent, retention, deletion | [docs/PRIVACY.md](docs/PRIVACY.md) |
| API reference | [docs/API.md](docs/API.md) |
| Test report | [docs/TEST_REPORT.md](docs/TEST_REPORT.md) |

## Packages

`build/build.sh` produces and verifies:

* `dist/signalpost-central-<version>.zip` — upload and extract on the server.
* `dist/signalpost-connector-<version>.zip` — install via WordPress → Plugins → Add New → Upload.

## Development

Requirements: PHP 8.1+, Composer (for PHPUnit only), MySQL/MariaDB. Optional:
WP-CLI, Node.js (Playwright browser tests only).

```bash
cd central
composer install                       # PHPUnit (dev only)
# Tests need an empty database whose name contains "test":
export SP_TEST_DB_HOST=127.0.0.1 SP_TEST_DB_NAME=signalpost_test SP_TEST_DB_USER=... SP_TEST_DB_PASSWORD=...
vendor/bin/phpunit

# Local server
cp config/config.example.php config/config.php   # set db.*, app.url=http://127.0.0.1:8080, app.key, app.env=development, security.force_https=false
php -S 127.0.0.1:8080 -t public bin/dev-router.php
```

Integration tests with a real WordPress install (needs WordPress core at
`/opt/wp-core` or `SP_IT_WP_CORE`, WP-CLI, MariaDB):

```bash
tests/integration/wordpress-connector.sh   # plugin pairing, rotation, uninstall behaviour
tests/e2e/run.sh                           # Playwright: WordPress admin + visitor widget + operator dashboard
tests/e2e/clean-install.sh                 # builds the ZIP, installs it fresh, runs the web installer
```

Never point test variables at a database containing real data; the suite
drops and recreates all tables.

## License

Central application: proprietary to the platform owner. WordPress plugin:
GPL-2.0-or-later (as required for WordPress plugins).
