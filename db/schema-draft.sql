-- =============================================================================
-- Multi-user, multi-domain email platform — DRAFT PostgreSQL schema (v0.1)
--
-- Status: DESIGN DRAFT. This file is loaded and validated against PostgreSQL 16
-- in CI-like checks (see docs/04-database-design.md), but it is NOT a migration.
-- Milestone 1 splits it into ordered, reversible migrations under
-- backend/migrations/. Production schemas are only ever changed by migrations.
--
-- Conventions
--   * Every user-owned row carries user_id. Child tables reference their parent
--     with a COMPOSITE foreign key (parent_id, user_id) so a row can never point
--     at a parent that belongs to a different user, even if the API has a bug.
--   * Row-Level Security (RLS) is enabled on user-owned tables as defence in
--     depth. The API/worker set `app.user_id` per transaction (SET LOCAL).
--   * Enumerations are TEXT + CHECK (cheaper to evolve than PG enums).
--   * All timestamps are timestamptz (stored UTC). Display time zones are IANA
--     names stored alongside where needed.
--   * No plaintext secrets. *_enc columns hold AES-256-GCM ciphertext produced
--     by the application with keys that are NOT stored in this database.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS app;
SET search_path = app, public;

-- Helper: current tenant from the transaction-local setting.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- 1. Platform settings (singleton)
-- -----------------------------------------------------------------------------
CREATE TABLE platform_settings (
  id                         boolean PRIMARY KEY DEFAULT true CHECK (id),
  business_timezone          text    NOT NULL DEFAULT 'UTC',      -- IANA; drives access-period math
  default_quota_bytes        bigint  NOT NULL DEFAULT 5368709120 CHECK (default_quota_bytes > 0), -- 5 GiB
  default_body_retention_days int    NOT NULL DEFAULT 365 CHECK (default_body_retention_days > 0),
  default_initial_sync_days  int     NOT NULL DEFAULT 90  CHECK (default_initial_sync_days > 0),
  undo_send_seconds          int     NOT NULL DEFAULT 10  CHECK (undo_send_seconds BETWEEN 5 AND 30),
  quota_warn_percent         int     NOT NULL DEFAULT 80  CHECK (quota_warn_percent BETWEEN 50 AND 99),
  admin_recovery_email       citext,                               -- designated admin recovery address
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings DEFAULT VALUES;

-- -----------------------------------------------------------------------------
-- 2. Users, access periods, auth
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized      citext NOT NULL,          -- canonical Gmail (dots/+tag removed, gmail.com)
  email_display         citext NOT NULL,          -- as typed (for display / sending mail to user)
  password_hash         text   NOT NULL,          -- argon2id PHC string
  role                  text   NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status                text   NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','suspended','rejected','deleting')),
  suspension_reason     text   CHECK (suspension_reason IN ('expired','admin_action')),
  email_verified_at     timestamptz,
  approved_at           timestamptz,
  approved_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  access_expires_at     timestamptz,              -- end of current access period (exclusive)
  suspended_at          timestamptz,
  rejected_at           timestamptz,
  deletion_requested_at timestamptz,
  timezone              text   NOT NULL DEFAULT 'UTC', -- user's display tz (IANA)
  storage_quota_bytes   bigint CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes >= 0), -- NULL = platform default
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  failed_login_count    int    NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email_normalized),
  CONSTRAINT users_gmail_only CHECK (role = 'admin' OR email_normalized ~* '@gmail\.com$'),
  CONSTRAINT users_suspension_consistent CHECK ((status = 'suspended') = (suspension_reason IS NOT NULL)),
  CONSTRAINT users_approved_has_expiry CHECK (status <> 'approved' OR access_expires_at IS NOT NULL)
);
-- Exactly one administrator can ever exist.
CREATE UNIQUE INDEX users_single_admin ON users ((role)) WHERE role = 'admin';
CREATE INDEX users_status_idx  ON users (status, created_at);
CREATE INDEX users_expiry_idx  ON users (access_expires_at) WHERE status = 'approved';
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- History of every manually granted access period (renewals).
CREATE TABLE access_periods (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  timezone_used     text NOT NULL,                -- business tz used for the calendar-month math
  granted_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  payment_note      text CHECK (length(payment_note) <= 500), -- free text, e.g. "bank transfer ref 123"; never card data
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX access_periods_user_idx ON access_periods (user_id, starts_at DESC);

-- Per-user data-encryption key (wrapped by a KEK held outside the DB).
-- Destroying this row crypto-shreds that user's object-storage blobs, including
-- copies that still sit in object-storage backups/versions.
CREATE TABLE user_keys (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wrapped_dek   bytea NOT NULL,
  kek_version   int   NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One-time tokens: email verification, password reset, admin recovery.
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('email_verify','password_reset','admin_recovery','admin_emergency')),
  token_hash  bytea NOT NULL UNIQUE,                -- SHA-256 of the random token; token itself never stored
  created_ip  inet,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose) WHERE used_at IS NULL;

