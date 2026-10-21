<?php

declare(strict_types=1);

// Front controller. The web server's document root must point at this
// directory; everything else (config, storage, src) stays outside it.

$factory = require dirname(__DIR__) . '/bootstrap.php';
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
