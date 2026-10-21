<?php

// Connected websites, their validated settings, integration credentials and pairing codes.

$t = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

return [
    "CREATE TABLE IF NOT EXISTS websites (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        public_key CHAR(32) NOT NULL,
        name VARCHAR(100) NOT NULL,
        canonical_origin VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        tracking_policy VARCHAR(16) NOT NULL DEFAULT 'essential',
        plugin_version VARCHAR(20) NULL,
        platform_version VARCHAR(20) NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        last_activity_at DATETIME NULL,
        last_connected_at DATETIME NULL,
        UNIQUE KEY uq_websites_public_key (public_key),
        KEY idx_websites_ws (workspace_id),
        CONSTRAINT fk_websites_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) $t",

    "CREATE TABLE IF NOT EXISTS website_settings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        website_id BIGINT UNSIGNED NOT NULL,
        widget_config TEXT NOT NULL,
        tracking_config TEXT NOT NULL,
        retention_config TEXT NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uq_settings_website (website_id),
        KEY idx_settings_ws (workspace_id),
        CONSTRAINT fk_settings_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_settings_site FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
    ) $t",

    // secret_hash = SHA-256 of a 256-bit random secret. Plaintext is shown once (to the plugin) and never stored.
    "CREATE TABLE IF NOT EXISTS site_credentials (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        website_id BIGINT UNSIGNED NOT NULL,
        key_prefix CHAR(12) NOT NULL,
        secret_hash CHAR(64) NOT NULL,
        created_at DATETIME NOT NULL,
        last_used_at DATETIME NULL,
        revoked_at DATETIME NULL,
        UNIQUE KEY uq_cred_prefix (key_prefix),
        KEY idx_cred_site (website_id, revoked_at),
        CONSTRAINT fk_cred_site FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
    ) $t",

    "CREATE TABLE IF NOT EXISTS pairing_codes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        website_id BIGINT UNSIGNED NOT NULL,
        code_hash CHAR(64) NOT NULL,
        created_by_user_id BIGINT UNSIGNED NULL,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        UNIQUE KEY uq_pairing_code (code_hash),
        KEY idx_pairing_site (website_id),
        CONSTRAINT fk_pairing_site FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
        CONSTRAINT fk_pairing_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) $t",
];
