-- Milestone 1: accounts, sessions, admin, access periods, audit.
-- Requires PostgreSQL 13+ and no extensions (works on cPanel-managed PostgreSQL).
-- Placeholders {{role_auth}}, {{role_api}}, {{role_admin}}, {{role_worker}} are replaced by the
-- migration runner with the configured database user names (quoted identifiers).

CREATE SCHEMA IF NOT EXISTS app;
SET LOCAL search_path = app, pg_catalog;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Calendar-month arithmetic in a given IANA time zone. PostgreSQL clamps to the last
-- day of the month (31 Jan + 1 month = 28/29 Feb) and keeps local wall-clock time across DST.
CREATE FUNCTION app.add_calendar_month(ts timestamptz, tz text) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT ((ts AT TIME ZONE tz) + interval '1 month') AT TIME ZONE tz
$$;

-- ---------------------------------------------------------------------------
CREATE TABLE platform_settings (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  default_timezone      text    NOT NULL DEFAULT 'UTC',      -- used only if a user's tz is unknown
  default_quota_bytes   bigint  NOT NULL DEFAULT 5368709120 CHECK (default_quota_bytes > 0),
  admin_notify_email    text    CHECK (admin_notify_email IS NULL OR admin_notify_email = lower(admin_notify_email)),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings DEFAULT VALUES;

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized      text   NOT NULL CHECK (email_normalized = lower(email_normalized)),
  email_display         text   NOT NULL,
  password_hash         text   NOT NULL,
  role                  text   NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status                text   NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','suspended','rejected','deleting')),
  suspension_reason     text   CHECK (suspension_reason IN ('expired','admin_action')),
  timezone              text   NOT NULL DEFAULT 'UTC',
  email_verified_at     timestamptz,
  approved_at           timestamptz,
  approved_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  access_expires_at     timestamptz,
  suspended_at          timestamptz,
  rejected_at           timestamptz,
  expiry_warned_3d_at   timestamptz,
  expiry_warned_1d_at   timestamptz,
  storage_quota_bytes   bigint CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes >= 0),
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  failed_login_count    int    NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email_normalized),
  CONSTRAINT users_gmail_only CHECK (role = 'admin' OR email_normalized ~ '^[a-z0-9]+@gmail\.com$'),
  CONSTRAINT users_suspension_consistent CHECK ((status = 'suspended') = (suspension_reason IS NOT NULL)),
  CONSTRAINT users_approved_has_expiry CHECK (status <> 'approved' OR access_expires_at IS NOT NULL)
);
CREATE UNIQUE INDEX users_single_admin ON users ((role)) WHERE role = 'admin';
CREATE INDEX users_status_idx ON users (status, created_at);
CREATE INDEX users_expiry_idx ON users (access_expires_at) WHERE status = 'approved';
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE access_periods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('approval','renewal','reactivation')),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  timezone_used  text NOT NULL,
  granted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  payment_note   text CHECK (length(payment_note) <= 500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX access_periods_user_idx ON access_periods (user_id, starts_at DESC);

CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('email_verify','password_reset','admin_recovery','admin_emergency')),
  token_hash  bytea NOT NULL UNIQUE,
  created_ip  inet,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose, created_at DESC);

CREATE TABLE mfa_factors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('totp','recovery_code')),
  secret_enc      bytea,
  code_hash       text,
  last_used_step  bigint,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'totp') = (secret_enc IS NOT NULL)),
  CHECK ((kind = 'recovery_code') = (code_hash IS NOT NULL))
);
CREATE INDEX mfa_factors_user_idx ON mfa_factors (user_id, kind);

CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     text NOT NULL CHECK (platform IN ('android','ios','web')),
  name         text CHECK (length(name) <= 100),
  app_version  text CHECK (length(app_version) <= 40),
  push_token   text,
  push_enabled boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX devices_user_idx ON devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id           uuid,
  kind                text NOT NULL CHECK (kind IN ('mobile','web','admin')),
  family_id           uuid NOT NULL,
  refresh_token_hash  bytea NOT NULL UNIQUE,
  previous_token_hash bytea,
  mfa_verified_at     timestamptz,
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
CREATE INDEX sessions_previous_idx ON sessions (previous_token_hash) WHERE previous_token_hash IS NOT NULL;

CREATE TABLE login_attempts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_normalized  text,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  ip                inet,
  surface           text NOT NULL CHECK (surface IN ('app','admin','admin_mfa')),
  success           boolean NOT NULL,
  failure_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts (email_normalized, created_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, created_at DESC);

CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_type      text NOT NULL CHECK (actor_type IN ('admin','user','system')),
  actor_user_id   uuid,
  action          text NOT NULL,
  target_type     text,
  target_id       uuid,
  target_user_id  uuid,
  ip              inet,
  details         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_time_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_user_id, occurred_at DESC);

CREATE TABLE deletion_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type   text NOT NULL CHECK (subject_type IN ('user','mailbox')),
  subject_id     uuid NOT NULL,
  user_id        uuid NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('disconnect_retain','purge')),
  requested_by   uuid,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  completed_at   timestamptz,
  last_error     text
);

