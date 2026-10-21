# 3. PostgreSQL Database Design

The full DDL is in [`db/schema-draft.sql`](../db/schema-draft.sql). It has been loaded into PostgreSQL 16 and checked with these behavioural tests (all passed):

- a second `admin` row is rejected (`users_single_admin`);
- a non-Gmail user and a duplicate normalised Gmail address are rejected;
- a message belonging to user A cannot reference user B's mailbox (composite FK);
- with `app.user_id` = A, the `app_api` role sees 0 of B's messages and cannot insert rows tagged with B's id (RLS);
- `app_api` cannot `UPDATE users.role` (column privileges) and cannot `DELETE` from `audit_log`;
- calendar-month arithmetic: 31 Jan + 1 month → 28 Feb at the same local time.

In Milestone 1 the draft is split into numbered migrations (`backend/migrations/0001_init.sql`, …), each with a down-migration where reversal is safe. Target: PostgreSQL 16 or newer (uses `ON DELETE SET NULL (column)`, PG 15+).

## 3.1 Tenant isolation: three layers

1. **API authorisation:** every query is scoped by the authenticated `user_id`; IDs from the client are looked up *with* `user_id`, never alone. Not found and not yours return the same `404`.
2. **Composite foreign keys:** child tables reference `(parent_id, user_id)`. Even a buggy query cannot attach user A's message to user B's mailbox, thread, draft or blob.
3. **Row-Level Security:** each request/job runs in a transaction that does `SET LOCAL app.user_id = '<uuid>'`; policies restrict `app_api` to rows with that `user_id`. The app role is not the table owner and has no `BYPASSRLS`. Migrations run as a separate owner role.

The admin API connects as `app_admin`, which has **column-level** `SELECT` on operational data only — it physically cannot read `messages`, `message_bodies`, `drafts`, `templates`, `attachments` or credentials.

Honest limitation: anyone with root on the server or the owner DB role (i.e. you, as operator) can technically read stored mail. The UI provides no such path, keys are kept outside the DB, and server access is logged; this is documented to users in the privacy notice.

## 3.2 Tables

### Platform and accounts

| Table | Purpose | Key relationships / constraints | Indexes | Delete behaviour |
|---|---|---|---|---|
| `platform_settings` | Singleton: business time zone, default quota, retention, undo seconds, admin recovery email | `id boolean CHECK (id)` guarantees one row | PK | Never deleted |
| `users` | Platform accounts (users + the single admin) | `UNIQUE(email_normalized)`; Gmail-only CHECK for non-admins; `status` CHECK; `suspension_reason` present iff suspended; approved ⇒ `access_expires_at` set; partial unique index ⇒ one admin | status, expiry (partial) | Purge job deletes row last; everything cascades |
| `access_periods` | History of each manually granted month (who, when, optional payment note) | FK users CASCADE; `ends_at > starts_at` | (user_id, starts_at desc) | Cascades |
| `user_keys` | Per-user data-encryption key, wrapped by an external KEK | PK = user_id | — | Deleted first in purge ⇒ crypto-shred |
| `auth_tokens` | Email verification, password reset, admin recovery tokens (SHA-256 hash only) | `UNIQUE(token_hash)`, expiry, single use (`used_at`) | unused per user/purpose | Cascades; pruned when expired |
| `mfa_factors` | Admin TOTP secret (encrypted), recovery-code hashes, optional WebAuthn | `last_used_step` prevents TOTP replay | (user_id, kind) | Cascades |
| `devices` | App installs/browsers and FCM tokens | `UNIQUE(id,user_id)` for composite FKs; push token unique among active devices | user (active) | Cascades |
| `sessions` | Refresh-token sessions; rotation with reuse detection (`family_id`) | `UNIQUE(refresh_token_hash)`; composite FK to device | user active, family | Cascades; revoked on suspend |
| `login_attempts` | Rate-limit evidence, lockout, admin visibility | user FK SET NULL | (email, time), (ip, time) | Pruned after 90 days |

### Mailboxes

| Table | Purpose | Key relationships / constraints | Indexes | Delete behaviour |
|---|---|---|---|---|
| `mailboxes` | A connected address owned by one user | `UNIQUE(user_id, email_address)` while not disconnected; status CHECK; `generation` for stale-job detection; provider limits & capabilities | health (status, next_retry_at) | Purge cascades all mailbox data |
| `mailbox_server_settings` | IMAP/SMTP hosts, ports, TLS mode (`tls`/`starttls` only), auth method, usernames, optional cert pin, how it was discovered | 1:1, composite FK | PK | Cascades |
| `mailbox_credentials` | Encrypted password or OAuth tokens + key version | 1:1, composite FK; ciphertext only | PK | Deleted on any disconnect |
| `folders` | Server folders + sync checkpoints (`uidvalidity`, `uidnext`, `highestmodseq`) | `UNIQUE(mailbox_id, path)`; one folder per special-use per mailbox | PK, uniques | Cascades |

### Messages