-- Admin second factor (TOTP) and recovery codes. Only the admin row uses these.
CREATE TABLE mfa_factors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('totp','recovery_code','webauthn')),
  secret_enc      bytea,                            -- TOTP secret (encrypted) / WebAuthn public key
  code_hash       text,                             -- argon2id hash of a recovery code
  label           text,
  last_used_step  bigint,                           -- TOTP replay protection
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'recovery_code') = (code_hash IS NOT NULL))
);
CREATE INDEX mfa_factors_user_idx ON mfa_factors (user_id, kind);

-- Devices (mobile installs, browsers) and their push tokens.
CREATE TABLE devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform           text NOT NULL CHECK (platform IN ('android','ios','web')),
  name               text,
  app_version        text,
  push_provider      text CHECK (push_provider IN ('fcm','apns','webpush')),
  push_token         text,
  push_token_updated_at timestamptz,
  push_enabled       boolean NOT NULL DEFAULT true,
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX devices_push_token_unique ON devices (push_token) WHERE push_token IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX devices_user_idx ON devices (user_id) WHERE revoked_at IS NULL;

-- Sessions with rotating refresh tokens. family_id detects refresh-token reuse.
CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id           uuid,
  kind                text NOT NULL CHECK (kind IN ('mobile','web','admin')),
  family_id           uuid NOT NULL,
  refresh_token_hash  bytea NOT NULL UNIQUE,
  previous_token_hash bytea,                        -- last rotated-out token (reuse => revoke family)
  mfa_verified_at     timestamptz,                  -- admin sessions only
  ip                  inet,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_reason      text,
  FOREIGN KEY (device_id, user_id) REFERENCES devices (id, user_id) ON DELETE CASCADE
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions (family_id);

-- Login attempts (rate limiting evidence + admin visibility). Pruned after 90 days.
CREATE TABLE login_attempts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_normalized  citext,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  ip                inet,
  surface           text NOT NULL CHECK (surface IN ('app','admin')),
  success           boolean NOT NULL,
  failure_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (email_normalized, created_at DESC);
CREATE INDEX login_attempts_ip_idx    ON login_attempts (ip, created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. Mailboxes, server settings, credentials, folders
-- -----------------------------------------------------------------------------
CREATE TABLE mailboxes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_address          citext NOT NULL,
  display_name           text,                     -- "From" name
  label_color            text,
  provider               text NOT NULL CHECK (provider IN ('imap_smtp','google_oauth','microsoft_oauth')),
  status                 text NOT NULL DEFAULT 'connecting'
                           CHECK (status IN ('connecting','active','auth_failed','error','paused_user',
                                             'paused_account','disconnected')),
  status_detail          text,                     -- user-readable, sanitized
  last_error_code        text,
  last_error_at          timestamptz,
  consecutive_failures   int  NOT NULL DEFAULT 0,
  next_retry_at          timestamptz,
  generation             int  NOT NULL DEFAULT 1,   -- bumped on reconnect/disconnect; stale jobs compare and abort
  capabilities           jsonb NOT NULL DEFAULT '{}'::jsonb, -- IDLE, CONDSTORE, QRESYNC, MOVE, UIDPLUS, SPECIAL-USE, OBJECTID, SMTP SIZE...
  max_message_bytes      bigint,                   -- from SMTP SIZE or provider docs
  send_limit_per_hour    int CHECK (send_limit_per_hour IS NULL OR send_limit_per_hour > 0),
  max_recipients_per_msg int CHECK (max_recipients_per_msg IS NULL OR max_recipients_per_msg > 0),
  provider_saves_sent    boolean NOT NULL DEFAULT false, -- Gmail/M365 save sent mail themselves
  initial_sync_days      int,
  default_signature_id   uuid,                     -- FK added after signatures
  last_full_sync_at      timestamptz,
  last_incoming_at       timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  disconnected_at        timestamptz,
  UNIQUE (id, user_id)
);
-- A user may connect a given address only once while it is connected.
CREATE UNIQUE INDEX mailboxes_user_address_unique ON mailboxes (user_id, email_address) WHERE status <> 'disconnected';
CREATE INDEX mailboxes_health_idx ON mailboxes (status, next_retry_at);
CREATE TRIGGER mailboxes_touch BEFORE UPDATE ON mailboxes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE mailbox_server_settings (
  mailbox_id        uuid PRIMARY KEY,
  user_id           uuid NOT NULL,
  imap_host         text NOT NULL,
  imap_port         int  NOT NULL CHECK (imap_port BETWEEN 1 AND 65535),
  imap_security     text NOT NULL CHECK (imap_security IN ('tls','starttls')),   -- plaintext is not offered
  imap_auth         text NOT NULL CHECK (imap_auth IN ('plain','login','xoauth2','oauthbearer')),
  imap_username     text NOT NULL,
  smtp_host         text NOT NULL,
  smtp_port         int  NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_security     text NOT NULL CHECK (smtp_security IN ('tls','starttls')),
  smtp_auth         text NOT NULL CHECK (smtp_auth IN ('plain','login','xoauth2','oauthbearer')),
  smtp_username     text NOT NULL,
  -- Certificate handling: verification is always on. If a host presents a cert that
  -- does not match (common on shared cPanel), the user may explicitly pin the
  -- presented certificate's SPKI hash after seeing a warning. Never "ignore errors".
  imap_cert_pin_sha256 text,
  smtp_cert_pin_sha256 text,
  discovered_via    text NOT NULL CHECK (discovered_via IN ('autoconfig','ispdb','autodiscover','srv','guess','manual','oauth_provider')),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);

