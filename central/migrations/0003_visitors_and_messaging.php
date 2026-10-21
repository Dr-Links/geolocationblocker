<?php

// Visitors (opaque, per-website), contact submissions, conversations, messages, read markers.

$t = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

return [
    // token_hash = HMAC-SHA256(app key, visitor token): lookup without a recoverable copy.
    // previous_token_hash allows a grace period after token rotation.
    "CREATE TABLE IF NOT EXISTS visitors (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        public_id CHAR(20) NOT NULL,
        workspace_id BIGINT UNSIGNED NOT NULL,
        website_id BIGINT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL,
        previous_token_hash CHAR(64) NULL,
        token_issued_at DATETIME NOT NULL,
        first_seen_at DATETIME NOT NULL,
        last_seen_at DATETIME NOT NULL,
        visit_count INT UNSIGNED NOT NULL DEFAULT 0,
        name VARCHAR(100) NULL,
        email VARCHAR(254) NULL,
        phone VARCHAR(32) NULL,
        consent_state VARCHAR(16) NOT NULL DEFAULT 'unknown',
        consent_policy_version VARCHAR(32) NULL,
        consent_updated_at DATETIME NULL,
        country_code CHAR(2) NULL,
        country_source VARCHAR(16) NULL,
        browser VARCHAR(32) NULL,
        os VARCHAR(32) NULL,
        last_page_path VARCHAR(512) NULL,
        last_page_at DATETIME NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uq_visitor_public (public_id),
        UNIQUE KEY uq_visitor_token (token_hash),
        KEY idx_visitor_prev_token (previous_token_hash),
        KEY idx_visitor_site_seen (website_id, last_seen_at),
        KEY idx_visitor_ws_seen (workspace_id, last_seen_at),
        CONSTRAINT fk_visitor_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_visitor_site FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
    ) $t",

    "CREATE TABLE IF NOT EXISTS visitor_contact_submissions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        website_id BIGINT UNSIGNED NOT NULL,
        visitor_id BIGINT UNSIGNED NOT NULL,
        name VARCHAR(100) NULL,
        email VARCHAR(254) NULL,
        phone VARCHAR(32) NULL,
        submitted_at DATETIME NOT NULL,
        KEY idx_contact_visitor (visitor_id),
        KEY idx_contact_ws_time (workspace_id, submitted_at),
        CONSTRAINT fk_contact_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_contact_site FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
        CONSTRAINT fk_contact_visitor FOREIGN KEY (visitor_id) REFERENCES visitors(id) ON DELETE CASCADE
    ) $t",

    "CREATE TABLE IF NOT EXISTS conversations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        website_id BIGINT UNSIGNED NOT NULL,
        visitor_id BIGINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'open',
        read_only TINYINT(1) NOT NULL DEFAULT 0,
        assigned_user_id BIGINT UNSIGNED NULL,
        last_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        last_message_at DATETIME NULL,
        last_visitor_message_at DATETIME NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        closed_at DATETIME NULL,
        KEY idx_conv_ws_last (workspace_id, last_message_id),
        KEY idx_conv_ws_status (workspace_id, status, last_message_id),
        KEY idx_conv_visitor (visitor_id, status),
        KEY idx_conv_site (website_id),
        CONSTRAINT fk_conv_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_conv_site FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
        CONSTRAINT fk_conv_visitor FOREIGN KEY (visitor_id) REFERENCES visitors(id) ON DELETE CASCADE,
        CONSTRAINT fk_conv_assignee FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) $t",

    "CREATE TABLE IF NOT EXISTS messages (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        conversation_id BIGINT UNSIGNED NOT NULL,
        sender_type VARCHAR(16) NOT NULL,
        sender_user_id BIGINT UNSIGNED NULL,
        client_message_id VARCHAR(64) NOT NULL,
        body TEXT NOT NULL,
        created_at DATETIME NOT NULL,
        delivered_at DATETIME NULL,
        UNIQUE KEY uq_message_idempotency (conversation_id, sender_type, client_message_id),
        KEY idx_message_conv (conversation_id, id),
        KEY idx_message_ws (workspace_id, id),
        CONSTRAINT fk_msg_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_msg_conv FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        CONSTRAINT fk_msg_sender FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) $t",

    "CREATE TABLE IF NOT EXISTS conversation_reads (
        conversation_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        last_read_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation_id, user_id),
        CONSTRAINT fk_read_conv FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        CONSTRAINT fk_read_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) $t",
];
