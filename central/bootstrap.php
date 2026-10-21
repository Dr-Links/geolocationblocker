<?php

declare(strict_types=1);

/*
 * Signalpost central application bootstrap.
 *
 * Registers a dependency-free PSR-4 autoloader so the application runs on
 * shared hosting without Composer. Returns a factory that builds the App.
 */

if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    exit('Signalpost requires PHP 8.1 or newer.');
}

define('SIGNALPOST_ROOT', __DIR__);
define('SIGNALPOST_VERSION', '1.0.0');

spl_autoload_register(static function (string $class): void {
    $prefix = 'Signalpost\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $file = __DIR__ . '/src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($file)) {
        require $file;
    }
});

return static function (?array $configOverride = null): \Signalpost\Core\App {
    $config = $configOverride !== null
        ? \Signalpost\Core\Config::fromArray($configOverride)
        : \Signalpost\Core\Config::load(SIGNALPOST_ROOT);
    return new \Signalpost\Core\App($config);
};
