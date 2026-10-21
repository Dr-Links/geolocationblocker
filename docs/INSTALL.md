# Installing Signalpost on cPanel shared hosting

This guide installs the central application at a subdomain such as
`https://chat.example.com`, then connects WordPress sites with the plugin.
No SSH, Composer, Node.js, Redis, WebSockets or root access is required.

> **Before touching a live server:** take a full cPanel backup, and do not
> deploy to production without testing the package on a staging subdomain
> first. Nothing in this repository has been deployed to your hosting account.

## 1. Requirements

| | Minimum | Notes |
|---|---|---|
| PHP | 8.1 (8.2/8.3 recommended) | Extensions: `pdo_mysql`, `mbstring`, `json`, `openssl`. `sodium` enables Argon2id hashing (bcrypt otherwise). |
| Database | MySQL 5.7.8+ or MariaDB 10.3+ | One database for all workspaces. InnoDB, utf8mb4. |
| Web server | Apache or LiteSpeed with `.htaccess` + `mod_rewrite` | Nginx: route all non-file requests to `public/index.php`. |
| HTTPS | Required in production | cPanel AutoSSL / Let's Encrypt is fine. |
| Cron | Recommended | For retention cleanup (every 15–60 min). |
| Email | PHP `mail()` | For invitations and password resets. Invitation links are also shown to the inviting owner. |

Tested locally with PHP 8.3.6 and MariaDB 10.11 (see docs/TEST_REPORT.md).
Other versions within the stated minimums are expected to work but were not
tested.

## 2. Deliverables

* `dist/signalpost-central-1.0.0.zip` — the central application (folder `signalpost/`).
* `dist/signalpost-connector-1.0.0.zip` — the WordPress plugin.

Build them yourself from the repository with `build/build.sh` (see §9).

## 3. Create the database (cPanel → MySQL® Databases)

1. **Create New Database**, e.g. `cpuser_signalpost`.
2. **Add New User**, e.g. `cpuser_spapp`, with a long generated password.
   Keep the password in your password manager — never paste it into chats,
   tickets or version control.
3. **Add User To Database** → select both → **ALL PRIVILEGES** (needed for
   migrations: CREATE, ALTER, INDEX, REFERENCES, plus SELECT/INSERT/UPDATE/DELETE).
4. Host is usually `localhost`.

Tables are created by the installer; you do not import any SQL manually.

## 4. Upload the application

1. cPanel → **File Manager** → your home directory (e.g. `/home/cpuser/`), **not** `public_html`.
2. **Upload** `signalpost-central-1.0.0.zip`, then **Extract**. You get `/home/cpuser/signalpost/`.
3. Permissions: directories `755`, files `644`; `signalpost/storage/` and its
   subfolders must be writable by PHP (usually `755` is enough under suPHP/
   PHP-FPM as your user; use `775` only if your host requires it).

## 5. Point a subdomain at `public/`

cPanel → **Domains** (or **Subdomains** on older versions) → **Create A New Domain**:

* Domain: `chat.example.com`
* **Document Root:** `/home/cpuser/signalpost/public`

Only `public/` is web-accessible. `config/`, `storage/`, `src/` and the rest
stay outside the web root (they also carry deny-all `.htaccess` files as a
second line of defence).

Then cPanel → **SSL/TLS Status** → run **AutoSSL** for the subdomain and wait
until a certificate is issued.

cPanel → **MultiPHP Manager**: select PHP 8.1+ for `chat.example.com`.
cPanel → **Select PHP Version → Extensions** (if available): ensure
`pdo_mysql`, `mbstring`, `openssl` are enabled.

*If your host cannot set a custom document root*, upload into
`public_html/signalpost/` instead: the package's root `.htaccess` blocks
everything except `public/`, and the app works under
`https://example.com/signalpost/public` (set `app.url` accordingly). A
dedicated subdomain is strongly preferred.

## 6. Configure

