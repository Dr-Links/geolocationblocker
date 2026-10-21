<?php

// Emails are stored lowercased; compare them exactly (no accent/case folding)
// so that visually similar spellings cannot address the same account or
// escape per-account login throttling.

return [
    'ALTER TABLE users MODIFY email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',
    'ALTER TABLE workspace_invitations MODIFY email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',
];
