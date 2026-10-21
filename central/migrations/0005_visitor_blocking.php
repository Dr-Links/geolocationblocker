<?php

// Visitor-ID-only blocks, scoped to one website within one workspace. No IP blocking exists.

$t = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

return [
    "CREATE TABLE IF NOT EXISTS visitor_blocks (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        workspace_id BIGINT UNSIGNED NOT NULL,
        website_id BIGINT UNSIGNED NOT NULL,
        visitor_id BIGINT UNSIGNED NOT NULL,
        blocked_by_user_id BIGINT UNSIGNED NULL,
        reason VARCHAR(500) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at DATETIME NOT NULL,
        revoked_at DATETIME NULL,
        revoked_by_user_id BIGINT UNSIGNED NULL,
        KEY idx_block_visitor (visitor_id, status),
        KEY idx_block_ws (workspace_id, status),
        CONSTRAINT fk_block_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_block_site FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
        CONSTRAINT fk_block_visitor FOREIGN KEY (visitor_id) REFERENCES visitors(id) ON DELETE CASCADE,
        CONSTRAINT fk_block_by FOREIGN KEY (blocked_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_block_revoked_by FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) $t",
];
