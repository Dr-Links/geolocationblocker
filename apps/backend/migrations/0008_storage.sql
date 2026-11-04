-- Milestone 8: storage accounting, quotas, retention and eviction, blob garbage collection.
SET LOCAL search_path = app, pg_catalog;

-- Running totals per user, kept up to date by triggers. Message metadata is counted at a flat
-- 2 KB per message (headers, addresses, search index), so the figure is an estimate, not a byte count.
CREATE TABLE storage_usage (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body_bytes     bigint NOT NULL DEFAULT 0,
  blob_bytes     bigint NOT NULL DEFAULT 0,
  message_count  bigint NOT NULL DEFAULT 0,
  warned_level   smallint NOT NULL DEFAULT 0 CHECK (warned_level BETWEEN 0 AND 2),  -- 1 = 80 %, 2 = full
  warned_at      timestamptz,
  last_evicted_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE storage_preferences (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Keep the text of messages that are still on the mail server for this many days (NULL = keep).
  -- Older ones are fetched again from the server when opened. Messages deleted from the server are never evicted.
  body_retention_days  int CHECK (body_retention_days IS NULL OR body_retention_days BETWEEN 7 AND 3650),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Storage objects whose database row is gone; the worker deletes the objects and then these rows.
CREATE TABLE blob_tombstones (
  storage_key  text PRIMARY KEY,
  next_try_at  timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachments_blob_idx ON attachments (blob_id) WHERE blob_id IS NOT NULL;
CREATE INDEX uploads_blob_idx ON uploads (blob_id);
CREATE INDEX blobs_created_idx ON blobs (created_at);

CREATE FUNCTION app.add_usage(p_user uuid, p_body bigint, p_blob bigint, p_count bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  UPDATE storage_usage SET body_bytes = greatest(0, body_bytes + p_body), blob_bytes = greatest(0, blob_bytes + p_blob),
         message_count = greatest(0, message_count + p_count), updated_at = now()
   WHERE user_id = p_user;
  IF NOT FOUND AND EXISTS (SELECT 1 FROM users WHERE id = p_user) THEN
    INSERT INTO storage_usage (user_id, body_bytes, blob_bytes, message_count)
    VALUES (p_user, greatest(0, p_body), greatest(0, p_blob), greatest(0, p_count))
    ON CONFLICT (user_id) DO UPDATE SET body_bytes = greatest(0, storage_usage.body_bytes + p_body),
       blob_bytes = greatest(0, storage_usage.blob_bytes + p_blob), message_count = greatest(0, storage_usage.message_count + p_count);
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION app.add_usage(uuid, bigint, bigint, bigint) FROM PUBLIC;

CREATE FUNCTION app.track_body_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM app.add_usage(NEW.user_id, NEW.stored_bytes, 0, 0);
  ELSIF TG_OP = 'UPDATE' THEN PERFORM app.add_usage(NEW.user_id, NEW.stored_bytes - OLD.stored_bytes, 0, 0);
  ELSE PERFORM app.add_usage(OLD.user_id, -OLD.stored_bytes, 0, 0);
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION app.track_blob_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM app.add_usage(NEW.user_id, 0, NEW.size_bytes, 0);
  ELSE
    PERFORM app.add_usage(OLD.user_id, 0, -OLD.size_bytes, 0);
    INSERT INTO blob_tombstones (storage_key) VALUES (OLD.storage_key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION app.track_message_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM app.add_usage(NEW.user_id, 0, 0, 1);
  ELSE PERFORM app.add_usage(OLD.user_id, 0, 0, -1);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER message_bodies_usage AFTER INSERT OR UPDATE OF stored_bytes OR DELETE ON message_bodies
  FOR EACH ROW EXECUTE FUNCTION app.track_body_usage();
CREATE TRIGGER blobs_usage AFTER INSERT OR DELETE ON blobs FOR EACH ROW EXECUTE FUNCTION app.track_blob_usage();
CREATE TRIGGER messages_usage AFTER INSERT OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION app.track_message_usage();

-- Existing data.
INSERT INTO storage_usage (user_id, body_bytes, blob_bytes, message_count)
SELECT u.id,
       coalesce((SELECT sum(stored_bytes) FROM message_bodies WHERE user_id = u.id), 0),
       coalesce((SELECT sum(size_bytes) FROM blobs WHERE user_id = u.id), 0),
       (SELECT count(*) FROM messages WHERE user_id = u.id)
  FROM users u WHERE u.role = 'user';

-- Usage and limit for one user. state: ok (< 80 %), warning (>= 80 %), full (>= 100 %: new mail text and
-- attachment copies are no longer stored; headers still sync and nothing is lost on the mail server).
CREATE FUNCTION app.storage_status(p_user uuid)
RETURNS TABLE (used_bytes bigint, quota_bytes bigint, body_bytes bigint, blob_bytes bigint, message_count bigint, state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_catalog AS $$
  SELECT x.used, x.quota, x.body_bytes, x.blob_bytes, x.message_count,
         CASE WHEN x.used >= x.quota THEN 'full' WHEN x.used >= x.quota * 0.8 THEN 'warning' ELSE 'ok' END
    FROM (SELECT coalesce(s.body_bytes, 0) + coalesce(s.blob_bytes, 0) + coalesce(s.message_count, 0) * 2048 AS used,
                 coalesce(u.storage_quota_bytes, p.default_quota_bytes) AS quota,
                 coalesce(s.body_bytes, 0) AS body_bytes, coalesce(s.blob_bytes, 0) AS blob_bytes, coalesce(s.message_count, 0) AS message_count
            FROM users u CROSS JOIN platform_settings p LEFT JOIN storage_usage s ON s.user_id = u.id
           WHERE u.id = p_user) x
$$;

-- The caller's own status (api and worker, inside withUser).
CREATE FUNCTION app.my_storage_status()
RETURNS TABLE (used_bytes bigint, quota_bytes bigint, body_bytes bigint, blob_bytes bigint, message_count bigint, state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_catalog AS $$
  SELECT * FROM app.storage_status(app.current_user_id())
$$;

/*
 * Retention and quota pressure for users that need it. Only copies that can be fetched again are
 * removed: text of messages still on the mail server, and cached copies of their attachments.
 * Returns one row per user that crossed a warning level upwards, so the caller can notify them.
 */
CREATE FUNCTION app.apply_storage_policy(p_users int DEFAULT 50, p_batch int DEFAULT 2000)
RETURNS TABLE (s_user_id uuid, s_evicted_bodies int, s_evicted_attachments int, s_level smallint, s_notify boolean, s_used bigint, s_quota bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE
  r record; st record; nb int; na int; extra int; lvl smallint; need bigint; freed bigint;
BEGIN
  FOR r IN
    SELECT u.id, sp.body_retention_days, su.warned_level
      FROM users u
      LEFT JOIN storage_preferences sp ON sp.user_id = u.id
      LEFT JOIN storage_usage su ON su.user_id = u.id
     WHERE u.role = 'user' AND u.status IN ('approved','suspended')
       AND (sp.body_retention_days IS NOT NULL OR coalesce(su.warned_level, 0) > 0
            OR (SELECT s.used_bytes >= s.quota_bytes * 0.8 FROM app.storage_status(u.id) s))
     ORDER BY su.last_evicted_at NULLS FIRST
     LIMIT p_users
  LOOP
    nb := 0; na := 0;
    IF r.body_retention_days IS NOT NULL THEN
      WITH old AS (
        SELECT b.message_id FROM message_bodies b JOIN messages m ON m.id = b.message_id
         WHERE b.user_id = r.id AND m.server_state = 'present' AND NOT m.is_draft
           AND m.received_at < now() - make_interval(days => r.body_retention_days)
         LIMIT p_batch
      ), del AS (DELETE FROM message_bodies b USING old WHERE b.message_id = old.message_id RETURNING b.message_id)
      UPDATE messages SET body_state = 'evicted' FROM del WHERE messages.id = del.message_id;
      GET DIAGNOSTICS nb = ROW_COUNT;
      UPDATE attachments a SET blob_id = NULL FROM messages m
       WHERE a.message_id = m.id AND a.user_id = r.id AND a.blob_id IS NOT NULL AND m.server_state = 'present'
         AND m.received_at < now() - make_interval(days => r.body_retention_days);
      GET DIAGNOSTICS na = ROW_COUNT;
    END IF;

    SELECT * INTO st FROM app.storage_status(r.id);
    IF st.used_bytes > st.quota_bytes * 0.95 THEN
      need := st.used_bytes - (st.quota_bytes * 0.85)::bigint;
      -- Cached attachment copies first (large, and easy to fetch again), oldest first, until enough is freed.
      WITH c AS (
        SELECT a.id, a.size_bytes, sum(a.size_bytes) OVER (ORDER BY m.received_at, a.id) AS running
          FROM attachments a JOIN messages m ON m.id = a.message_id
         WHERE a.user_id = r.id AND a.blob_id IS NOT NULL AND m.server_state = 'present'
      ), pick AS (SELECT id, size_bytes FROM c WHERE running - size_bytes < need),
      upd AS (UPDATE attachments a SET blob_id = NULL FROM pick WHERE a.id = pick.id RETURNING pick.size_bytes)
      SELECT count(*), coalesce(sum(size_bytes), 0) INTO extra, freed FROM upd;
      na := na + extra;
      need := need - freed;
      -- Then message text, oldest first.
      IF need > 0 THEN
        WITH c AS (
          SELECT b.message_id, b.stored_bytes, sum(b.stored_bytes) OVER (ORDER BY m.received_at, b.message_id) AS running
            FROM message_bodies b JOIN messages m ON m.id = b.message_id
           WHERE b.user_id = r.id AND m.server_state = 'present' AND NOT m.is_draft
        ), pick AS (SELECT message_id FROM c WHERE running - stored_bytes < need LIMIT p_batch),
        del AS (DELETE FROM message_bodies b USING pick WHERE b.message_id = pick.message_id RETURNING b.message_id)
        UPDATE messages SET body_state = 'evicted' FROM del WHERE messages.id = del.message_id;
        GET DIAGNOSTICS extra = ROW_COUNT;
        nb := nb + extra;
      END IF;
    END IF;

    SELECT * INTO st FROM app.storage_status(r.id);
    lvl := CASE st.state WHEN 'full' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END;
    -- Levels go down only once usage is clearly lower, so a user hovering at 80 % is not told twice.
    IF lvl = 0 AND st.used_bytes >= st.quota_bytes * 0.7 THEN lvl := least(coalesce(r.warned_level, 0), 1)::smallint; END IF;
    INSERT INTO storage_usage (user_id) VALUES (r.id) ON CONFLICT DO NOTHING;
    UPDATE storage_usage SET last_evicted_at = now(), warned_level = lvl,
           warned_at = CASE WHEN lvl > coalesce(r.warned_level, 0) THEN now() ELSE warned_at END
     WHERE user_id = r.id;
    s_user_id := r.id; s_evicted_bodies := nb; s_evicted_attachments := na; s_level := lvl;
    s_notify := lvl > coalesce(r.warned_level, 0); s_used := st.used_bytes; s_quota := st.quota_bytes;
    RETURN NEXT;
  END LOOP;
END $$;

-- Deletes blobs nothing refers to any more (older than an hour, so a file being attached right now is safe).
CREATE FUNCTION app.gc_blobs(p_limit int DEFAULT 500) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE n int;
BEGIN
  DELETE FROM blobs b WHERE b.id IN (
    SELECT b2.id FROM blobs b2
     WHERE b2.created_at < now() - interval '1 hour'
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.blob_id = b2.id)
       AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.blob_id = b2.id)
     LIMIT p_limit);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION app.claim_blob_tombstones(p_limit int DEFAULT 200) RETURNS TABLE (t_key text)
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
  WITH due AS (SELECT storage_key FROM blob_tombstones WHERE next_try_at <= now() ORDER BY next_try_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE blob_tombstones t SET attempts = t.attempts + 1,
         next_try_at = now() + least(interval '1 hour' * t.attempts, interval '1 day') + interval '5 minutes'
    FROM due WHERE t.storage_key = due.storage_key RETURNING t.storage_key
$$;

CREATE FUNCTION app.finish_blob_tombstones(p_keys text[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
  DELETE FROM blob_tombstones WHERE storage_key = ANY(p_keys)
$$;

-- Usage for every user, for the admin dashboard.
CREATE FUNCTION app.storage_overview()
RETURNS TABLE (o_user_id uuid, o_used bigint, o_quota bigint, o_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_catalog AS $$
  SELECT u.id, s.used_bytes, s.quota_bytes, s.state FROM users u, app.storage_status(u.id) s WHERE u.role = 'user'
$$;

REVOKE EXECUTE ON FUNCTION app.storage_status(uuid), app.my_storage_status(), app.apply_storage_policy(int, int), app.gc_blobs(int),
  app.claim_blob_tombstones(int), app.finish_blob_tombstones(text[]), app.storage_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_storage_status() TO {{role_api}}, {{role_worker}};
GRANT EXECUTE ON FUNCTION app.apply_storage_policy(int, int), app.gc_blobs(int), app.claim_blob_tombstones(int),
  app.finish_blob_tombstones(text[]) TO {{role_worker}};
GRANT EXECUTE ON FUNCTION app.storage_status(uuid), app.storage_overview() TO {{role_admin}};

GRANT SELECT ON storage_usage TO {{role_api}}, {{role_worker}};
GRANT SELECT, INSERT, UPDATE ON storage_preferences TO {{role_api}};
GRANT SELECT ON storage_preferences TO {{role_worker}};
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['storage_usage','storage_preferences'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON app.%I USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id())', t);
  END LOOP;
END $$;
