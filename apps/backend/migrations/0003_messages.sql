-- Milestone 3: folders, synchronised messages, bodies, attachments metadata, and pending server-side actions.
SET LOCAL search_path = app, pg_catalog;

ALTER TABLE mailboxes
  ADD COLUMN sync_window_days int NOT NULL DEFAULT 90 CHECK (sync_window_days BETWEEN 1 AND 3650),
  ADD COLUMN next_sync_at timestamptz,
  ADD COLUMN sync_lease_until timestamptz,
  ADD COLUMN initial_sync_done boolean NOT NULL DEFAULT false;
CREATE INDEX mailboxes_sync_due_idx ON mailboxes (next_sync_at NULLS FIRST) WHERE status = 'active';

CREATE TABLE folders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  mailbox_id       uuid NOT NULL,
  path             text NOT NULL,
  delimiter        text,
  display_name     text NOT NULL,
  special_use      text CHECK (special_use IN ('inbox','sent','drafts','trash','junk','archive','all','flagged')),
  uidvalidity      bigint,
  uidnext          bigint,
  highestmodseq    numeric(20,0),
  server_count     int NOT NULL DEFAULT 0,
  selectable       boolean NOT NULL DEFAULT true,
  sync_enabled     boolean NOT NULL DEFAULT true,
  exists_on_server boolean NOT NULL DEFAULT true,
  initial_done     boolean NOT NULL DEFAULT false,
  last_synced_at   timestamptz,
  next_sync_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, path),
  UNIQUE (id, user_id),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);
CREATE INDEX folders_user_idx ON folders (user_id, special_use);

CREATE TABLE threads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_normalized text,
  last_message_at    timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX threads_user_recent_idx ON threads (user_id, last_message_at DESC);

CREATE TABLE messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  mailbox_id         uuid NOT NULL,
  thread_id          uuid NOT NULL,
  -- Identity on the provider: RFC 8474 EMAILID / Gmail message id when offered, else Message-ID based.
  provider_key       text NOT NULL,
  message_id_header  text,
  in_reply_to        text,
  references_ids     text[] NOT NULL DEFAULT '{}',
  subject            text,
  from_address       text,
  from_name          text,
  to_summary         text,
  sent_at            timestamptz,
  received_at        timestamptz NOT NULL,
  size_bytes         bigint,
  snippet            text,
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
  is_seen            boolean NOT NULL DEFAULT false,
  is_flagged         boolean NOT NULL DEFAULT false,
  is_answered        boolean NOT NULL DEFAULT false,
  is_forwarded       boolean NOT NULL DEFAULT false,
  is_draft           boolean NOT NULL DEFAULT false,
  keywords           text[] NOT NULL DEFAULT '{}',
  has_pending_ops    boolean NOT NULL DEFAULT false,
  has_attachments    boolean NOT NULL DEFAULT false,
  body_state         text NOT NULL DEFAULT 'headers_only' CHECK (body_state IN ('headers_only','stored','evicted','skipped_quota')),
  -- 'present' while at least one folder copy exists on the server; the platform copy can outlive it.
  server_state       text NOT NULL DEFAULT 'present' CHECK (server_state IN ('present','deleted_on_server')),
  auth_results       jsonb,
  security_flags     jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_vector      tsvector,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, provider_key),
  UNIQUE (id, user_id),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id, user_id) REFERENCES threads (id, user_id)
);
CREATE INDEX messages_mailbox_recent_idx ON messages (mailbox_id, received_at DESC);
CREATE INDEX messages_user_recent_idx ON messages (user_id, received_at DESC);
CREATE INDEX messages_thread_idx ON messages (thread_id, received_at);
CREATE INDEX messages_msgid_idx ON messages (mailbox_id, message_id_header) WHERE message_id_header IS NOT NULL;
CREATE INDEX messages_user_msgid_idx ON messages (user_id, message_id_header) WHERE message_id_header IS NOT NULL;
CREATE INDEX messages_unread_idx ON messages (user_id, mailbox_id) WHERE NOT is_seen;
CREATE INDEX messages_flagged_idx ON messages (user_id) WHERE is_flagged;
CREATE INDEX messages_search_gin ON messages USING gin (search_vector);
CREATE TRIGGER messages_touch BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- A message can sit in several folders on the server (IMAP copies, Gmail labels): one row per copy.
CREATE TABLE message_locations (
  folder_id    uuid NOT NULL,
  uid          bigint NOT NULL,
  user_id      uuid NOT NULL,
  message_id   uuid NOT NULL,
  modseq       numeric(20,0),
  PRIMARY KEY (folder_id, uid),
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id, user_id) REFERENCES folders (id, user_id) ON DELETE CASCADE
);
CREATE INDEX message_locations_message_idx ON message_locations (message_id);