CREATE TABLE mailbox_credentials (
  mailbox_id        uuid PRIMARY KEY,
  user_id           uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('password','oauth')),
  secret_enc        bytea NOT NULL,                -- password, or JSON {refresh_token, access_token}
  key_version       int   NOT NULL,                -- which credential master key encrypted it
  oauth_scopes      text[],
  oauth_expires_at  timestamptz,
  last_verified_at  timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);

CREATE TABLE folders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  mailbox_id       uuid NOT NULL,
  path             text NOT NULL,                  -- provider path (IMAP modified UTF-7 decoded)
  delimiter        text,
  display_name     text NOT NULL,
  special_use      text CHECK (special_use IN ('inbox','sent','drafts','trash','junk','archive','all','flagged')),
  uidvalidity      bigint,
  uidnext          bigint,
  highestmodseq    numeric(20,0),                   -- unsigned 63-bit+ per RFC 7162
  sync_enabled     boolean NOT NULL DEFAULT true,
  sync_state       text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','ok','error','resyncing')),
  last_synced_at   timestamptz,
  exists_on_server boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, path),
  UNIQUE (id, user_id),
  UNIQUE (id, mailbox_id),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX folders_one_special_use ON folders (mailbox_id, special_use) WHERE special_use IS NOT NULL AND exists_on_server;

