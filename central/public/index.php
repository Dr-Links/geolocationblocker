<?php

declare(strict_types=1);

// Front controller. The web server's document root must point at this
// directory; everything else (config, storage, src) stays outside it.

// Layout A (cPanel subdomain): document root = signalpost/public, app one level up.
// Layout B (Hostinger hPanel and similar): document root = public_html, app in a
// sibling folder named "signalpost" that is not web-accessible.
$bootstrap = null;
foreach ([dirname(__DIR__) . '/bootstrap.php', dirname(__DIR__) . '/signalpost/bootstrap.php'] as $candidate) {
    if (is_file($candidate)) {
        $bootstrap = $candidate;
        break;
    }
}
if ($bootstrap === null) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    exit("Signalpost application files not found. See docs/INSTALL.md.\n");
}
$factory = require $bootstrap;
$app = $factory();

if (!$app->config->isConfigured()) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Signalpost is not configured yet.\n\n";
    echo "1. Copy config/config.example.php to config/config.php (outside the web root).\n";
    echo "2. Fill in the database settings and app.url.\n";
    echo "3. Set app.key to a random 64-character hex value. A fresh one, generated just now and not stored anywhere:\n\n   ";
    echo bin2hex(random_bytes(32)), "\n\n";
    echo "4. Reload this page, then open /install to create the platform owner.\n";
    echo "See docs/INSTALL.md for details.\n";
    exit;
}

$app->handle(\Signalpost\Http\Request::fromGlobals())->send();

// Finish the response first (PHP-FPM / LiteSpeed), then run deferred work such as push notifications.
if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
} elseif (function_exists('litespeed_finish_request')) {
    litespeed_finish_request();
}
$app->runDeferred();
