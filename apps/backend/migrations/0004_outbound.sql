-- Milestone 4: outgoing mail with undo window, idempotent sending, attempts, and Sent-folder copies.
SET LOCAL search_path = app, pg_catalog;

ALTER TABLE platform_settings
  ADD COLUMN undo_send_seconds int NOT NULL DEFAULT 10 CHECK (undo_send_seconds BETWEEN 5 AND 30);

-- Conservative defaults typical of shared hosting (cPanel/Hostinger often cap at a few hundred per hour).
ALTER TABLE mailboxes ALTER COLUMN send_limit_per_hour SET DEFAULT 100;
ALTER TABLE mailboxes ALTER COLUMN max_recipients_per_msg SET DEFAULT 100;
UPDATE mailboxes SET send_limit_per_hour = coalesce(send_limit_per_hour, 100), max_recipients_per_msg = coalesce(max_recipients_per_msg, 100);

CREATE TABLE outbound_messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  mailbox_id         uuid NOT NULL,
  idempotency_key    uuid NOT NULL,                -- generated on the device when Send is first pressed
  message_id_header  text NOT NULL,                -- fixed before the first attempt
  compose_kind       text NOT NULL CHECK (compose_kind IN ('new','reply','reply_all','forward')),
  source_message_id  uuid,                          -- message replied to / forwarded
  subject            text,
  recipient_count    int  NOT NULL CHECK (recipient_count > 0),
  status             text NOT NULL CHECK (status IN ('pending_undo','scheduled','queued','sending','sent','failed',
                                                      'cancelled','uncertain','paused_suspended')),
  release_at         timestamptz,                  -- end of the undo window
  scheduled_at       timestamptz,
  scheduled_tz       text,
  attempt_count      int  NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz,
  lease_until        timestamptz,
  sent_at            timestamptz,                  -- the provider accepted it (SMTP 250 after DATA)
  provider_response  text,
  sent_copy_state    text NOT NULL DEFAULT 'pending' CHECK (sent_copy_state IN ('pending','not_needed','appended','failed')),
  last_error_code    text,
  last_error_message text,
  paused_from_status text,
  mime_bytes         bigint NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (id, user_id),
  CHECK (status <> 'pending_undo' OR release_at IS NOT NULL),
  CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);
CREATE INDEX outbound_due_idx ON outbound_messages (coalesce(next_attempt_at, release_at, scheduled_at))
  WHERE status IN ('pending_undo','scheduled','queued','sending');
CREATE INDEX outbound_user_idx ON outbound_messages (user_id, created_at DESC);
CREATE INDEX outbound_rate_idx ON outbound_messages (mailbox_id, sent_at) WHERE status = 'sent';
CREATE TRIGGER outbound_touch BEFORE UPDATE ON outbound_messages FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The exact bytes that are (or will be) submitted. Frozen at queue time so a retry is byte-identical.
-- Kept in the database for now; attachment storage (Milestone 6) moves large content to object storage.
CREATE TABLE outbound_mime (
  outbound_id  uuid PRIMARY KEY,
  user_id      uuid NOT NULL,
  mime         bytea NOT NULL,
  FOREIGN KEY (outbound_id, user_id) REFERENCES outbound_messages (id, user_id) ON DELETE CASCADE
);

CREATE TABLE outbound_recipients (
  outbound_id  uuid NOT NULL,
  user_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('to','cc','bcc')),
  position     int  NOT NULL,
  address      text NOT NULL,
  name         text,
  PRIMARY KEY (outbound_id, kind, position),
  FOREIGN KEY (outbound_id, user_id) REFERENCES outbound_messages (id, user_id) ON DELETE CASCADE
);

