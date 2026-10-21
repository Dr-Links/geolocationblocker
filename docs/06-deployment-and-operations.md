# 6. Deployment, Backups, Updates and Recovery

## 6.1 Environments

| Environment | Where | Purpose |
|---|---|---|
| Local dev | Your PC / this repo with Docker Compose | Development with fake mail servers (GreenMail or a Dovecot/Postfix test container) |
| Staging | Same VPS, separate compose project + DB, `staging-api.<domain>` — or a second small VPS (preferred once live) | Test migrations and releases against test mailboxes |
| Production | VPS | Real users |

## 6.2 Production layout (Docker Compose on the VPS)

Services: `caddy` (80/443), `api` (user API), `admin-api` (same image, admin entrypoint, `app_admin` DB role), `sync-worker`, `job-worker`, `postgres` (16+, volume on SSD, not exposed), `clamav` (optional), `pgbackrest` (sidecar or host cron). Secrets mounted from `/srv/emailplatform/secrets/` (mode 0400).

DNS (in your cPanel zone editor): `api.<domain>` and `admin.<domain>` → VPS IP. Caddy obtains TLS certificates automatically.

## 6.3 Release process ("automatic, but never untested")

1. Pull request → CI: lint, typecheck, unit + integration tests (Postgres + fake IMAP/SMTP containers), migration up/down test, dependency/OSV + Trivy scan.
2. Merge to `main` → CI builds versioned Docker images (tagged with git SHA) and deploys **to staging automatically**; smoke tests run against staging.
3. Promote to production by a manual approval step (GitHub Actions environment protection) — one click, but a deliberate one.
4. Deploy: `pg_dump` safety snapshot → run migrations (**expand/contract** style: additive first, code tolerant of both schemas, destructive cleanup in a later release) → rolling restart of API/workers → health checks → automatic rollback to the previous image if health fails.
5. Rollback: redeploy previous image tag. Because migrations are expand-first, the previous code still works with the new schema; down-migrations exist but are only used deliberately.

## 6.4 Mobile updates

- **Store builds** (EAS Build → Google Play): required for native changes (new native modules, permissions, SDK upgrades). Use Play internal/closed testing tracks first, then staged rollout. Play review takes hours to days.
- **Over-the-air JS updates** (EAS Update / `expo-updates`): JS/asset-only fixes reach users on next launch without a store release. Allowed by Google Play and Apple as long as the app's primary purpose isn't changed. Signed updates, staged rollout, rollback to the previous update.
- **Mandatory updates:** the API returns `minimum_supported_app_version`; older apps show a blocking "Please update" screen with a Play Store link. Android's in-app update API can prompt, but cannot force-install. Neither store allows silently forcing native updates.
- API versioning (`/v1/`) keeps older app versions working through a deprecation window.

## 6.5 Backups

| What | How | Frequency | Retention |
|---|---|---|---|
| PostgreSQL | **pgBackRest** to an S3-compatible bucket at a **different provider** than the VPS (e.g. VPS on Hetzner, backups on Backblaze B2), repository encryption on | Full weekly, differential daily, continuous WAL archiving (point-in-time recovery) | 35 days |
| Object storage (attachments, MIME) | Bucket versioning + lifecycle rule (delete non-current versions after 30 days); or nightly `rclone sync` to the backup provider | Continuous / nightly | 30 days for deleted objects |
| Config & secrets | Encrypted archive (`age`) of `/srv/emailplatform/secrets` and compose files | On change | Keep latest + offline copy you hold |
| Deletion ledger | Append-only file of deleted user/mailbox IDs + timestamps in the backup bucket | On each deletion | 35 days+ (longer than backups) |

- **Integrity:** pgBackRest checksums every file; a nightly `pgbackrest verify`; results recorded in `backup_runs` and shown in the admin dashboard. Missed/failed backup ⇒ email alert.
- **Restore testing:** monthly automated job restores the latest backup into a throwaway container, runs a schema check + row counts + replays the deletion ledger, and records `restore_test` in `backup_runs`. I won't describe restore as working until the first test has run successfully on your infrastructure.
- **Included:** all DB data (users, metadata, bodies, search index, queue). **Not included:** the original mailboxes (they live with your providers), device caches, FCM state.
- **Deleted data ageing:** after a user/mailbox purge, data can still exist in DB backups/WAL for up to **35 days** and in object versions for up to 30 days. Object blobs are additionally crypto-shredded immediately (their key is destroyed). After restoring a backup, the restore script **replays the deletion ledger** so deleted users aren't resurrected.
- **Why off-site matters:** if the only backup is on the same VPS or the same cPanel account, a disk failure, provider account suspension, ransomware or a mistaken `rm` takes out production and backups together. Your cPanel account can serve as a *third* copy (rclone to its storage via SFTP) but shouldn't be the only one.

**Restore procedure (summary; full runbook in M9):** provision VPS → install Docker → restore secrets archive → `pgbackrest restore` (optionally `--type=time --target=…`) → start Postgres → replay deletion ledger → start services → verify health → update DNS if IP changed.

## 6.6 Administrator emergency recovery

Normal path: "Forgot password" on the admin login → link to the designated admin recovery email → set new password → still requires TOTP or a recovery code.

**Emergency path (lost password and second factor):** requires *authorised server access*, which is the security boundary.

Via SSH (preferred):
```bash
ssh you@vps
cd /srv/emailplatform
docker compose exec admin-api node dist/cli.js admin:emergency-reset
# Prints a one-time URL valid for 15 minutes. Opening it lets you set a new
# password and enrol a new TOTP device. All admin sessions are revoked and the
# event is written to audit_log.
```

Via database access only (e.g. a hosting control panel's SQL tool, if the DB is ever hosted where you only have SQL access):
1. On your own computer, run `node tools/make-emergency-token.js` (included in M1). It prints a random token and its SHA-256 hash.
2. In the SQL console run:
   ```sql
   INSERT INTO app.auth_tokens (user_id, purpose, token_hash, expires_at)
   SELECT id, 'admin_emergency', decode('<hash-hex>', 'hex'), now() + interval '15 minutes'
   FROM app.users WHERE role = 'admin';
   ```
3. Open `https://admin.<domain>/emergency?token=<token>` and set a new password + TOTP.

No plaintext password is ever stored or typed into SQL, nothing works without server/DB credentials, and the token is single-use and logged.

## 6.7 Monitoring

- Uptime check on `/healthz` (e.g. Uptime Kuma on cPanel or a free hosted monitor).
- Admin dashboard: queue depth & oldest job, failed jobs, mailboxes in `auth_failed`/`error`, send failures (24 h), storage per user, disk usage, last backup & last restore test, upcoming expiries.
- Email alerts to the admin address (via the cPanel SMTP account) for: backup failure, disk > 80%, worker down > 5 min, > N mailboxes failing, error spikes.