-- -----------------------------------------------------------------------------
-- 4. Threads, messages, bodies, addresses, locations
-- -----------------------------------------------------------------------------
CREATE TABLE threads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_normalized text,
  provider_thread_id text,                         -- e.g. Gmail X-GM-THRID / Graph conversationId (scoped by mailbox)
  provider_thread_mailbox_id uuid,
  last_message_at    timestamptz NOT NULL,
  message_count      int NOT NULL DEFAULT 0,
  unread_count       int NOT NULL DEFAULT 0,
  has_attachments    boolean NOT NULL DEFAULT false,
  mailbox_ids        uuid[] NOT NULL DEFAULT '{}', -- denormalised for unified-inbox filtering/labels
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX threads_user_recent_idx ON threads (user_id, last_message_at DESC);
CREATE INDEX threads_mailboxes_gin   ON threads USING gin (mailbox_ids);
CREATE UNIQUE INDEX threads_provider_unique ON threads (user_id, provider_thread_mailbox_id, provider_thread_id)
  WHERE provider_thread_id IS NOT NULL;

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL,
  mailbox_id           uuid NOT NULL,
  thread_id            uuid,
  -- Identity of the message *on the provider* within this mailbox. Gmail X-GM-MSGID,
  -- RFC 8474 EMAILID, Graph id, or (for plain IMAP) a key derived from the first location.
  provider_key         text NOT NULL,
  message_id_header    text,                       -- RFC 5322 Message-ID (may be missing or duplicated!)
  in_reply_to          text,
  references_ids       text[] NOT NULL DEFAULT '{}',
  subject              text,
  from_address         citext,
  from_name            text,
  reply_to             jsonb,
  sent_at              timestamptz,                -- Date: header (untrusted)
  received_at          timestamptz NOT NULL,       -- IMAP INTERNALDATE / provider received time
  size_bytes           bigint,                     -- size on the server (RFC822.SIZE)
  snippet              text,                       -- first ~200 chars of text body
  priority             text NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  is_outgoing          boolean NOT NULL DEFAULT false,
  -- Flags mirror the provider. pending_* reflect user intent not yet confirmed by the provider.
  is_seen              boolean NOT NULL DEFAULT false,
  is_flagged           boolean NOT NULL DEFAULT false,
  is_answered          boolean NOT NULL DEFAULT false,
  is_forwarded         boolean NOT NULL DEFAULT false,
  is_junk              boolean NOT NULL DEFAULT false,
  keywords             text[] NOT NULL DEFAULT '{}',
  has_pending_ops      boolean NOT NULL DEFAULT false,
  has_attachments      boolean NOT NULL DEFAULT false,
  body_state           text NOT NULL DEFAULT 'headers_only'
                         CHECK (body_state IN ('headers_only','stored','evicted','skipped_quota')),
  server_state         text NOT NULL DEFAULT 'present'
                         CHECK (server_state IN ('present','deleted_on_server','unknown')),
  auth_results         jsonb,                      -- parsed SPF/DKIM/DMARC from Authentication-Results
  security_flags       jsonb NOT NULL DEFAULT '{}'::jsonb, -- suspicious links, lookalike domain, risky attachment...
  scan_status          text NOT NULL DEFAULT 'not_scanned'
                         CHECK (scan_status IN ('not_scanned','no_threat_detected','suspicious','malicious','scan_error')),
  platform_blocked     boolean NOT NULL DEFAULT false, -- hidden by the user's platform blocklist (server untouched)
  search_vector        tsvector,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, provider_key),
  UNIQUE (id, user_id),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id, user_id)  REFERENCES threads (id, user_id)   ON DELETE SET NULL (thread_id)
);
CREATE INDEX messages_mailbox_recent_idx ON messages (mailbox_id, received_at DESC);
CREATE INDEX messages_user_recent_idx    ON messages (user_id, received_at DESC);
CREATE INDEX messages_thread_idx         ON messages (thread_id, received_at);
CREATE INDEX messages_msgid_idx          ON messages (user_id, message_id_header);
CREATE INDEX messages_unread_idx         ON messages (user_id, mailbox_id) WHERE NOT is_seen;
CREATE INDEX messages_flagged_idx        ON messages (user_id) WHERE is_flagged;
CREATE INDEX messages_search_gin         ON messages USING gin (search_vector);
CREATE INDEX messages_subject_trgm       ON messages USING gin (subject gin_trgm_ops);
CREATE TRIGGER messages_touch BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Where a message lives on the server. One row per folder copy (Gmail labels => many rows).
CREATE TABLE message_locations (
  message_id   uuid NOT NULL,
  user_id      uuid NOT NULL,
  folder_id    uuid NOT NULL,
  uid          bigint NOT NULL,
  uidvalidity  bigint NOT NULL,
  modseq       numeric(20,0),
  PRIMARY KEY (folder_id, uidvalidity, uid),
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id, user_id)  REFERENCES folders  (id, user_id) ON DELETE CASCADE
);
CREATE INDEX message_locations_message_idx ON message_locations (message_id);

-- Recipients/senders, normalised for search ("from:", "to:").
CREATE TABLE message_addresses (
  message_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('from','to','cc','bcc','reply_to')),
  position    smallint NOT NULL,
  address     citext NOT NULL,
  name        text,
  PRIMARY KEY (message_id, kind, position),
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE
);
CREATE INDEX message_addresses_lookup ON message_addresses (user_id, kind, address);
CREATE INDEX message_addresses_trgm   ON message_addresses USING gin (address gin_trgm_ops);