1. Open `https://chat.example.com/`. It shows "not configured yet" and prints
   a freshly generated application key (not stored anywhere).
2. In File Manager, copy `signalpost/config/config.example.php` to
   `signalpost/config/config.php` and edit it:
   * `app.url` → `https://chat.example.com` (no trailing slash)
   * `app.key` → the 64-character key from step 1 (or `php bin/console key:generate`)
   * `db.name`, `db.user`, `db.password`, `db.host`
   * `mail.from` → an address on your domain (e.g. `no-reply@example.com`)
   * Leave `security.force_https` = `true`.
   * If the site is behind Cloudflare or another proxy you control, list its
     ranges in `security.trusted_proxies`; otherwise leave it empty.
3. Set `config/config.php` permissions to **600** (File Manager → Permissions).

Keep `app.key` secret and stable. Changing it invalidates visitor sessions
(visitors simply start a new chat session).

## 7. Create the first platform owner (secure installation)

**Option A — web installer (no SSH needed):**

1. Visit `https://chat.example.com/install`. The page creates a one-time setup
   token in `signalpost/storage/setup-token.txt`.
2. Open that file in File Manager, copy its contents into the form.
3. Enter your name, email, first workspace name and a strong password.
   Submitting runs the database migrations and creates the owner. The token
   file is deleted, and `/install` stops working permanently.

Possession of the token proves you control the hosting account, so nobody
who merely finds the URL can claim the installation. There is no default
account or password.

**Option B — command line (cPanel Terminal or SSH):**

```bash
cd ~/signalpost
php bin/console migrate
php bin/console create-owner --email=you@example.com --name="Your Name" --workspace="My Company"
# prompts for the password (hidden)
```

Sign in at `https://chat.example.com/login`. Open **Platform admin → Health**
and fix any warning shown there (storage writable, config permissions,
pending migrations, cron).

## 8. Registration and platform settings

**Platform admin → Settings:**

* **Registration:** `Invitation only` (default) lets workspace owners invite
  people; `Open` lets anyone create an account and workspace; `Closed` allows
  no new accounts.
* **Email verification** for self-registration (on by default).
* Limits on workspaces per account, websites and members per workspace, and
  maximum support-access duration.

## 9. Building the packages from source

```bash
build/build.sh          # creates dist/signalpost-central-<version>.zip and dist/signalpost-connector-<version>.zip
```

The central package contains no development dependencies, tests or secrets,
and the build script verifies that.

## 10. Connect a WordPress site

See docs/WORDPRESS_PLUGIN.md. In short: dashboard → **Websites & widget** →
add the exact site address → **Generate pairing code**; in WordPress install
the plugin ZIP (Plugins → Add New → Upload), then **Settings → Signalpost
Chat** → enter `https://chat.example.com` and the code → **Connect**.

## 11. Cron

See docs/CRON.md. Summary (cPanel → **Cron Jobs**, every 15 minutes):

```
*/15 * * * * /usr/local/bin/php /home/cpuser/signalpost/bin/console cron:run >/dev/null 2>&1
```

## 12. Upgrading

1. **Back up** the database and the `signalpost/` folder (docs/BACKUP.md).
2. Upload the new `signalpost-central-<version>.zip` and extract it to a
   temporary folder, e.g. `signalpost-new/`.
3. Copy your `config/config.php` and the whole `storage/` folder from the old
   installation into `signalpost-new/`.
4. Rename `signalpost/` → `signalpost-old/` and `signalpost-new/` →
   `signalpost/` (the subdomain document root stays `signalpost/public`).
5. Apply migrations: **Platform admin → Health → Run now** (shown when
   migrations are pending), or `php bin/console migrate`.
6. Check **Health**, test a chat, then delete `signalpost-old/` after a few days.

Rollback: restore `signalpost-old/` and the database backup taken in step 1.

Upgrade the WordPress plugin through **Plugins → Add New → Upload** with the
new ZIP ("Replace current with uploaded"). Its connection is kept.
