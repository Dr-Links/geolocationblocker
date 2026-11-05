<?php

// Activation codes issued by the platform owner. One code = one account period
// (sign-up or renewal). Only a hash of each code is stored.

$t = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

return [
    "CREATE TABLE IF NOT EXISTS activation_codes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        code_hash CHAR(64) NOT NULL,
        code_hint CHAR(4) NOT NULL,
        duration_months TINYINT UNSIGNED NOT NULL,
        note VARCHAR(255) NOT NULL DEFAULT '',
        created_by_user_id BIGINT UNSIGNED NULL,
        created_at DATETIME NOT NULL,
        revoked_at DATETIME NULL,
        revoked_by_user_id BIGINT UNSIGNED NULL,
        used_at DATETIME NULL,
        used_by_user_id BIGINT UNSIGNED NULL,
        used_for VARCHAR(16) NULL,
        period_starts_at DATETIME NULL,
        period_ends_at DATETIME NULL,
        UNIQUE KEY uq_activation_code (code_hash),
        KEY idx_activation_used_by (used_by_user_id),
        KEY idx_activation_created (created_at),
        CONSTRAINT fk_activation_creator FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_activation_revoker FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_activation_user FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) $t",

    // NULL = no time limit (platform owner, accounts created before activation codes, invited members who inherit).
    'ALTER TABLE users
        ADD COLUMN access_expires_at DATETIME NULL AFTER last_login_at,
        ADD COLUMN access_reminder_sent_at DATETIME NULL AFTER access_expires_at,
        ADD COLUMN access_expiry_processed_at DATETIME NULL AFTER access_reminder_sent_at,
        ADD KEY idx_users_access_expires (access_expires_at)',
];