-- ---------------------------------------------------------------------------
-- Lifecycle functions (SECURITY DEFINER: run with the owner's rights, callable only
-- by the roles granted below). Later milestones extend apply_suspension /
-- apply_reactivation to pause mailboxes and scheduled sends.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.apply_suspension(p_user uuid, p_reason text) RETURNS boolean
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
  RETURN true;
END $$;

-- Grants (or renews) a calendar month of access in the user's own time zone.
-- p_mode: 'approve' (pending -> approved), 'from_now', 'from_current_expiry'.
CREATE FUNCTION app.grant_access(p_user uuid, p_admin uuid, p_mode text, p_note text)
RETURNS TABLE (starts_at timestamptz, ends_at timestamptz, timezone_used text, previous_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE
  u record;
  v_start timestamptz;
  v_end timestamptz;
  v_kind text;
BEGIN
  SELECT id, status, access_expires_at, timezone, email_verified_at
    INTO u FROM users WHERE id = p_user AND role = 'user' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'P0002'; END IF;

  IF p_mode = 'approve' THEN
    IF u.status <> 'pending' THEN RAISE EXCEPTION 'not_pending' USING ERRCODE = 'P0001'; END IF;
    IF u.email_verified_at IS NULL THEN RAISE EXCEPTION 'email_not_verified' USING ERRCODE = 'P0001'; END IF;
    v_start := now(); v_kind := 'approval';
  ELSIF p_mode IN ('from_now','from_current_expiry') THEN
    IF u.status NOT IN ('approved','suspended') THEN RAISE EXCEPTION 'not_renewable' USING ERRCODE = 'P0001'; END IF;
    IF p_mode = 'from_now' OR u.access_expires_at IS NULL THEN
      v_start := now();
    ELSE
      v_start := u.access_expires_at;
    END IF;
    v_kind := CASE WHEN u.status = 'suspended' THEN 'reactivation' ELSE 'renewal' END;
  ELSE
    RAISE EXCEPTION 'invalid_mode' USING ERRCODE = 'P0001';
  END IF;

  v_end := app.add_calendar_month(v_start, u.timezone);
  IF v_end <= now() THEN
    RAISE EXCEPTION 'period_already_over' USING ERRCODE = 'P0001';
  END IF;

  UPDATE users SET status = 'approved', suspension_reason = NULL, suspended_at = NULL,
         approved_at = CASE WHEN p_mode = 'approve' THEN now() ELSE approved_at END,
         approved_by = p_admin, access_expires_at = v_end,
         expiry_warned_3d_at = NULL, expiry_warned_1d_at = NULL
   WHERE id = p_user;
  INSERT INTO access_periods (user_id, kind, starts_at, ends_at, timezone_used, granted_by, payment_note)
       VALUES (p_user, v_kind, v_start, v_end, u.timezone, p_admin, nullif(p_note, ''));

  starts_at := v_start; ends_at := v_end; timezone_used := u.timezone; previous_status := u.status;
  RETURN NEXT;
END $$;

-- Called every minute by the scheduler. Suspends every account whose access has ended.
CREATE FUNCTION app.expire_due_accounts()
RETURNS TABLE (expired_user_id uuid, expired_email text, expired_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT u.id, u.email_display, u.access_expires_at FROM users u
            WHERE u.status = 'approved' AND u.role = 'user' AND u.access_expires_at <= now()
            ORDER BY u.access_expires_at
            LIMIT 500
            FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM app.apply_suspension(r.id, 'expired');
    INSERT INTO audit_log (actor_type, action, target_type, target_id, target_user_id, details)
         VALUES ('system', 'user.expired', 'user', r.id, r.id,
                 jsonb_build_object('access_expires_at', r.access_expires_at));
    expired_user_id := r.id; expired_email := r.email_display; expired_at := r.access_expires_at;
    RETURN NEXT;
  END LOOP;
END $$;

-- Returns (and marks) users who should get a "your access ends soon" email.
CREATE FUNCTION app.claim_expiry_warnings()
RETURNS TABLE (warn_user_id uuid, warn_email text, warn_expires_at timestamptz, warn_timezone text, warn_level text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT u.id,
           CASE WHEN u.access_expires_at - now() <= interval '1 day' THEN '1d' ELSE '3d' END AS lvl
      FROM users u
     WHERE u.status = 'approved' AND u.role = 'user'
       AND u.access_expires_at > now()
       AND ((u.access_expires_at - now() <= interval '1 day' AND u.expiry_warned_1d_at IS NULL)
         OR (u.access_expires_at - now() <= interval '3 days' AND u.expiry_warned_3d_at IS NULL))
     FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE users u
       SET expiry_warned_3d_at = coalesce(u.expiry_warned_3d_at, now()),
           expiry_warned_1d_at = CASE WHEN due.lvl = '1d' THEN now() ELSE u.expiry_warned_1d_at END
      FROM due WHERE u.id = due.id
    RETURNING u.id, u.email_display, u.access_expires_at, u.timezone, due.lvl
  )
  SELECT * FROM marked;
END $$;

-- Daily housekeeping.
CREATE FUNCTION app.prune_operational_data() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE a int; t int; s int; u int;
BEGIN
  DELETE FROM login_attempts WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days';
  GET DIAGNOSTICS t = ROW_COUNT;
  DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
                          OR expires_at < now() - interval '30 days';
  GET DIAGNOSTICS s = ROW_COUNT;
  -- Unverified registrations expire after 7 days so nobody can squat someone else's Gmail address.
  DELETE FROM users WHERE role = 'user' AND status = 'pending' AND email_verified_at IS NULL
                      AND created_at < now() - interval '7 days';
  GET DIAGNOSTICS u = ROW_COUNT;
  RETURN jsonb_build_object('login_attempts', a, 'auth_tokens', t, 'sessions', s, 'unverified_users', u);
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
--   auth   : pre-authentication flows (register, login, refresh, verify, reset)
--   api    : authenticated user requests; Row-Level Security restricts to own rows
--   admin  : admin dashboard; cannot change roles, cannot delete audit rows
--   worker : scheduler; only via SECURITY DEFINER functions
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO {{role_auth}}, {{role_api}}, {{role_admin}}, {{role_worker}};

REVOKE EXECUTE ON FUNCTION app.apply_suspension(uuid, text), app.grant_access(uuid, uuid, text, text),
  app.expire_due_accounts(), app.claim_expiry_warnings(), app.prune_operational_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_suspension(uuid, text) TO {{role_admin}};
GRANT EXECUTE ON FUNCTION app.grant_access(uuid, uuid, text, text) TO {{role_admin}};
GRANT EXECUTE ON FUNCTION app.expire_due_accounts(), app.claim_expiry_warnings(),
  app.prune_operational_data() TO {{role_worker}};

-- auth
GRANT SELECT ON users TO {{role_auth}};
GRANT INSERT (email_normalized, email_display, password_hash, timezone) ON users TO {{role_auth}};
GRANT UPDATE (password_hash, email_verified_at, password_changed_at, failed_login_count,
              locked_until, last_login_at) ON users TO {{role_auth}};
GRANT SELECT, INSERT, UPDATE ON sessions, devices, auth_tokens TO {{role_auth}};
GRANT SELECT, INSERT ON login_attempts TO {{role_auth}};
GRANT INSERT ON audit_log TO {{role_auth}};
GRANT SELECT ON platform_settings TO {{role_auth}};

-- api
GRANT SELECT ON users TO {{role_api}};
GRANT UPDATE (timezone, password_hash, password_changed_at) ON users TO {{role_api}};
GRANT SELECT, UPDATE ON sessions, devices TO {{role_api}};
GRANT SELECT ON access_periods, platform_settings TO {{role_api}};
GRANT INSERT ON audit_log TO {{role_api}};

-- admin
GRANT SELECT, DELETE ON users TO {{role_admin}};
GRANT UPDATE (status, rejected_at, storage_quota_bytes, password_hash, password_changed_at,
              failed_login_count, locked_until, last_login_at) ON users TO {{role_admin}};
GRANT SELECT ON access_periods, devices, login_attempts TO {{role_admin}};
GRANT INSERT ON login_attempts TO {{role_admin}};
GRANT SELECT, INSERT, UPDATE ON sessions, auth_tokens TO {{role_admin}};
GRANT UPDATE (revoked_at) ON devices TO {{role_admin}};
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_factors TO {{role_admin}};
GRANT SELECT, INSERT ON audit_log TO {{role_admin}};
GRANT SELECT, UPDATE ON platform_settings TO {{role_admin}};
GRANT SELECT, INSERT, UPDATE ON deletion_requests TO {{role_admin}};

-- worker
GRANT SELECT ON platform_settings TO {{role_worker}};
GRANT SELECT (id, email_display, role) ON users TO {{role_worker}};

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_all   ON users TO {{role_auth}}  USING (true) WITH CHECK (role = 'user');
CREATE POLICY self_only  ON users TO {{role_api}}   USING (id = app.current_user_id());
CREATE POLICY admin_all  ON users TO {{role_admin}} USING (true) WITH CHECK (true);
CREATE POLICY worker_read ON users FOR SELECT TO {{role_worker}} USING (role = 'admin');

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_all  ON sessions TO {{role_auth}}  USING (true) WITH CHECK (true);
CREATE POLICY tenant    ON sessions TO {{role_api}}   USING (user_id = app.current_user_id())
                                                     WITH CHECK (user_id = app.current_user_id());
CREATE POLICY admin_all ON sessions TO {{role_admin}} USING (true) WITH CHECK (true);

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_all  ON devices TO {{role_auth}}  USING (true) WITH CHECK (true);
CREATE POLICY tenant    ON devices TO {{role_api}}   USING (user_id = app.current_user_id())
                                                    WITH CHECK (user_id = app.current_user_id());
CREATE POLICY admin_all ON devices TO {{role_admin}} USING (true) WITH CHECK (true);

ALTER TABLE access_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant    ON access_periods FOR SELECT TO {{role_api}} USING (user_id = app.current_user_id());
CREATE POLICY admin_all ON access_periods FOR SELECT TO {{role_admin}} USING (true);