CREATE TABLE message_addresses (
  message_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('from','to','cc','bcc','reply_to')),
  position    smallint NOT NULL,
  address     text NOT NULL,
  name        text,
  PRIMARY KEY (message_id, kind, position),
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE
);
CREATE INDEX message_addresses_lookup ON message_addresses (user_id, kind, address);

CREATE TABLE message_bodies (
  message_id          uuid PRIMARY KEY,
  user_id             uuid NOT NULL,
  text_body           text,
  html_sanitized      text,
  has_remote_content  boolean NOT NULL DEFAULT false,
  stored_bytes        bigint NOT NULL,
  stored_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE
);

-- Attachment metadata from the message structure. Bytes are fetched from the server on demand
-- (platform storage of attachment copies arrives with Milestone 6).
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  message_id    uuid NOT NULL,
  part_id       text NOT NULL,
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL DEFAULT 0,
  content_id    text,
  is_inline     boolean NOT NULL DEFAULT false,
  risk_level    text NOT NULL DEFAULT 'unknown' CHECK (risk_level IN ('unknown','low','elevated','dangerous')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, part_id),
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE
);

-- User actions that must reach the server. Shown as "pending" until the server confirms.
CREATE TABLE mailbox_operations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  mailbox_id         uuid NOT NULL,
  message_id         uuid,
  client_op_id       uuid NOT NULL,
  op                 text NOT NULL CHECK (op IN ('set_flags','move','delete')),
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','superseded')),
  attempts           int  NOT NULL DEFAULT 0,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  UNIQUE (user_id, client_op_id),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE
);
CREATE INDEX mailbox_operations_pending_idx ON mailbox_operations (mailbox_id, created_at) WHERE status = 'pending';

-- Picks mailboxes whose sync is due and leases them so overlapping cron runs never sync the same mailbox twice.
CREATE FUNCTION app.claim_sync_mailboxes(p_limit int, p_lease_seconds int)
RETURNS TABLE (sync_mailbox_id uuid, sync_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT m.id FROM mailboxes m JOIN users u ON u.id = m.user_id
     WHERE m.status = 'active'
       AND (m.next_sync_at IS NULL OR m.next_sync_at <= now())
       AND (m.sync_lease_until IS NULL OR m.sync_lease_until < now())
       AND u.status = 'approved' AND u.access_expires_at > now()
     ORDER BY m.next_sync_at NULLS FIRST
     LIMIT p_limit
     FOR UPDATE OF m SKIP LOCKED
  )
  UPDATE mailboxes m SET sync_lease_until = now() + make_interval(secs => p_lease_seconds)
    FROM due WHERE m.id = due.id
  RETURNING m.id, m.user_id;
END $$;
REVOKE EXECUTE ON FUNCTION app.claim_sync_mailboxes(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_sync_mailboxes(int, int) TO {{role_worker}};

-- Empty threads (after mailbox deletion or moves) are removed by housekeeping.
CREATE OR REPLACE FUNCTION app.prune_operational_data() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE a int; t int; s int; u int; th int; op int;
BEGIN
  DELETE FROM login_attempts WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days';
  GET DIAGNOSTICS t = ROW_COUNT;
  DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
                          OR expires_at < now() - interval '30 days';
  GET DIAGNOSTICS s = ROW_COUNT;
  DELETE FROM users WHERE role = 'user' AND status = 'pending' AND email_verified_at IS NULL
                      AND created_at < now() - interval '7 days';
  GET DIAGNOSTICS u = ROW_COUNT;
  DELETE FROM threads th0 WHERE NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = th0.id)
                            AND th0.created_at < now() - interval '1 hour';
  GET DIAGNOSTICS th = ROW_COUNT;
  DELETE FROM mailbox_operations WHERE status IN ('done','superseded') AND completed_at < now() - interval '7 days';
  GET DIAGNOSTICS op = ROW_COUNT;
  RETURN jsonb_build_object('login_attempts', a, 'auth_tokens', t, 'sessions', s, 'unverified_users', u, 'threads', th, 'operations', op);
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON folders, threads, messages, message_locations, message_addresses, message_bodies,
  attachments, mailbox_operations TO {{role_api}}, {{role_worker}};

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['folders','threads','messages','message_locations','message_addresses','message_bodies',
                           'attachments','mailbox_operations'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON app.%I USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id())', t);
  END LOOP;
END $$;
