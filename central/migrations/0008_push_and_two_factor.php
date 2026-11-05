<?php

// Web Push subscriptions for the installable operator app, per-user
// notification preferences, and optional TOTP two-factor authentication.

$t = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

return [
    "CREATE TABLE IF NOT EXISTS push_subscriptions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        endpoint VARCHAR(1024) NOT NULL,
        endpoint_hash CHAR(64) NOT NULL,
        p256dh VARCHAR(128) NOT NULL,
        auth VARCHAR(64) NOT NULL,
        device_summary VARCHAR(100) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL,
        last_success_at DATETIME NULL,
        failure_count INT UNSIGNED NOT NULL DEFAULT 0,
        UNIQUE KEY uq_push_endpoint (endpoint_hash),
        KEY idx_push_user (user_id),
        CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) $t",

    'ALTER TABLE users
        ADD COLUMN push_show_preview TINYINT(1) NOT NULL DEFAULT 0 AFTER is_platform_admin,
        ADD COLUMN totp_secret VARCHAR(255) NULL AFTER push_show_preview,
        ADD COLUMN totp_enabled_at DATETIME NULL AFTER totp_secret,
        ADD COLUMN totp_last_step BIGINT NULL AFTER totp_enabled_at',

    "CREATE TABLE IF NOT EXISTS user_recovery_codes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        code_hash CHAR(64) NOT NULL,
        used_at DATETIME NULL,
        KEY idx_recovery_user (user_id),
        CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) $t",
];
