# Backup and restoration

## What to back up

| Item | Why | Contains |
|---|---|---|
| The MySQL/MariaDB database | All accounts, workspaces, conversations, visitors, settings | Personal data, password hashes, credential hashes |
| `signalpost/config/config.php` | Database credentials and the application key | **Secrets** |
| `signalpost/storage/` (optional) | Logs | Redacted operational logs |

The application code itself can be re-downloaded from the release ZIP.

**The application key matters:** visitor tokens are stored as keyed hashes.
If you restore a database with a different `app.key`, existing visitors
cannot resume their sessions (they start new ones; conversations remain
visible to operators).

## cPanel backups

* cPanel → **Backup** → *Download a MySQL Database Backup* (database only), or
  *Download a Full Account Backup*.
* Many hosts also run automatic daily backups (JetBackup, etc.). Check the
  retention your host applies.

Store backups encrypted and somewhere other than the hosting account. Restrict
who can download them — they contain everyone's conversations.

## Command line (Terminal/SSH)

```bash
# Database (prompts for the password; do not put it on the command line)
mysqldump --single-transaction --routines --default-character-set=utf8mb4 \
  -u cpuser_spapp -p cpuser_signalpost | gzip > signalpost-$(date +%F).sql.gz

# Configuration (keep separately and securely)
cp ~/signalpost/config/config.php ~/backups/config-$(date +%F).php
chmod 600 ~/backups/config-*.php
```

## Restoring

1. Put the site in a safe state: in cPanel, temporarily point the subdomain to
   an empty folder or rename `signalpost/public/index.php`.
2. Restore the database: cPanel → **phpMyAdmin** → select the (empty)
   database → *Import* the `.sql`/`.sql.gz` file; or
   `gunzip < backup.sql.gz | mysql -u cpuser_spapp -p cpuser_signalpost`.
3. Restore `config/config.php` (same `app.key`, correct DB credentials) and
   set permissions to 600.
4. Extract the application package matching the backup's version (or newer,
   then run migrations: `php bin/console migrate`).
5. Re-enable the site and check **Platform admin → Health**.
6. Connected WordPress sites keep working if their credentials existed at
   backup time. If a site was paired *after* the backup, re-pair it
   (dashboard → website → Generate pairing code).

Test a restore on a staging subdomain at least once.

## Retention of deleted data in backups

Deleting a visitor, website or workspace — or retention cleanup — removes data
from the live database only. **Copies remain in backups until those backups
expire.** Choose a backup retention period (for example 30 days) and state it
in your privacy notice. If you restore an old backup, data deleted since then
reappears; re-apply deletions (e.g. re-run cleanup, delete visitors/workspaces
again) after restoring.
