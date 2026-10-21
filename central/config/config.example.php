<?php

/*
 * Signalpost configuration example.
 *
 * Copy to config/config.php (which is git-ignored) and fill in values.
 * Never commit config.php. Set its permissions to 0600 or 0640.
 * The web installer can create config.php for you (see docs/INSTALL.md).
 */

return [
    'app' => [
        'name' => 'Signalpost',
        // Public base URL of the central application, without trailing slash.
        'url' => 'https://chat.example.com',
        'env' => 'production',
        'debug' => false,
        // 64 hexadecimal characters. Generate with: php bin/console key:generate
        // Changing it invalidates visitor tokens and rate-limit buckets.
        'key' => '',
    ],
    'db' => [
        'host' => 'localhost',
        'port' => 3306,
        'socket' => '',
        'name' => 'cpaneluser_signalpost',
        'user' => 'cpaneluser_spapp',
        'password' => '',
        'charset' => 'utf8mb4',
    ],
    'security' => [
        // Only list proxies you control (e.g. Cloudflare ranges if proxied).
        'trusted_proxies' => [],
        'force_https' => true,
        'session_idle_minutes' => 120,
        'session_absolute_hours' => 168,
        'login_max_attempts' => 5,
        'login_window_minutes' => 15,
        'password_min_length' => 10,
    ],
    'mail' => [
        'transport' => 'mail',
        'from' => 'no-reply@example.com',
        'from_name' => 'Signalpost',
    ],
    'polling' => [
        'widget_active_ms' => 4000,
        'widget_idle_ms' => 15000,
        'widget_hidden_ms' => 30000,
        'dashboard_ms' => 5000,
        'max_backoff_ms' => 60000,
    ],
    'limits' => [
        'max_request_bytes' => 65536,
        'message_max_chars' => 4000,
        'events_per_batch' => 20,
        'cleanup_batch_size' => 500,
        'active_visitor_seconds' => 120,
        'recent_visitor_minutes' => 30,
        'visitor_token_rotate_days' => 30,
    ],
    'geo' => [
        // none | table (imported CSV) | trusted_header (e.g. Cloudflare CF-IPCountry; requires trusted_proxies)
        'provider' => 'none',
        'trusted_header' => 'CF-IPCountry',
    ],
];