CREATE TABLE delivery_attempts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbound_id    uuid NOT NULL,
  user_id        uuid NOT NULL,
  attempt_no     int  NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  outcome        text CHECK (outcome IN ('accepted','temp_failure','perm_failure','uncertain','not_attempted')),
  smtp_code      int,
  response_text  text,
  UNIQUE (outbound_id, attempt_no),
  FOREIGN KEY (outbound_id, user_id) REFERENCES outbound_messages (id, user_id) ON DELETE CASCADE
);

-- Claims messages that are due: undo window over, or a retry is due. Moves them to 'sending' with a lease.
-- A 'sending' row whose lease expired means a worker died mid-send: it becomes 'uncertain', never resent automatically.
CREATE FUNCTION app.claim_outbound(p_limit int, p_lease_seconds int)
RETURNS TABLE (claim_id uuid, claim_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  UPDATE outbound_messages SET status = 'uncertain', lease_until = NULL, last_error_code = 'WORKER_INTERRUPTED',
         last_error_message = 'Sending was interrupted. The mail server may or may not have accepted the message.'
   WHERE status = 'sending' AND lease_until < now();

  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM outbound_messages o JOIN users u ON u.id = o.user_id JOIN mailboxes m ON m.id = o.mailbox_id
     WHERE ((o.status = 'pending_undo' AND o.release_at <= now())
         OR (o.status = 'scheduled' AND o.scheduled_at <= now())
         OR (o.status = 'queued' AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())))
       AND u.status = 'approved' AND u.access_expires_at > now()
       AND m.status IN ('active','error')
     ORDER BY coalesce(o.next_attempt_at, o.release_at, o.scheduled_at)
     LIMIT p_limit
     FOR UPDATE OF o SKIP LOCKED
  )
  UPDATE outbound_messages o SET status = 'sending', lease_until = now() + make_interval(secs => p_lease_seconds)
    FROM due WHERE o.id = due.id
  RETURNING o.id, o.user_id;
END $$;
REVOKE EXECUTE ON FUNCTION app.claim_outbound(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_outbound(int, int) TO {{role_worker}};

-- For the API's immediate send right after the undo window: claims one message, and only if it belongs
-- to the user of the current request (RLS context), so the API can never pick up other users' mail.
CREATE FUNCTION app.claim_outbound_one(p_id uuid, p_lease_seconds int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE n int;
BEGIN
  UPDATE outbound_messages o SET status = 'sending', lease_until = now() + make_interval(secs => p_lease_seconds)
    FROM users u, mailboxes m
   WHERE o.id = p_id AND o.user_id = app.current_user_id() AND u.id = o.user_id AND m.id = o.mailbox_id
     AND ((o.status = 'pending_undo' AND o.release_at <= now()) OR (o.status = 'queued' AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())))
     AND u.status = 'approved' AND u.access_expires_at > now() AND m.status IN ('active','error');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE EXECUTE ON FUNCTION app.claim_outbound_one(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_outbound_one(uuid, int) TO {{role_api}};

-- Suspension also pauses queued and scheduled sends. They never go out automatically after reactivation.
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
  UPDATE outbound_messages SET paused_from_status = status, status = 'paused_suspended', lease_until = NULL
   WHERE user_id = p_user AND status IN ('pending_undo','scheduled','queued');
  RETURN true;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON outbound_messages, outbound_mime, outbound_recipients, delivery_attempts
  TO {{role_api}}, {{role_worker}};
GRANT SELECT (undo_send_seconds) ON platform_settings TO {{role_api}};
GRANT SELECT (id, user_id, mailbox_id, status, recipient_count, attempt_count, sent_at, last_error_code, created_at)
  ON outbound_messages TO {{role_admin}};
GRANT SELECT (undo_send_seconds) ON platform_settings TO {{role_admin}};
GRANT UPDATE (undo_send_seconds) ON platform_settings TO {{role_admin}};

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbound_messages','outbound_mime','outbound_recipients','delivery_attempts'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON app.%I USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id())', t);
  END LOOP;
END $$;
CREATE POLICY admin_read ON outbound_messages FOR SELECT TO {{role_admin}} USING (true);
