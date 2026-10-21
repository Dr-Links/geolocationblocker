# Scheduled maintenance (cron)

`php bin/console cron:run` performs retention cleanup for every website
(according to each website's retention settings) and platform housekeeping
(expired sessions, tokens, pairing codes, invitations, 30-day security
records, rate-limit buckets). It deletes in bounded batches (default 500 rows,
at most 20 batches per category per run) so it stays light on shared hosting;
leftovers are handled by the next run. A file lock prevents overlapping runs.
The time of the last run is shown under **Platform admin → Health** and on
each workspace's **Privacy & retention** page.

## cPanel

cPanel → **Cron Jobs** → *Add New Cron Job*:

* Common setting: *Every 15 minutes* (`*/15 * * * *`) — hourly is also fine.
* Command:

```
/usr/local/bin/php /home/cpuser/signalpost/bin/console cron:run >/dev/null 2>&1
```

Find the right PHP binary for your selected version if needed, e.g.
`/opt/cpanel/ea-php83/root/usr/bin/php` or `/usr/bin/php`. In cPanel Terminal,
`which php` and `php -v` show what is available. The CLI PHP version must be
8.1 or newer.

To receive output by email instead, remove `>/dev/null 2>&1` and set the cron
email address in cPanel.

## Manual and dry runs

```bash
php bin/console cleanup --dry-run           # counts only, deletes nothing
php bin/console cleanup                      # delete eligible data now (all workspaces)
php bin/console cleanup --workspace=3        # one workspace
```

Workspace owners can also use **Privacy & retention → Preview (dry run)** and
**Run cleanup now** for their own workspace.

## Without cron

Everything still works, but expired data is only removed when an owner runs
cleanup manually. Some hosts offer only a URL-based scheduler; Signalpost
intentionally has no public cleanup URL — use cPanel Cron Jobs.
