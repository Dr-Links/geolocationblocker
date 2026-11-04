-- Milestone 10: heartbeats of background jobs, so a stopped cron job is noticed.
SET LOCAL search_path = app, pg_catalog;

CREATE TABLE heartbeats (
  name        text PRIMARY KEY CHECK (name IN ('scheduler','sync','send','push','backup')),
  last_at     timestamptz NOT NULL DEFAULT now(),
  detail      jsonb NOT NULL DEFAULT '{}'
);

CREATE FUNCTION app.beat(p_name text, p_detail jsonb DEFAULT '{}') RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
  INSERT INTO heartbeats (name, last_at, detail) VALUES (p_name, now(), coalesce(p_detail, '{}'))
  ON CONFLICT (name) DO UPDATE SET last_at = now(), detail = EXCLUDED.detail
$$;

-- Seconds since each job last ran (NULL = never). Readable by the API for /readyz and by the admin.
CREATE FUNCTION app.heartbeat_ages() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_catalog AS $$
  SELECT coalesce(jsonb_object_agg(name, extract(epoch FROM now() - last_at)::int), '{}'::jsonb) FROM heartbeats
$$;

REVOKE EXECUTE ON FUNCTION app.beat(text, jsonb), app.heartbeat_ages() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.beat(text, jsonb) TO {{role_worker}}, {{role_api}};
GRANT EXECUTE ON FUNCTION app.heartbeat_ages() TO {{role_api}}, {{role_admin}}, {{role_worker}};

-- Admin dashboard: include job heartbeats in the health figures.
CREATE OR REPLACE FUNCTION app.platform_health() RETURNS jsonb
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
    'lastSuccessfulBackupAt', (SELECT max(finished_at) FROM backup_runs WHERE status = 'succeeded'),
    'jobAgesSeconds', app.heartbeat_ages()
  )
$$;
