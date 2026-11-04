# Deploying AllWebMails

This guide takes you from nothing to a running platform at **allwebmails.com**. Keep every password and key out of chat and email: they go only into files on the server (`deploy/server/secrets/`) or your password manager.

## 1. The pieces

| Address | What | Where it runs |
|---|---|---|
| `allwebmails.com` | Public website, download page, privacy notice, Android APK | Your **Hostinger Business** plan (static files) |
| `app.allwebmails.com` | The web app (PWA) **and** the API used by the web app and the Android app | A small **VPS** (Docker) |
| `admin.allwebmails.com` | Administrator site | The same VPS |
| Database | PostgreSQL 13+ | **Supabase** or **Neon** (managed), or PostgreSQL on the VPS |

Why a VPS: the platform must run all the time to sync mailboxes and send notifications. That needs Node.js and long-running processes, which shared hosting doesn't provide.

**Recommended server:** Hostinger VPS **KVM 2** (2 vCPU, 8 GB RAM) with Ubuntu 24.04. KVM 1 (4 GB) is enough without the virus scanner.

## 2. DNS (in hPanel → Domains → allwebmails.com → DNS records)
Keep the records Hostinger created for the website (`@` and `www`). Add:

| Type | Name | Points to |
|---|---|---|
| A | `app` | your VPS IP address |
| A | `admin` | your VPS IP address |

HTTPS certificates for both are obtained automatically by the server once the records resolve.

## 3. Database

### Option A: Supabase
1. Create a project at supabase.com, in the region closest to your users.
2. Open **SQL Editor** and run the following. Generate each password first with `openssl rand -base64 24`. Store them in your password manager, then in the server's secrets files (step 4).
   ```sql
   CREATE ROLE awm_owner  LOGIN PASSWORD '<owner password>'  NOSUPERUSER NOBYPASSRLS;
   CREATE ROLE awm_auth   LOGIN PASSWORD '<auth password>'   NOSUPERUSER NOBYPASSRLS NOINHERIT;
   CREATE ROLE awm_api    LOGIN PASSWORD '<api password>'    NOSUPERUSER NOBYPASSRLS NOINHERIT;
   CREATE ROLE awm_admin  LOGIN PASSWORD '<admin password>'  NOSUPERUSER NOBYPASSRLS NOINHERIT;
   CREATE ROLE awm_worker LOGIN PASSWORD '<worker password>' NOSUPERUSER NOBYPASSRLS NOINHERIT;
   GRANT CONNECT, CREATE ON DATABASE postgres TO awm_owner;
   GRANT CONNECT ON DATABASE postgres TO awm_auth, awm_api, awm_admin, awm_worker;
   ```
3. Under **Connect → Session pooler**, note the host, e.g. `aws-0-eu-central-1.pooler.supabase.com`, port `5432`. With the pooler, user names get the project reference appended: `awm_api.<project-ref>`, and so on.
4. Supabase backs up the database daily. Point-in-time recovery is a paid add-on.

### Option B: Neon
Create a project and a database named `allwebmails`. In the SQL editor, run the same SQL with `allwebmails` instead of `postgres`. Use the **direct** connection host (not the `-pooler` one). Neon keeps point-in-time history automatically.

### Option C: PostgreSQL on the VPS
Install `postgresql-16` on the VPS. Then create the database and the same roles, with `awm_owner` as the database owner.

The first migration refuses to run if any runtime user is a superuser, has BYPASSRLS, or inherits the owner's rights. That is intentional: it keeps the strict per-user data isolation working.

## 4. The server
On the VPS (as a normal user with sudo):
```bash
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/Dr-Links/geolocationblocker.git allwebmails && cd allwebmails/deploy/server
cp env.example .env        # then edit .env: database host and user names, SMTP mailbox, etc.
docker compose build
docker compose run --rm api node dist/cli.js keys:generate
```
`keys:generate` prints the keys once. Put each value in its own file under `deploy/server/secrets/`, with no extra spaces or lines:

| File | Value |
|---|---|
| `credential_key` | `CREDENTIAL_KEY` |
| `jwt_private_key.pem` | the PEM block |
| `backup_key` | `BACKUP_KEY` (**also keep a copy off the server**) |
| `web_push_private_key` | `WEB_PUSH_PRIVATE_KEY` (and put `WEB_PUSH_PUBLIC_KEY` in `.env`) |
| `db_password_owner` … `db_password_worker` | the database passwords from step 3 |
| `smtp_password` | password of the mailbox that sends account emails (e.g. `no-reply@allwebmails.com` created in hPanel → Emails) |

Then set the file permissions, migrate, create the administrator and start everything:
```bash
chmod 600 secrets/*; sudo chown 1000:1000 secrets/*      # the app runs as user 1000 inside the container
docker compose run --rm api node dist/cli.js db:migrate
docker compose run --rm api node dist/cli.js admin:create --email you@yourdomain.com
docker compose up -d
```
`admin:create` asks for the password and shows the authenticator setup and recovery codes once; keep them offline. Then open `https://app.allwebmails.com` and `https://admin.allwebmails.com`.

Optional virus scanner: set `CLAMAV_HOST=clamav` in `.env` and run `docker compose --profile clamav up -d`.

## 5. The website on Hostinger
1. In hPanel, add allwebmails.com as a website (**Websites → Add website → Empty website**).
2. In **File Manager**, upload the contents of `deploy/website/` into `public_html`, including `.htaccess`.
3. Install the free SSL certificate (**Security → SSL**).
4. Before launch, edit `privacy.html`: fill in the bracketed parts and have it reviewed for your country. Create the `hello@allwebmails.com` mailbox, or change the address in the pages.

## 6. The Android app (APK)
On a computer with Node 22:
```bash
cd apps/mobile && npm ci
npx eas-cli@latest login && npx eas-cli@latest init          # once
npx eas-cli@latest build -p android --profile preview         # builds an installable APK in the cloud
```
Download the APK and upload it as `public_html/download/allwebmails.apk`. For each new version:
1. Raise `version` in `apps/mobile/app.json` and build again.
2. Upload the new APK.
3. Set `LATEST_APP_VERSION` in `.env`, and `MIN_APP_VERSION` when old versions must stop working.
4. Run `docker compose up -d`.

The app then tells users to update.

## 7. Backups, monitoring, updates
- **Backups:** add to the VPS crontab (`crontab -e`):
  ```
  17 3 * * * cd ~/allwebmails/deploy/server && docker compose exec -T scheduler node dist/cli.js backup:run >> ~/backup.log 2>&1
  ```
  - Backups are encrypted and kept in the `data` volume. For an off-server copy, set `BACKUP_TARGET=s3` with an S3-compatible bucket.
  - Test a restore monthly with `backup:restore-test`; see M9.
  - Stored files live in the `data` volume (`/data/blobs`). Include it in the VPS snapshot or backups (Hostinger offers weekly VPS snapshots), or use `BLOB_DRIVER=s3`.
- **Monitoring:** create free monitors (e.g. UptimeRobot) for:
  - `https://app.allwebmails.com/healthz`: the server is up.
  - `https://app.allwebmails.com/healthz/jobs`: mail sync and the scheduler are running. It returns 503 if they stopped.

  The admin dashboard's *System health* panel shows backups, queues and stuck mailboxes.
- **Updating:**
  ```bash
  cd ~/allwebmails && git pull && cd deploy/server && docker compose build \
    && docker compose run --rm api node dist/cli.js db:migrate && docker compose up -d
  ```
  Migrations are additive and checksummed. The web app updates itself on the next page load.

## 8. Before you invite users
- [ ] DNS records for `app` and `admin` resolve to the VPS; both sites load over HTTPS.
- [ ] Registration email arrives (check spam), the confirmation link works, and approving in the admin site works.
- [ ] Connect a test mailbox from your Hostinger email; send and receive.
- [ ] Notifications arrive in the installed web app (Android Chrome, desktop, iPhone home-screen app) and in the APK.
- [ ] `backup:run` works, and you have stored `BACKUP_KEY` and the admin recovery codes offline.
- [ ] Privacy notice completed.
