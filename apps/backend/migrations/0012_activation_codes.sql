-- Activation codes: the administrator creates a code, the customer enters it in the app, and their account
-- is activated (or renewed) for the code's access period. One code activates exactly one account, once.
SET LOCAL search_path = app, pg_catalog;

CREATE TABLE activation_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash     bytea NOT NULL UNIQUE,                 -- sha256 of the normalised code; the code itself is never stored
  hint          text  NOT NULL CHECK (length(hint) <= 12),   -- last characters, to recognise a code in the list
  months        int   NOT NULL DEFAULT 1 CHECK (months BETWEEN 1 AND 24),
  note          text  CHECK (length(note) <= 300),     -- e.g. payment reference
  for_email     text  CHECK (for_email IS NULL OR for_email = lower(for_email)),
  expires_at    timestamptz,                           -- the code must be used before this
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  used_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  used_by_email text,                                  -- kept for the record if that account is later deleted
  used_at       timestamptz,
  revoked_at    timestamptz,
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX activation_codes_created_idx ON activation_codes (created_at DESC);

CREATE TABLE activation_code_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  success     boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activation_code_attempts_user_idx ON activation_code_attempts (user_id, created_at DESC);

ALTER TABLE access_periods ADD COLUMN activation_code_id uuid REFERENCES activation_codes(id) ON DELETE SET NULL;

/*
 * Redeems a code for the signed-in user (app.current_user_id()). Never raises for a bad code: it returns a result
 * so that the failed attempt is recorded and counted (10 failed attempts per 15 minutes per account).
 * result: ok | invalid | used | revoked | expired | wrong_account | not_eligible | email_not_verified | too_many_attempts
 */
CREATE FUNCTION app.redeem_activation_code(p_code_hash bytea)
RETURNS TABLE (result text, ends_at timestamptz, previous_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE
  v_user uuid := app.current_user_id();
  u record; c record; v_start timestamptz; v_end timestamptz; v_kind text; i int;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'no user' USING ERRCODE = '28000'; END IF;
  IF (SELECT count(*) FROM activation_code_attempts WHERE user_id = v_user AND NOT success AND created_at > now() - interval '15 minutes') >= 10 THEN
    result := 'too_many_attempts'; RETURN NEXT; RETURN;
  END IF;
  SELECT id, status, suspension_reason, access_expires_at, timezone, email_verified_at, email_normalized, email_display
    INTO u FROM users WHERE id = v_user AND role = 'user' FOR UPDATE;
  SELECT * INTO c FROM activation_codes WHERE code_hash = p_code_hash FOR UPDATE;

  result := CASE
    WHEN c.id IS NULL THEN 'invalid'
    WHEN c.revoked_at IS NOT NULL THEN 'revoked'
    WHEN c.used_at IS NOT NULL THEN 'used'
    WHEN c.expires_at IS NOT NULL AND c.expires_at <= now() THEN 'expired'
    WHEN c.for_email IS NOT NULL AND c.for_email <> u.email_normalized THEN 'wrong_account'
    WHEN u.email_verified_at IS NULL THEN 'email_not_verified'
    WHEN u.status = 'pending' THEN 'ok'
    WHEN u.status = 'approved' THEN 'ok'
    WHEN u.status = 'suspended' AND u.suspension_reason = 'expired' THEN 'ok'
    ELSE 'not_eligible' END;   -- rejected, deleting, or suspended by the administrator
  INSERT INTO activation_code_attempts (user_id, success) VALUES (v_user, result = 'ok');
  previous_status := u.status;
  IF result <> 'ok' THEN RETURN NEXT; RETURN; END IF;

  IF u.status = 'pending' THEN v_start := now(); v_kind := 'approval';
  ELSIF u.status = 'approved' AND u.access_expires_at > now() THEN v_start := u.access_expires_at; v_kind := 'renewal';
  ELSE v_start := now(); v_kind := CASE WHEN u.status = 'suspended' THEN 'reactivation' ELSE 'renewal' END;
  END IF;
  v_end := v_start;
  FOR i IN 1..c.months LOOP v_end := app.add_calendar_month(v_end, u.timezone); END LOOP;

  UPDATE users SET status = 'approved', suspension_reason = NULL, suspended_at = NULL,
         approved_at = CASE WHEN u.status = 'pending' THEN now() ELSE approved_at END,
         approved_by = coalesce(c.created_by, approved_by), access_expires_at = v_end,
         expiry_warned_3d_at = NULL, expiry_warned_1d_at = NULL
   WHERE id = v_user;
  INSERT INTO access_periods (user_id, kind, starts_at, ends_at, timezone_used, granted_by, payment_note, activation_code_id)
       VALUES (v_user, v_kind, v_start, v_end, u.timezone, c.created_by,
               left('Activation code …' || c.hint || coalesce(' — ' || c.note, ''), 300), c.id);
  UPDATE activation_codes SET used_by = v_user, used_by_email = u.email_display, used_at = now() WHERE id = c.id;
  IF u.status = 'suspended' THEN PERFORM app.resume_mailboxes(v_user); END IF;
  ends_at := v_end;
  RETURN NEXT;
END $$;

REVOKE EXECUTE ON FUNCTION app.redeem_activation_code(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redeem_activation_code(bytea) TO {{role_api}};
GRANT SELECT, INSERT, UPDATE ON activation_codes TO {{role_admin}};
GRANT SELECT ON activation_code_attempts TO {{role_admin}};
