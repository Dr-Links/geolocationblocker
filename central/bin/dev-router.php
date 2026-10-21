<?php

// Router for PHP's built-in web server (local development and tests only):
//   php -S 127.0.0.1:8080 -t public bin/dev-router.php
// Serves existing files from public/ directly and sends everything else to index.php.

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$file = realpath(__DIR__ . '/../public' . $path);
if ($file !== false && is_file($file) && str_starts_with($file, realpath(__DIR__ . '/../public')) && !str_ends_with($file, '.php')) {
    return false;
}
$_SERVER['SCRIPT_NAME'] = '/index.php';
require __DIR__ . '/../public/index.php';