-- Bodies are separate so retention can evict them without losing metadata.
CREATE TABLE message_bodies (
  message_id              uuid PRIMARY KEY,
  user_id                 uuid NOT NULL,
  text_body               text,
  html_sanitized          text,                    -- sanitised server-side; rendered in a locked-down WebView
  has_remote_content      boolean NOT NULL DEFAULT false, -- remote images blocked until user allows
  stored_bytes            bigint NOT NULL,
  stored_at               timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- 5. Blobs and attachments (bytes live in object storage, not PostgreSQL)
-- -----------------------------------------------------------------------------
CREATE TABLE blobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256        bytea NOT NULL,                    -- of plaintext; dedup is PER USER only (no cross-tenant leak)
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key   text NOT NULL UNIQUE,              -- e.g. u/<user_id>/<uuid>
  purpose       text NOT NULL CHECK (purpose IN ('attachment','upload','outbound_mime','signature_image')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  orphaned_at   timestamptz,                       -- set by GC when unreferenced; deleted after grace period
  UNIQUE (user_id, sha256, purpose),
  UNIQUE (id, user_id)
);

CREATE TABLE drafts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  mailbox_id          uuid NOT NULL,               -- sender mailbox
  compose_kind        text NOT NULL CHECK (compose_kind IN ('new','reply','reply_all','forward')),
  source_message_id   uuid,
  to_recipients       jsonb NOT NULL DEFAULT '[]',
  cc_recipients       jsonb NOT NULL DEFAULT '[]',
  bcc_recipients      jsonb NOT NULL DEFAULT '[]',
  subject             text,
  html_body           text,
  text_body           text,
  signature_id        uuid,
  version             int  NOT NULL DEFAULT 1,     -- optimistic concurrency across devices
  updated_by_device   uuid,
  provider_draft_key  text,                        -- copy in provider Drafts folder, if mirrored
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (source_message_id, user_id) REFERENCES messages (id, user_id) ON DELETE SET NULL (source_message_id)
);
CREATE INDEX drafts_user_idx ON drafts (user_id, updated_at DESC);

CREATE TABLE attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  message_id      uuid,
  draft_id        uuid,
  blob_id         uuid,                            -- NULL until downloaded / after eviction
  filename        text NOT NULL,                   -- sanitised for display only; never used as a path
  declared_mime   text,                            -- from the MIME part / uploader (untrusted)
  detected_mime   text,                            -- from magic-byte sniffing
  size_bytes      bigint NOT NULL,
  content_id      text,                            -- for inline cid: images
  is_inline       boolean NOT NULL DEFAULT false,
  part_path       text,                            -- IMAP BODY[x.y] for on-demand fetch
  state           text NOT NULL DEFAULT 'not_downloaded'
                    CHECK (state IN ('not_downloaded','stored','evicted','blocked_dangerous','skipped_quota')),
  risk_level      text NOT NULL DEFAULT 'unknown' CHECK (risk_level IN ('unknown','low','elevated','dangerous')),
  scan_status     text NOT NULL DEFAULT 'not_scanned'
                    CHECK (scan_status IN ('not_scanned','no_threat_detected','suspicious','malicious','scan_error')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(message_id, draft_id) = 1),
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (draft_id, user_id)   REFERENCES drafts (id, user_id)   ON DELETE CASCADE,
  FOREIGN KEY (blob_id, user_id)    REFERENCES blobs (id, user_id)    ON DELETE SET NULL (blob_id)
);
CREATE INDEX attachments_message_idx ON attachments (message_id);
CREATE INDEX attachments_draft_idx   ON attachments (draft_id);
CREATE INDEX attachments_blob_idx    ON attachments (blob_id);

-- -----------------------------------------------------------------------------
-- 6. Signatures, templates, saved searches, blocklist, reminders
-- -----------------------------------------------------------------------------
CREATE TABLE signatures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  html        text NOT NULL,
  text_alt    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_default_signature_fk
  FOREIGN KEY (default_signature_id, user_id) REFERENCES signatures (id, user_id) ON DELETE SET NULL (default_signature_id);
ALTER TABLE drafts ADD CONSTRAINT drafts_signature_fk
  FOREIGN KEY (signature_id, user_id) REFERENCES signatures (id, user_id) ON DELETE SET NULL (signature_id);

CREATE TABLE templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('template','quick_reply')),
  name        text NOT NULL,
  subject     text,
  html        text NOT NULL,
  text_alt    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX templates_user_idx ON templates (user_id, kind, name);

CREATE TABLE saved_searches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  query       jsonb NOT NULL,                       -- structured filter, validated by the API schema
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

-- Platform-level blocklist: hides/marks in THIS platform only. It does not stop
-- delivery to the original mail server unless provider_rule_state = 'configured'.
CREATE TABLE blocked_senders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_type           text NOT NULL CHECK (match_type IN ('address','domain')),
  value                citext NOT NULL,
  provider_rule_state  text NOT NULL DEFAULT 'none' CHECK (provider_rule_state IN ('none','configured','failed')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, match_type, value)
);

