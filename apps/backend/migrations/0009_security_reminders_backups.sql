-- Milestone 9: follow-up reminders, sender blocklists, malware scan results, backups, deletion ledger.
SET LOCAL search_path = app, pg_catalog;

-- Follow-up reminders on a message. "only_if_no_reply": cancelled automatically when someone else replies.
CREATE TABLE reminders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,
  message_id       uuid NOT NULL,
  remind_at        timestamptz NOT NULL,
  only_if_no_reply boolean NOT NULL DEFAULT false,
  note             text CHECK (length(note) <= 500),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fired','cancelled','replied')),
  fired_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id),                                       -- one active reminder per message (replaced on change)
  FOREIGN KEY (message_id, user_id) REFERENCES messages (id, user_id) ON DELETE CASCADE
);
CREATE INDEX reminders_due_idx ON reminders (remind_at) WHERE status = 'pending';
CREATE INDEX reminders_user_idx ON reminders (user_id, status, remind_at);

-- A user's own blocked senders: an address (a@b.com) or a whole domain (@b.com).
CREATE TABLE blocked_senders (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern     text NOT NULL CHECK (pattern = lower(pattern) AND pattern ~ '^([^@\s]+@|@)[^@\s]+\.[^@\s]+$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pattern)
);

-- Platform-wide blocklist managed by the admin (known phishing/spam senders).
CREATE TABLE platform_blocklist (
  pattern     text PRIMARY KEY CHECK (pattern = lower(pattern) AND pattern ~ '^([^@\s]+@|@)[^@\s]+\.[^@\s]+$'),
  reason      text CHECK (length(reason) <= 300),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Whether a sender is blocked for the current user (own list or platform list).
CREATE FUNCTION app.sender_blocked(p_address text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_catalog AS $$
  SELECT CASE
    WHEN p_address IS NULL OR position('@' in p_address) = 0 THEN NULL
    WHEN EXISTS (SELECT 1 FROM blocked_senders WHERE user_id = app.current_user_id()
                  AND pattern IN (lower(p_address), '@' || split_part(lower(p_address), '@', 2))) THEN 'user'
    WHEN EXISTS (SELECT 1 FROM platform_blocklist WHERE pattern IN (lower(p_address), '@' || split_part(lower(p_address), '@', 2))) THEN 'platform'
  END
$$;

-- Malware scan result of an attachment (when ClamAV is configured).
ALTER TABLE attachments ADD COLUMN scan_status text CHECK (scan_status IN ('clean','infected','error'));
ALTER TABLE attachments ADD COLUMN scan_detail text CHECK (length(scan_detail) <= 200);
ALTER TABLE attachments ADD COLUMN scanned_at timestamptz;

-- Backup runs, written by the backup command (shown on the admin dashboard).
CREATE TABLE backup_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  target       text NOT NULL,
  object_key   text,
  size_bytes   bigint,
  error        text CHECK (length(error) <= 1000)
);

-- Due reminders across users (worker). Reminders of messages that got a reply from someone else are closed.
CREATE FUNCTION app.claim_reminders(p_limit int DEFAULT 200)
RETURNS TABLE (r_id uuid, r_user_id uuid, r_message_id uuid, r_mailbox_id uuid, r_mailbox_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  UPDATE reminders r SET status = 'replied', fired_at = now()
    FROM messages m
   WHERE r.status = 'pending' AND r.only_if_no_reply AND r.remind_at <= now() AND m.id = r.message_id
     AND EXISTS (
       SELECT 1 FROM messages x
        WHERE x.thread_id = m.thread_id AND x.user_id = m.user_id AND x.id <> m.id
          -- Later, or (receive times have one-second precision) explicitly a reply to it.
          AND (x.received_at > m.received_at OR (x.received_at = m.received_at AND m.message_id_header IS NOT NULL
               AND (x.in_reply_to = m.message_id_header OR m.message_id_header = ANY(x.references_ids))))
          AND x.from_address IS NOT NULL
          AND lower(x.from_address) NOT IN (SELECT lower(email_address) FROM mailboxes WHERE user_id = m.user_id));
  RETURN QUERY
  WITH due AS (
    SELECT r.id FROM reminders r JOIN users u ON u.id = r.user_id
     WHERE r.status = 'pending' AND r.remind_at <= now() AND u.status = 'approved'
     ORDER BY r.remind_at LIMIT p_limit FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE reminders r SET status = 'fired', fired_at = now()
    FROM due, messages m, mailboxes mb
   WHERE r.id = due.id AND m.id = r.message_id AND mb.id = m.mailbox_id
  RETURNING r.id, r.user_id, r.message_id, mb.id, mb.email_address;
END $$;

-- Deletion ledger: user deletions are also written outside the database (see backups), so a restored
-- backup can be cleaned up again. This function lets the restore tool re-apply one.
CREATE FUNCTION app.reapply_user_deletion(p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE n int;
BEGIN
  DELETE FROM users WHERE id = p_user AND role = 'user';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;

REVOKE EXECUTE ON FUNCTION app.sender_blocked(text), app.claim_reminders(int), app.reapply_user_deletion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sender_blocked(text) TO {{role_api}}, {{role_worker}};
GRANT EXECUTE ON FUNCTION app.claim_reminders(int) TO {{role_worker}};
GRANT EXECUTE ON FUNCTION app.reapply_user_deletion(uuid) TO {{role_admin}};

GRANT SELECT, INSERT, UPDATE, DELETE ON reminders, blocked_senders TO {{role_api}};
GRANT SELECT, UPDATE ON reminders TO {{role_worker}};
GRANT SELECT ON blocked_senders TO {{role_worker}};
GRANT SELECT, INSERT, DELETE ON platform_blocklist TO {{role_admin}};
GRANT UPDATE (reason) ON platform_blocklist TO {{role_admin}};
GRANT SELECT, INSERT, UPDATE ON backup_runs TO {{role_admin}};
GRANT SELECT ON backup_runs TO {{role_worker}};

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reminders','blocked_senders'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON app.%I USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id())', t);
  END LOOP;
END $$;

-- Admin dashboard health figures.
CREATE FUNCTION app.platform_health() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_catalog AS $$
  SELECT jsonb_build_object(
    'outboundWaiting', (SELECT count(*) FROM outbound_messages WHERE status IN ('queued','sending')),
    'outboundOldestWaitingSeconds', (SELECT extract(epoch FROM now() - min(release_at))::int FROM outbound_messages WHERE status = 'queued' AND release_at <= now()),
    'outboundUncertain', (SELECT count(*) FROM outbound_messages WHERE status = 'uncertain'),
    'notificationsPending', (SELECT count(*) FROM notification_outbox WHERE status = 'pending'),
    'notificationsFailed24h', (SELECT count(*) FROM notification_outbox WHERE status = 'failed' AND created_at > now() - interval '24 hours'),
    'mailboxesSyncLagging', (SELECT count(*) FROM mailboxes WHERE status = 'active' AND (last_full_sync_at IS NULL OR last_full_sync_at < now() - interval '30 minutes')),
    'operationsFailed24h', (SELECT count(*) FROM mailbox_operations WHERE status = 'failed' AND created_at > now() - interval '24 hours'),
    'fileDeletesBacklog', (SELECT count(*) FROM blob_tombstones),
    'remindersDue', (SELECT count(*) FROM reminders WHERE status = 'pending' AND remind_at <= now()),
    'infectedAttachments30d', (SELECT count(*) FROM attachments WHERE scan_status = 'infected' AND scanned_at > now() - interval '30 days'),
    'lastBackup', (SELECT jsonb_build_object('status', status, 'startedAt', started_at, 'finishedAt', finished_at, 'sizeBytes', size_bytes, 'error', error)
                     FROM backup_runs ORDER BY started_at DESC LIMIT 1),
    'lastSuccessfulBackupAt', (SELECT max(finished_at) FROM backup_runs WHERE status = 'succeeded')
  )
$$;
REVOKE EXECUTE ON FUNCTION app.platform_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_health() TO {{role_admin}};
