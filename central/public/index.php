<?php

declare(strict_types=1);

// Front controller. The web server's document root must point at this
// directory; everything else (config, storage, src) stays outside it.

$factory = require dirname(__DIR__) . '/bootstrap.php';
$app = $factory();

if (!$app->config->isConfigured()) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Signalpost is not configured yet. Copy config/config.example.php to config/config.php and follow docs/INSTALL.md.\n";
    exit;
}

$app->handle(\Signalpost\Http\Request::fromGlobals())->send();