CREATE TABLE reminders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  message_id       uuid NOT NULL,
  remind_at        timestamptz NOT NULL,
  remind_tz        text NOT NULL,                  -- IANA tz the user chose, for DST-correct display/edit
  note             text CHECK (length(note) <= 500),
  followup_status  text NOT NULL DEFAULT 'waiting' CHECK (followup_status IN ('waiting','done','cancelled')),
  fired_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE
);
CREATE INDEX reminders_due_idx ON reminders (remind_at) WHERE fired_at IS NULL AND followup_status = 'waiting';

-- -----------------------------------------------------------------------------
-- 7. Outgoing mail: queue, attempts, provider-side operations
-- -----------------------------------------------------------------------------
CREATE TABLE outbound_messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  mailbox_id         uuid NOT NULL,
  draft_id           uuid,
  idempotency_key    uuid NOT NULL,                -- generated on the device when Send is first pressed
  message_id_header  text NOT NULL,                -- fixed before first attempt; used to detect duplicates
  status             text NOT NULL
                       CHECK (status IN ('pending_undo','scheduled','queued','sending','sent','failed',
                                         'cancelled','paused_suspended','paused_mailbox','uncertain')),
  release_at         timestamptz,                  -- end of undo window
  scheduled_at       timestamptz,
  scheduled_tz       text,
  mime_blob_id       uuid,                         -- frozen MIME built at queue time
  recipient_count    int NOT NULL CHECK (recipient_count > 0),
  attempt_count      int NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz,
  lease_owner        text,
  lease_expires_at   timestamptz,
  sent_at            timestamptz,                  -- provider accepted (SMTP 250 after DATA / API 2xx)
  sent_copy_state    text NOT NULL DEFAULT 'pending' CHECK (sent_copy_state IN ('pending','not_needed','appended','failed')),
  last_error_code    text,
  last_error_message text,                         -- sanitised; never contains credentials
  paused_from_status text,                         -- what to restore after explicit user confirmation
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (id, user_id),
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL),
  CHECK (status <> 'pending_undo' OR release_at IS NOT NULL),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (draft_id, user_id)   REFERENCES drafts (id, user_id) ON DELETE SET NULL (draft_id),
  FOREIGN KEY (mime_blob_id, user_id) REFERENCES blobs (id, user_id) ON DELETE RESTRICT
);
CREATE INDEX outbound_due_idx      ON outbound_messages (coalesce(scheduled_at, release_at, next_attempt_at))
  WHERE status IN ('pending_undo','scheduled','queued');
CREATE INDEX outbound_user_idx     ON outbound_messages (user_id, created_at DESC);
CREATE INDEX outbound_mailbox_rate ON outbound_messages (mailbox_id, sent_at) WHERE status = 'sent';
CREATE TRIGGER outbound_touch BEFORE UPDATE ON outbound_messages FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE outbound_recipients (
  outbound_id  uuid NOT NULL,
  user_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('to','cc','bcc')),
  position     int  NOT NULL,
  address      citext NOT NULL,
  name         text,
  smtp_result  text,                               -- per-recipient RCPT outcome
  PRIMARY KEY (outbound_id, kind, position),
  FOREIGN KEY (outbound_id, user_id) REFERENCES outbound_messages (id, user_id) ON DELETE CASCADE
);

CREATE TABLE delivery_attempts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbound_id    uuid NOT NULL,
  user_id        uuid NOT NULL,
  attempt_no     int  NOT NULL,
  worker_id      text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  outcome        text CHECK (outcome IN ('accepted','temp_failure','perm_failure','connection_error','uncertain')),
  smtp_code      int,
  enhanced_code  text,
  response_text  text,                             -- sanitised provider response
  UNIQUE (outbound_id, attempt_no),
  FOREIGN KEY (outbound_id, user_id) REFERENCES outbound_messages (id, user_id) ON DELETE CASCADE
);

-- User actions that must be applied on the provider (flag, move, delete, append...).
-- The UI shows "pending" until status = 'done'; failures are surfaced, never hidden.
CREATE TABLE mailbox_operations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  mailbox_id     uuid NOT NULL,
  message_id     uuid,
  client_op_id   uuid NOT NULL,                    -- device-generated, makes offline replays idempotent
  op             text NOT NULL CHECK (op IN ('set_flags','move','delete','archive','mark_junk','mark_not_junk','append_sent','save_draft')),
  payload        jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','failed','superseded')),
  attempts       int  NOT NULL DEFAULT 0,
  last_error     text,
  mailbox_generation int NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  UNIQUE (user_id, client_op_id),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE
);
CREATE INDEX mailbox_operations_pending_idx ON mailbox_operations (mailbox_id, created_at) WHERE status IN ('pending','in_progress');

