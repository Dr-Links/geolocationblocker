-- Milestone 2: connected mailboxes, their server settings, encrypted credentials and health events.
SET LOCAL search_path = app, pg_catalog;

CREATE TABLE mailboxes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_address          text NOT NULL CHECK (email_address = lower(email_address) AND length(email_address) <= 254),
  display_name           text CHECK (length(display_name) <= 100),
  label_color            text CHECK (label_color ~ '^#[0-9a-fA-F]{6}$'),
  provider               text NOT NULL DEFAULT 'imap_smtp' CHECK (provider IN ('imap_smtp','google_oauth','microsoft_oauth')),
  status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','auth_failed','error','paused_account','disconnected')),
  status_detail          text CHECK (length(status_detail) <= 500),
  last_error_code        text,
  last_error_at          timestamptz,
  consecutive_failures   int  NOT NULL DEFAULT 0,
  next_retry_at          timestamptz,
  generation             int  NOT NULL DEFAULT 1,
  capabilities           jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_message_bytes      bigint,
  send_limit_per_hour    int CHECK (send_limit_per_hour IS NULL OR send_limit_per_hour > 0),
  max_recipients_per_msg int CHECK (max_recipients_per_msg IS NULL OR max_recipients_per_msg > 0),
  provider_saves_sent    boolean NOT NULL DEFAULT false,
  last_verified_at       timestamptz,
  last_full_sync_at      timestamptz,
  last_incoming_at       timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  disconnected_at        timestamptz,
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX mailboxes_user_address_unique ON mailboxes (user_id, email_address) WHERE status <> 'disconnected';
CREATE INDEX mailboxes_user_idx ON mailboxes (user_id, created_at);
CREATE INDEX mailboxes_retry_idx ON mailboxes (next_retry_at) WHERE status = 'error';
CREATE TRIGGER mailboxes_touch BEFORE UPDATE ON mailboxes FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE mailbox_server_settings (
  mailbox_id        uuid PRIMARY KEY,
  user_id           uuid NOT NULL,
  imap_host         text NOT NULL CHECK (length(imap_host) <= 253),
  imap_port         int  NOT NULL CHECK (imap_port BETWEEN 1 AND 65535),
  imap_security     text NOT NULL CHECK (imap_security IN ('tls','starttls')),
  imap_username     text NOT NULL CHECK (length(imap_username) <= 254),
  smtp_host         text NOT NULL CHECK (length(smtp_host) <= 253),
  smtp_port         int  NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_security     text NOT NULL CHECK (smtp_security IN ('tls','starttls')),
  smtp_username     text NOT NULL CHECK (length(smtp_username) <= 254),
  -- A certificate the user explicitly chose to trust after a warning (SHA-256 fingerprint + PEM).
  imap_cert_sha256  text,
  imap_cert_pem     text,
  smtp_cert_sha256  text,
  smtp_cert_pem     text,
  discovered_via    text NOT NULL CHECK (discovered_via IN ('provider','mx','autoconfig','ispdb','srv','guess','manual')),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);

-- Passwords are AES-256-GCM encrypted with CREDENTIAL_KEY, which is NOT stored in the database.
CREATE TABLE mailbox_credentials (
  mailbox_id        uuid PRIMARY KEY,
  user_id           uuid NOT NULL,
  imap_secret_enc   bytea NOT NULL,
  smtp_secret_enc   bytea,           -- NULL = same as IMAP
  key_version       int   NOT NULL DEFAULT 1,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);