| Table | Purpose | Key relationships / constraints | Indexes | Delete behaviour |
|---|---|---|---|---|
| `threads` | Conversations (per user, may span mailboxes) | provider thread id unique per mailbox | (user, last_message_at desc), GIN on `mailbox_ids` | Cascades with user; empty threads GC'd |
| `messages` | Message metadata, flags, security verdicts, sync state, search vector | `UNIQUE(mailbox_id, provider_key)` ⇒ no duplicates; composite FKs to mailbox and thread; `body_state`, `server_state`, `scan_status` CHECKs | mailbox+date, user+date, thread, Message-ID, unread (partial), flagged (partial), GIN FTS, trigram subject | Cascades from mailbox |
| `message_locations` | Folder + UID copies on the server (Gmail labels → several) | PK (folder, uidvalidity, uid) | message | Cascades |
| `message_addresses` | Normalised From/To/CC/BCC for search and display | composite FK | (user, kind, address), trigram | Cascades |
| `message_bodies` | Stored text + sanitised HTML (evictable) | 1:1 with message | PK | Deleted by retention/eviction or cascade |

### Files, drafts, sending

| Table | Purpose | Key relationships / constraints | Indexes | Delete behaviour |
|---|---|---|---|---|
| `blobs` | Pointer to bytes in object storage | `UNIQUE(user_id, sha256, purpose)` ⇒ per-user dedup only (cross-user dedup would leak "someone else has this file") | storage_key unique | GC after unreferenced 7 days |
| `attachments` | Attachment metadata for a message **or** a draft | exactly one parent (`num_nonnulls = 1`); blob FK SET NULL (evicted) | message, draft, blob | Cascades |
| `drafts` | Server-side drafts, version for optimistic concurrency | composite FKs to mailbox, source message, signature | (user, updated_at) | Cascades |
| `outbound_messages` | Send queue/state machine incl. undo, schedule, pause | `UNIQUE(user_id, idempotency_key)`; state CHECKs (scheduled ⇒ time, sent ⇒ sent_at) | due (partial), user, mailbox rate | Cascades; MIME blob RESTRICT until row gone |
| `outbound_recipients` | Recipients + per-recipient SMTP result | composite FK | PK | Cascades |
| `delivery_attempts` | One row per submission attempt (code, sanitised response) | `UNIQUE(outbound_id, attempt_no)` | — | Cascades |
| `mailbox_operations` | Pending provider-side actions (flags, move, delete, append) | `UNIQUE(user_id, client_op_id)`; carries `mailbox_generation` | pending per mailbox (partial) | Cascades |

### Personal settings and features

| Table | Purpose | Notes |
|---|---|---|
| `signatures` | Multiple signatures per user | Mailbox default via `mailboxes.default_signature_id` (composite FK, SET NULL) |
| `templates` | Templates and quick replies (`kind`) | Per user |
| `saved_searches` | Named structured filters | `UNIQUE(user_id, name)` |
| `blocked_senders` | Platform-level blocklist (address/domain) | `provider_rule_state` records whether a real server rule exists |
| `reminders` | Follow-up reminders with tz | due index (partial) |
| `notification_preferences` | Per user default + per mailbox overrides | unique on (user, coalesce(mailbox)) |
| `retention_policies` | Per-user overrides of platform retention | — |

### Operations and lifecycle

| Table | Purpose | Notes |
|---|---|---|
| `mailbox_events` | Sync/auth/send/connection/quota/security problems; drives user + admin alerts | No content; resolved_at; open-issues index |
| `notification_outbox` | Transactional outbox for pushes | `UNIQUE(device_id, dedupe_key)` ⇒ no duplicate alerts |
| `storage_usage` | Per-user counters + warning level; `total_bytes` generated column | Recalculated nightly from source tables to correct drift |
| `change_feed` | Ordered per-user change log for device sync | Pruned after 30 days; devices older than that do a full resync |
| `audit_log` | Append-only record of admin/security actions | No FKs (survives deletion); `app_api`/`app_admin` cannot UPDATE/DELETE |
| `deletion_requests` | Drives mailbox/user purge; records `backups_expire_by` | Outlives the user |
| `backup_runs` | Backup + restore-test history shown in admin dashboard | — |
| `pgboss.*` | Job queue tables created by pg-boss | Separate schema |

## 3.3 Transactions that must be atomic

| Operation | In one transaction |
|---|---|
| Approve / renew | user status + expiry, `access_periods` insert, audit row |
| Suspend (expiry or admin) | user status, revoke sessions, pause mailboxes, move outbound to `paused_suspended`, audit, notification rows |
| New message ingest | message + addresses + location + body + thread update + `change_feed` + `notification_outbox` |
| Queue send | outbound row (idempotent) + recipients + MIME blob reference + draft deletion |
| Undo | `UPDATE outbound SET status='cancelled' WHERE id=$1 AND status='pending_undo'` (affected rows tells the client if it was too late) |
| Claim send | `SELECT … FOR UPDATE SKIP LOCKED`, set `sending` + lease, insert `delivery_attempts` — committed **before** contacting SMTP so a crash leaves evidence |
| Mailbox reconnect | new credentials, `generation = generation + 1`, status, audit |

## 3.4 Data retention summary

| Data | Kept until |
|---|---|
| Message metadata | Mailbox purge / user deletion (headers are small) |
| Bodies / attachments | Retention policy or quota eviction; re-fetchable from server |
| Login attempts | 90 days |
| Change feed | 30 days |
| Completed jobs | 7 days (failed: 30 days) |
| Audit log | 2 years (configurable), personal data minimised |
| Mailbox events | 180 days after resolution |
| Backups | 35 days rolling (see `06`) |
