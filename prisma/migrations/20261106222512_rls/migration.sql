-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant isolation via Postgres Row-Level Security.
--
-- Every tenant-owned table only exposes rows whose workspace matches the
-- transaction-local setting `app.workspace_id`. With no setting, tenant tables
-- look EMPTY and writes FAIL (fail closed).
--
-- Trusted system code (auth, admin console, worker, seed) sets
-- `app.bypass_rls = 'on'` via `systemDb` / `withSystemTx` (src/lib/db.ts).
--
-- RLS does not apply to superusers or BYPASSRLS roles, so the runtime
-- DATABASE_URL must use a plain role that is a member of `app_user`. The app
-- checks this at boot (src/lib/db-guard.ts).
-- ─────────────────────────────────────────────────────────────────────────────

-- Runtime role (NOLOGIN group). Login roles are created by ops and granted into it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
DO $$
BEGIN
  -- Absent in Prisma's shadow database.
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE "_prisma_migrations" FROM app_user;
  END IF;
END
$$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Helpers. `current_setting(..., true)` returns NULL/'' when unset instead of erroring.
CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION app_current_workspace() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.workspace_id', true), '') $$;

GRANT EXECUTE ON FUNCTION app_rls_bypass() TO app_user;
GRANT EXECUTE ON FUNCTION app_current_workspace() TO app_user;

-- ── Workspace (keyed by its own id) ─────────────────────────────────────────
ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Workspace"
  USING (app_rls_bypass() OR "id" = app_current_workspace())
  WITH CHECK (app_rls_bypass() OR "id" = app_current_workspace());

-- ── Tables with a direct workspaceId column ─────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Membership', 'Invitation', 'Subscription', 'SocialAccount', 'Post',
    'GenerationRequest', 'ProviderCredential', 'AuditLog'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (app_rls_bypass() OR "workspaceId" = app_current_workspace())
         WITH CHECK (app_rls_bypass() OR "workspaceId" = app_current_workspace())', t);
  END LOOP;
END
$$;

-- ── workspaceId + an optional reference to a GenerationRequest ──────────────
-- WITH CHECK also blocks pointing at another tenant's generation.
ALTER TABLE "MediaAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MediaAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MediaAsset"
  USING (app_rls_bypass() OR "workspaceId" = app_current_workspace())
  WITH CHECK (app_rls_bypass() OR (
    "workspaceId" = app_current_workspace()
    AND ("generationRequestId" IS NULL OR EXISTS (
      SELECT 1 FROM "GenerationRequest" g
      WHERE g."id" = "generationRequestId" AND g."workspaceId" = app_current_workspace()))
  ));

ALTER TABLE "CreditLedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditLedgerEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CreditLedgerEntry"
  USING (app_rls_bypass() OR "workspaceId" = app_current_workspace())
  WITH CHECK (app_rls_bypass() OR (
    "workspaceId" = app_current_workspace()
    AND ("generationRequestId" IS NULL OR EXISTS (
      SELECT 1 FROM "GenerationRequest" g
      WHERE g."id" = "generationRequestId" AND g."workspaceId" = app_current_workspace()))
  ));

-- ── Child tables scoped through their parent(s) ─────────────────────────────
-- WITH CHECK verifies EVERY referenced row is in the current workspace, so a
-- post can't be linked to another tenant's social account or media.
ALTER TABLE "PostTarget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PostTarget" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PostTarget"
  USING (app_rls_bypass() OR EXISTS (
    SELECT 1 FROM "Post" p WHERE p."id" = "postId" AND p."workspaceId" = app_current_workspace()))
  WITH CHECK (app_rls_bypass() OR (
    EXISTS (SELECT 1 FROM "Post" p WHERE p."id" = "postId" AND p."workspaceId" = app_current_workspace())
    AND EXISTS (SELECT 1 FROM "SocialAccount" s WHERE s."id" = "socialAccountId" AND s."workspaceId" = app_current_workspace())
  ));

ALTER TABLE "PostMedia" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PostMedia" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PostMedia"
  USING (app_rls_bypass() OR EXISTS (
    SELECT 1 FROM "Post" p WHERE p."id" = "postId" AND p."workspaceId" = app_current_workspace()))
  WITH CHECK (app_rls_bypass() OR (
    EXISTS (SELECT 1 FROM "Post" p WHERE p."id" = "postId" AND p."workspaceId" = app_current_workspace())
    AND EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m."id" = "mediaAssetId" AND m."workspaceId" = app_current_workspace())
  ));

ALTER TABLE "PostSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PostSchedule" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PostSchedule"
  USING (app_rls_bypass() OR EXISTS (
    SELECT 1 FROM "Post" p WHERE p."id" = "postId" AND p."workspaceId" = app_current_workspace()))
  WITH CHECK (app_rls_bypass() OR EXISTS (
    SELECT 1 FROM "Post" p WHERE p."id" = "postId" AND p."workspaceId" = app_current_workspace()));

-- Global tables (no RLS): User, Account, Session, VerificationToken, Plan, StripeEvent.