-- -----------------------------------------------------------------------------
-- 8. Operational events, notifications, storage, change feed
-- -----------------------------------------------------------------------------
-- Sync/auth/send/connection problems. No email content, no credentials.
CREATE TABLE mailbox_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            uuid NOT NULL,
  mailbox_id         uuid NOT NULL,
  category           text NOT NULL CHECK (category IN ('sync','auth','send','connection','quota','security')),
  severity           text NOT NULL CHECK (severity IN ('info','warning','error','action_required')),
  code               text NOT NULL,                -- stable machine code, e.g. IMAP_AUTH_FAILED
  detail             text,                         -- sanitised
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  user_notified_at   timestamptz,
  admin_notified_at  timestamptz,
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);
CREATE INDEX mailbox_events_open_idx ON mailbox_events (severity, occurred_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX mailbox_events_mailbox_idx ON mailbox_events (mailbox_id, occurred_at DESC);

CREATE TABLE notification_preferences (
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id        uuid,                          -- NULL row = user default
  new_mail          boolean NOT NULL DEFAULT true,
  send_failures     boolean NOT NULL DEFAULT true,
  reminders         boolean NOT NULL DEFAULT true,
  quiet_hours       jsonb,
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX notification_preferences_unique
  ON notification_preferences (user_id, coalesce(mailbox_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Transactional outbox for push notifications. dedupe_key prevents duplicate alerts.
CREATE TABLE notification_outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('new_mail','send_failed','auth_required','reminder','quota','account')),
  dedupe_key   text NOT NULL,                      -- e.g. new_mail:<message_id>
  title        text NOT NULL,                      -- e.g. "New email received at sales@company.com" (no sender/subject)
  data         jsonb NOT NULL DEFAULT '{}',        -- ids only
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dropped')),
  attempts     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  UNIQUE (device_id, dedupe_key),
  FOREIGN KEY (device_id, user_id) REFERENCES devices (id, user_id) ON DELETE CASCADE
);
CREATE INDEX notification_outbox_pending ON notification_outbox (created_at) WHERE status = 'pending';

CREATE TABLE retention_policies (
  user_id                  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body_retention_days      int CHECK (body_retention_days IS NULL OR body_retention_days > 0),
  attachment_retention_days int CHECK (attachment_retention_days IS NULL OR attachment_retention_days > 0),
  keep_flagged             boolean NOT NULL DEFAULT true,  -- starred mail is evicted last
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE storage_usage (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body_bytes         bigint NOT NULL DEFAULT 0,
  attachment_bytes   bigint NOT NULL DEFAULT 0,    -- unique blobs (deduplicated) only
  draft_bytes        bigint NOT NULL DEFAULT 0,
  outbound_bytes     bigint NOT NULL DEFAULT 0,
  total_bytes        bigint GENERATED ALWAYS AS (body_bytes + attachment_bytes + draft_bytes + outbound_bytes) STORED,
  warning_level      text NOT NULL DEFAULT 'none' CHECK (warning_level IN ('none','warn','critical','exceeded')),
  storing_paused     boolean NOT NULL DEFAULT false,
  recalculated_at    timestamptz NOT NULL DEFAULT now()
);

-- Change feed for multi-device/offline sync: devices pull rows with seq > cursor.
CREATE TABLE change_feed (
  seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity       text NOT NULL,                      -- 'message','thread','draft','outbound','reminder',...
  entity_id    uuid NOT NULL,
  op           text NOT NULL CHECK (op IN ('upsert','delete')),
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_feed_user_seq ON change_feed (user_id, seq);

-- -----------------------------------------------------------------------------
-- 9. Audit, deletion lifecycle, backups
-- -----------------------------------------------------------------------------
-- Append-only. The application role gets INSERT/SELECT only (see grants below).
CREATE TABLE audit_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_type       text NOT NULL CHECK (actor_type IN ('admin','user','system')),
  actor_user_id    uuid,                           -- not an FK: survives user deletion
  action           text NOT NULL,                  -- e.g. user.approve, user.suspend, mailbox.delete_data
  target_type      text,
  target_id        uuid,
  target_user_id   uuid,
  ip               inet,
  details          jsonb NOT NULL DEFAULT '{}'      -- never email content, passwords or tokens
);
CREATE INDEX audit_log_time_idx   ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_user_id, occurred_at DESC);

CREATE TABLE deletion_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type     text NOT NULL CHECK (subject_type IN ('user','mailbox')),
  subject_id       uuid NOT NULL,
  user_id          uuid NOT NULL,                  -- not an FK: row must outlive the user
  mode             text NOT NULL CHECK (mode IN ('disconnect_retain','purge')),
  requested_by     uuid,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  completed_at     timestamptz,
  backups_expire_by timestamptz,                   -- completed_at + backup retention window
  last_error       text
);
CREATE INDEX deletion_requests_status_idx ON deletion_requests (status, requested_at);

CREATE TABLE backup_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('pg_full','pg_wal','objects','restore_test')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  location         text,                           -- bucket/path (no credentials)
  size_bytes       bigint,
  checksum_sha256  text,
  verified_at      timestamptz,
  detail           text
);
CREATE INDEX backup_runs_kind_idx ON backup_runs (kind, started_at DESC);