-- Problems and state changes. Never contains email content or credentials.
CREATE TABLE mailbox_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            uuid NOT NULL,
  mailbox_id         uuid NOT NULL,
  category           text NOT NULL CHECK (category IN ('sync','auth','send','connection','quota','security')),
  severity           text NOT NULL CHECK (severity IN ('info','warning','error','action_required')),
  code               text NOT NULL,
  detail             text CHECK (length(detail) <= 500),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  user_notified_at   timestamptz,
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);
CREATE INDEX mailbox_events_open_idx ON mailbox_events (occurred_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX mailbox_events_mailbox_idx ON mailbox_events (mailbox_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Suspension pauses mailboxes; reactivation resumes them (they re-verify on the next run).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.apply_suspension(p_user uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE n int;
BEGIN
  IF p_reason NOT IN ('expired','admin_action') THEN
    RAISE EXCEPTION 'invalid suspension reason %', p_reason;
  END IF;
  UPDATE users SET status = 'suspended', suspension_reason = p_reason, suspended_at = now()
   WHERE id = p_user AND role = 'user' AND status = 'approved';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN false; END IF;
  UPDATE sessions SET revoked_at = now(), revoked_reason = 'account_suspended'
   WHERE user_id = p_user AND revoked_at IS NULL;
  UPDATE mailboxes SET status = 'paused_account', next_retry_at = NULL
   WHERE user_id = p_user AND status IN ('active','error','auth_failed');
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.resume_mailboxes(p_user uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE n int;
BEGIN
  -- 'error' + immediate retry makes the scheduler re-verify each mailbox before syncing again.
  UPDATE mailboxes SET status = 'error', status_detail = 'Reconnecting after reactivation',
         last_error_code = 'RESUMING', next_retry_at = now(), consecutive_failures = 0
   WHERE user_id = p_user AND status = 'paused_account';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Returns mailboxes due for a reconnection attempt, pushing their retry time forward so that
-- concurrent scheduler runs do not pick the same mailbox.
CREATE FUNCTION app.claim_mailbox_retries(p_limit int)
RETURNS TABLE (retry_mailbox_id uuid, retry_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT m.id FROM mailboxes m JOIN users u ON u.id = m.user_id
     WHERE m.status = 'error' AND m.next_retry_at <= now()
       AND u.status = 'approved' AND u.access_expires_at > now()
     ORDER BY m.next_retry_at LIMIT p_limit
     FOR UPDATE OF m SKIP LOCKED
  )
  UPDATE mailboxes m SET next_retry_at = now() + interval '5 minutes'
    FROM due WHERE m.id = due.id
  RETURNING m.id, m.user_id;
END $$;

REVOKE EXECUTE ON FUNCTION app.resume_mailboxes(uuid), app.claim_mailbox_retries(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resume_mailboxes(uuid) TO {{role_admin}};
GRANT EXECUTE ON FUNCTION app.claim_mailbox_retries(int) TO {{role_worker}};

-- ---------------------------------------------------------------------------
-- Privileges and Row-Level Security
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON mailboxes, mailbox_server_settings, mailbox_credentials, mailbox_events
  TO {{role_api}}, {{role_worker}};
-- The admin sees connection health only: no credentials, no server usernames.
GRANT SELECT (id, user_id, email_address, provider, status, status_detail, last_error_code, last_error_at,
              consecutive_failures, next_retry_at, last_verified_at, last_full_sync_at, last_incoming_at,
              created_at, disconnected_at) ON mailboxes TO {{role_admin}};
GRANT SELECT (id, user_id, mailbox_id, category, severity, code, detail, occurred_at, resolved_at) ON mailbox_events TO {{role_admin}};
-- Worker needs the user's account email for "mailbox needs attention" notices.
GRANT SELECT (email_display, timezone, status, access_expires_at) ON users TO {{role_worker}};
CREATE POLICY worker_self ON users FOR SELECT TO {{role_worker}} USING (id = app.current_user_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mailboxes','mailbox_server_settings','mailbox_credentials','mailbox_events'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON app.%I USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id())', t);
  END LOOP;
END $$;
-- Policies above apply to every role without BYPASSRLS; admin additionally reads all rows (column-limited).
CREATE POLICY admin_read ON mailboxes FOR SELECT TO {{role_admin}} USING (true);
CREATE POLICY admin_read ON mailbox_events FOR SELECT TO {{role_admin}} USING (true);
