-- Milestone 6: encrypted blob storage, uploads, signatures, templates, drafts, scheduling.
SET LOCAL search_path = app, pg_catalog;

-- Per-user data key, wrapped with a key that is not stored in the database. Deleting this row makes
-- every stored file of the user unreadable, including copies that remain in backups.
CREATE TABLE user_keys (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wrapped_dek  bytea NOT NULL,
  key_version  int   NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256       bytea NOT NULL,                 -- of the plaintext; deduplication is per user only
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key  text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256),
  UNIQUE (id, user_id)
);

-- Platform copy of a received attachment (cached on first download or for inline images).
ALTER TABLE attachments ADD COLUMN blob_id uuid;
ALTER TABLE attachments ADD CONSTRAINT attachments_blob_fk FOREIGN KEY (blob_id) REFERENCES blobs (id) ON DELETE SET NULL;

-- Files uploaded from a device for an outgoing message.
CREATE TABLE uploads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  blob_id        uuid NOT NULL,
  filename       text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  declared_mime  text,
  detected_mime  text NOT NULL,
  size_bytes     bigint NOT NULL,
  risk_level     text NOT NULL CHECK (risk_level IN ('low','elevated','dangerous')),
  inline         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (blob_id, user_id) REFERENCES blobs (id, user_id) ON DELETE CASCADE
);
CREATE INDEX uploads_user_idx ON uploads (user_id, created_at);

CREATE TABLE signatures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  text_body   text NOT NULL CHECK (length(text_body) <= 10000),
  html_body   text CHECK (length(html_body) <= 50000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
ALTER TABLE mailboxes ADD COLUMN default_signature_id uuid;
ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_signature_fk FOREIGN KEY (default_signature_id) REFERENCES signatures (id) ON DELETE SET NULL;

CREATE TABLE templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('template','quick_reply')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  subject     text CHECK (length(subject) <= 998),
  text_body   text NOT NULL CHECK (length(text_body) <= 100000),
  html_body   text CHECK (length(html_body) <= 500000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, name)
);

CREATE TABLE drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  mailbox_id         uuid NOT NULL,
  compose_kind       text NOT NULL DEFAULT 'new' CHECK (compose_kind IN ('new','reply','reply_all','forward')),
  source_message_id  uuid,
  to_recipients      jsonb NOT NULL DEFAULT '[]',
  cc_recipients      jsonb NOT NULL DEFAULT '[]',
  bcc_recipients     jsonb NOT NULL DEFAULT '[]',
  subject            text NOT NULL DEFAULT '' CHECK (length(subject) <= 998),
  text_body          text NOT NULL DEFAULT '' CHECK (length(text_body) <= 2000000),
  html_body          text CHECK (length(html_body) <= 5000000),
  signature_id       uuid,
  upload_ids         uuid[] NOT NULL DEFAULT '{}',
  version            int  NOT NULL DEFAULT 1,
  updated_by_device  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);
CREATE INDEX drafts_user_idx ON drafts (user_id, updated_at DESC);

-- What a scheduled message was composed from, so it can be turned back into an editable draft.
ALTER TABLE outbound_messages ADD COLUMN compose_json jsonb;

-- Unused uploads and orphaned blobs are cleaned up by housekeeping.
CREATE OR REPLACE FUNCTION app.prune_operational_data() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE a int; t int; s int; u int; th int; op int; up int; ob int;
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
  DELETE FROM uploads up0 WHERE up0.created_at < now() - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM drafts d WHERE up0.id = ANY(d.upload_ids))
     AND NOT EXISTS (SELECT 1 FROM outbound_messages o WHERE o.status IN ('scheduled','queued','pending_undo','paused_suspended')
                       AND o.compose_json -> 'uploadIds' ? up0.id::text);
  GET DIAGNOSTICS up = ROW_COUNT;
  -- Sent messages no longer need their frozen copy after a week (the Sent folder has it).
  DELETE FROM outbound_mime om USING outbound_messages o
   WHERE o.id = om.outbound_id AND o.status IN ('sent','cancelled') AND o.updated_at < now() - interval '7 days';
  GET DIAGNOSTICS ob = ROW_COUNT;
  RETURN jsonb_build_object('login_attempts', a, 'auth_tokens', t, 'sessions', s, 'unverified_users', u, 'threads', th,
                            'operations', op, 'uploads', up, 'outbound_mime', ob);
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON user_keys, blobs, uploads, signatures, templates, drafts TO {{role_api}}, {{role_worker}};
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_keys','blobs','uploads','signatures','templates','drafts'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON app.%I USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id())', t);
  END LOOP;
END $$;