-- -----------------------------------------------------------------------------
-- 10. Roles, grants and Row-Level Security
-- -----------------------------------------------------------------------------
-- app_owner : owns schema, runs migrations (never used by the running app)
-- app_api   : user-facing API + workers (RLS enforced, cannot change role/audit)
-- app_admin : admin API; reads operational metadata, NOT message content
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_api')   THEN CREATE ROLE app_api   NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_admin') THEN CREATE ROLE app_admin NOLOGIN; END IF;
END $$;

GRANT USAGE ON SCHEMA app TO app_api, app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO app_api, app_admin;
-- Users can never promote themselves: the API role cannot write the role column.
REVOKE UPDATE ON users FROM app_api;
GRANT UPDATE (email_display, password_hash, email_verified_at, timezone, password_changed_at,
              failed_login_count, locked_until, last_login_at, status, suspension_reason,
              suspended_at, access_expires_at, deletion_requested_at, updated_at) ON users TO app_api;
-- Registration, login and password reset run through SECURITY DEFINER functions
-- (Milestone 1) because they happen before a tenant context exists.
REVOKE INSERT, DELETE ON users FROM app_api;
-- Audit log is append-only for the application.
REVOKE UPDATE, DELETE ON audit_log FROM app_api;

-- Admin role: metadata only. No message bodies, subjects, addresses, drafts, templates.
GRANT SELECT ON users, access_periods, sessions, devices, login_attempts, mailbox_events,
                storage_usage, retention_policies, audit_log, deletion_requests, backup_runs,
                platform_settings, mfa_factors, auth_tokens TO app_admin;
GRANT SELECT (id, user_id, email_address, provider, status, status_detail, last_error_code, last_error_at,
              consecutive_failures, next_retry_at, last_full_sync_at, last_incoming_at, created_at,
              disconnected_at) ON mailboxes TO app_admin;
GRANT SELECT (id, user_id, mailbox_id, status, recipient_count, attempt_count, sent_at,
              last_error_code, created_at) ON outbound_messages TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, access_periods, sessions, auth_tokens, mfa_factors,
                platform_settings, deletion_requests, storage_usage TO app_admin;
GRANT INSERT ON audit_log TO app_admin;

-- RLS on every user-owned table. The policy keys off app.user_id set per transaction.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'access_periods','user_keys','devices','sessions','mailboxes','mailbox_server_settings',
    'mailbox_credentials','folders','threads','messages','message_locations','message_addresses',
    'message_bodies','blobs','drafts','attachments','signatures','templates','saved_searches',
    'blocked_senders','reminders','outbound_messages','outbound_recipients','delivery_attempts',
    'mailbox_operations','mailbox_events','notification_preferences','notification_outbox',
    'retention_policies','storage_usage','change_feed']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I TO app_api
                      USING (user_id = app.current_user_id())
                      WITH CHECK (user_id = app.current_user_id())', t);
    -- The admin API may see operational rows of any user, limited by column grants above.
    EXECUTE format('CREATE POLICY admin_read ON app.%I FOR SELECT TO app_admin USING (true)', t);
  END LOOP;
END $$;
-- users table: the API sees only the current user's row.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY self_only ON users TO app_api USING (id = app.current_user_id());
CREATE POLICY admin_all ON users TO app_admin USING (true) WITH CHECK (true);
