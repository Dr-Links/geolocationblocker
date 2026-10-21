<?php

// Lets the dashboard request credential rotation; the plugin performs it
// server-to-server on its next contact, so no human ever sees the new secret.

return [
    'ALTER TABLE websites ADD COLUMN rotation_requested_at DATETIME NULL AFTER last_connected_at',
];
