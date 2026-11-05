<?php

/*
 * Configuration template for https://alllivechats.com on Hostinger (hPanel).
 *
 * Copy this file to config/config.php in the same folder and replace every
 * value marked CHANGE. Never commit or share config.php. Permissions: 600.
 */

return [
    'app' => [
        'name' => 'All Live Chats',
        'url' => 'https://alllivechats.com',
        'env' => 'production',
        'debug' => false,
        // CHANGE: 64 hex characters. Open https://alllivechats.com before creating
        // config.php and the page prints a freshly generated key you can paste here.
        'key' => '',
    ],
    'db' => [
        'host' => 'localhost',
        'port' => 3306,
        'socket' => '',
        'name' => 'u000000000_alllivechats',   // CHANGE: hPanel → Databases → MySQL Databases
        'user' => 'u000000000_alcadmin',       // CHANGE
        'password' => '',                      // CHANGE
        'charset' => 'utf8mb4',
    ],
    'security' => [
        // Leave empty unless you put Cloudflare or another proxy in front of the site.
        'trusted_proxies' => [],
        'force_https' => true,
        'session_idle_minutes' => 120,
        'session_absolute_hours' => 168,
        'login_max_attempts' => 5,
        'login_window_minutes' => 15,
        'password_min_length' => 10,
    ],
    'mail' => [
        // Hostinger mailbox (hPanel → Emails). SMTP gives far better delivery than mail().
        'transport' => 'smtp',
        'from' => 'no-reply@alllivechats.com',
        'from_name' => 'All Live Chats',
        'smtp' => [
            'host' => 'smtp.hostinger.com',
            'port' => 465,
            'encryption' => 'ssl',
            'username' => 'no-reply@alllivechats.com',
            'password' => '',                  // CHANGE: the mailbox password
        ],
    ],
    'push' => [
        'enabled' => true,
        'subject' => 'mailto:no-reply@alllivechats.com',
    ],
    'geo' => [
        'provider' => 'none',
        'trusted_header' => 'CF-IPCountry',
    ],
];
