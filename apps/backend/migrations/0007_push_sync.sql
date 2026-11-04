-- Milestone 7: push notifications, notification preferences, and a change feed for multi-device sync.
SET LOCAL search_path = app, pg_catalog;

ALTER TABLE devices ADD COLUMN push_provider text CHECK (push_provider IN ('expo','fcm'));
ALTER TABLE devices ADD COLUMN push_token_updated_at timestamptz;
CREATE UNIQUE INDEX devices_push_token_unique ON devices (push_token) WHERE push_token IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE notification_preferences (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id     uuid,                          -- NULL row = the user's defaults
  new_mail       boolean NOT NULL DEFAULT true,
  send_problems  boolean NOT NULL DEFAULT true,
  mailbox_problems boolean NOT NULL DEFAULT true,
  reminders      boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailboxes (id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX notification_preferences_unique
  ON notification_preferences (user_id, coalesce(mailbox_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- One row per notification per device. dedupe_key makes repeated sync runs harmless.
CREATE TABLE notification_outbox (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL,
  device_id   uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('new_mail','send_problem','mailbox_problem','reminder','account')),
  dedupe_key  text NOT NULL,
  title       text NOT NULL CHECK (length(title) <= 200),  -- never contains sender or subject
  body        text CHECK (length(body) <= 300),
  data        jsonb NOT NULL DEFAULT '{}',                  -- ids only
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dropped')),
  attempts    int  NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  UNIQUE (device_id, dedupe_key),
  FOREIGN KEY (device_id, user_id) REFERENCES devices (id, user_id) ON DELETE CASCADE
);
CREATE INDEX notification_outbox_pending_idx ON notification_outbox (created_at) WHERE status = 'pending';

-- Ordered log of changes, read by devices with GET /v1/sync/changes?since=<seq>.
CREATE TABLE change_feed (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Not a foreign key: rows written while a user is being deleted must not block the deletion.
  -- Orphaned rows hold ids only and are pruned with the rest of the feed.
  user_id     uuid NOT NULL,
  entity      text NOT NULL CHECK (entity IN ('message','draft','outbound','mailbox','folder')),
  entity_id   uuid NOT NULL,
  op          text NOT NULL CHECK (op IN ('upsert','delete')),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_feed_user_seq_idx ON change_feed (user_id, seq);

CREATE FUNCTION app.record_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  -- Nothing to tell the devices of a user that is being deleted.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM app.users WHERE id = r.user_id) THEN RETURN NULL; END IF;
  INSERT INTO app.change_feed (user_id, entity, entity_id, op)
  VALUES (r.user_id, TG_ARGV[0], r.id, CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  RETURN NULL;
END $$;

CREATE TRIGGER messages_change AFTER INSERT OR UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION app.record_change('message');
CREATE TRIGGER drafts_change AFTER INSERT OR UPDATE OR DELETE ON drafts FOR EACH ROW EXECUTE FUNCTION app.record_change('draft');
CREATE TRIGGER outbound_change AFTER INSERT OR UPDATE OR DELETE ON outbound_messages FOR EACH ROW EXECUTE FUNCTION app.record_change('outbound');
CREATE TRIGGER mailboxes_change AFTER INSERT OR UPDATE OR DELETE ON mailboxes FOR EACH ROW EXECUTE FUNCTION app.record_change('mailbox');

-- Claims pending notifications across users for the dispatcher (worker only).
CREATE FUNCTION app.claim_notifications(p_limit int)
RETURNS TABLE (n_id bigint, n_user_id uuid, n_device_id uuid, n_token text, n_provider text, n_title text, n_body text, n_data jsonb, n_kind text, n_attempts int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  -- Signed-out devices, or devices without a working token, get nothing.
  UPDATE notification_outbox o SET status = 'dropped', last_error = 'device signed out or has no push token'
    FROM devices d
   WHERE o.status = 'pending' AND d.id = o.device_id AND (d.revoked_at IS NOT NULL OR NOT d.push_enabled OR d.push_token IS NULL);
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM notification_outbox o WHERE o.status = 'pending' ORDER BY o.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  UPDATE notification_outbox o SET attempts = o.attempts + 1 FROM due, devices d
   WHERE o.id = due.id AND d.id = o.device_id
  RETURNING o.id, o.user_id, o.device_id, d.push_token, d.push_provider, o.title, o.body, o.data, o.kind, o.attempts;
END $$;

-- Records dispatch results; a token the push service rejects as unknown is switched off.
CREATE FUNCTION app.finish_notification(p_id bigint, p_status text, p_error text, p_disable_token boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE dev uuid;
BEGIN
  UPDATE notification_outbox SET status = p_status, last_error = left(p_error, 300),
         sent_at = CASE WHEN p_status = 'sent' THEN now() END
   WHERE id = p_id RETURNING device_id INTO dev;
  IF p_disable_token THEN
    UPDATE devices SET push_token = NULL, push_enabled = false WHERE id = dev;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.prune_change_feed() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE n int; m int;
BEGIN
  DELETE FROM change_feed WHERE changed_at < now() - interval '30 days'
                             OR NOT EXISTS (SELECT 1 FROM users WHERE id = change_feed.user_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM notification_outbox WHERE created_at < now() - interval '7 days' AND status <> 'pending';
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END $$;

-- Registers a push token for the caller's device. A token can belong to only one device: if the phone
-- was signed in to another account before, that other device stops receiving this phone's notifications.
CREATE FUNCTION app.assign_push_token(p_device uuid, p_token text, p_provider text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM devices WHERE id = p_device AND user_id = app.current_user_id() AND revoked_at IS NULL) THEN
    RETURN false;
  END IF;
  UPDATE devices SET push_token = NULL WHERE push_token = p_token AND id <> p_device;
  UPDATE devices SET push_token = p_token, push_provider = p_provider, push_token_updated_at = now(), push_enabled = true WHERE id = p_device;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

REVOKE EXECUTE ON FUNCTION app.assign_push_token(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assign_push_token(uuid, text, text) TO {{role_api}};

REVOKE EXECUTE ON FUNCTION app.claim_notifications(int), app.finish_notification(bigint, text, text, boolean), app.prune_change_feed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_notifications(int), app.finish_notification(bigint, text, text, boolean), app.prune_change_feed() TO {{role_worker}};

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences, notification_outbox TO {{role_api}}, {{role_worker}};
GRANT SELECT, INSERT ON change_feed TO {{role_api}}, {{role_worker}};
GRANT UPDATE (push_token, push_provider, push_token_updated_at, push_enabled) ON devices TO {{role_api}};
GRANT SELECT ON devices TO {{role_worker}};
CREATE POLICY worker_tenant ON devices FOR SELECT TO {{role_worker}} USING (user_id = app.current_user_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_preferences','notification_outbox','change_feed'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON app.%I USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id())', t);
  END LOOP;
END $$;
