<?php

// Users, sessions, workspaces, memberships, invitations, tokens,
// platform settings, audit log, rate limits, security events, support grants.

$t = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

return [
    "CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(254) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) NOT NULL DEFAULT '',
        status VARCHAR(16) NOT NULL DEFAULT 'unverified',
        is_platform_admin TINYINT(1) NOT NULL DEFAULT 0,
        email_verified_at DATETIME NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        last_login_at DATETIME NULL,
        UNIQUE KEY uq_users_email (email),
        KEY idx_users_status (status)
    ) $t",

    "CREATE TABLE IF NOT EXISTS user_sessions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL,
        csrf_token CHAR(64) NOT NULL,
        user_agent_summary VARCHAR(100) NOT NULL DEFAULT '',
        ip_masked VARCHAR(64) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL,
        last_seen_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME NULL,
        UNIQUE KEY uq_sessions_token (token_hash),
        KEY idx_sessions_user (user_id, revoked_at),
        KEY idx_sessions_expires (expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) $t",

    "CREATE TABLE IF NOT EXISTS workspaces (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        owner_user_id BIGINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        KEY idx_workspaces_owner (owner_user_id),
        CONSTRAINT fk_workspaces_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT
    ) $t",

    "CREATE TABLE IF NOT EXISTS workspace_members (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        role VARCHAR(20) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uq_member (workspace_id, user_id),
        KEY idx_member_user (user_id, status),
        CONSTRAINT fk_member_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) $t",

    "CREATE TABLE IF NOT EXISTS workspace_invitations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        email VARCHAR(254) NOT NULL,
        role VARCHAR(20) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        invited_by_user_id BIGINT UNSIGNED NULL,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        accepted_at DATETIME NULL,
        revoked_at DATETIME NULL,
        UNIQUE KEY uq_invite_token (token_hash),
        KEY idx_invite_ws (workspace_id),
        CONSTRAINT fk_invite_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_invite_user FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) $t",

    "CREATE TABLE IF NOT EXISTS user_tokens (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        purpose VARCHAR(20) NOT NULL,
        token_hash CHAR(64) NOT NULL,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        UNIQUE KEY uq_user_token (token_hash),
        KEY idx_user_token_user (user_id, purpose),
        CONSTRAINT fk_user_token_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) $t",

    "CREATE TABLE IF NOT EXISTS platform_settings (
        name VARCHAR(64) NOT NULL PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME NOT NULL
    ) $t",

    "CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        scope VARCHAR(16) NOT NULL,
        workspace_id BIGINT UNSIGNED NULL,
        actor_user_id BIGINT UNSIGNED NULL,
        actor_type VARCHAR(16) NOT NULL DEFAULT 'user',
        action VARCHAR(64) NOT NULL,
        resource_type VARCHAR(32) NOT NULL DEFAULT '',
        resource_id VARCHAR(64) NOT NULL DEFAULT '',
        metadata TEXT NULL,
        created_at DATETIME NOT NULL,
        KEY idx_audit_ws (workspace_id, id),
        KEY idx_audit_scope (scope, id),
        KEY idx_audit_created (created_at),
        CONSTRAINT fk_audit_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) $t",

    "CREATE TABLE IF NOT EXISTS rate_limits (
        bucket CHAR(64) NOT NULL PRIMARY KEY,
        window_start INT UNSIGNED NOT NULL,
        hits INT UNSIGNED NOT NULL,
        expires_at INT UNSIGNED NOT NULL,
        KEY idx_rl_expires (expires_at)
    ) $t",

    // Restricted security record. IPs are stored masked plus a keyed hash
    // (for correlating repeated abuse), never raw. Short retention.
    "CREATE TABLE IF NOT EXISTS security_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(40) NOT NULL,
        user_id BIGINT UNSIGNED NULL,
        workspace_id BIGINT UNSIGNED NULL,
        website_id BIGINT UNSIGNED NULL,
        ip_masked VARCHAR(64) NOT NULL DEFAULT '',
        ip_hash CHAR(64) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL,
        KEY idx_sec_created (created_at),
        KEY idx_sec_type (event_type, created_at),
        CONSTRAINT fk_sec_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_sec_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) $t",

    // Workspace owners explicitly authorise time-limited, read-only support access.
    "CREATE TABLE IF NOT EXISTS support_grants (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        granted_by_user_id BIGINT UNSIGNED NULL,
        reason VARCHAR(255) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME NULL,
        KEY idx_grant_ws (workspace_id, expires_at),
        CONSTRAINT fk_grant_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_grant_user FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) $t",
];
