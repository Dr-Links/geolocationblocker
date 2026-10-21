<?php

declare(strict_types=1);

namespace Signalpost\Sites;

/** Canonical origin handling (scheme://host[:port]). */
final class Origin
{
    /** Returns the canonical origin or null if invalid. */
    public static function normalize(string $input, bool $allowInsecure = false): ?string
    {
        $input = trim($input);
        if ($input === '' || strlen($input) > 255 || preg_match('/[\s<>"\'\\\\]/', $input) === 1) {
            return null;
        }
        $parts = parse_url($input);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
            return null;
        }
        if (isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) {
            return null;
        }
        if (isset($parts['path']) && $parts['path'] !== '' && $parts['path'] !== '/') {
            return null; // Only origins are accepted; WordPress in a sub-directory still shares the origin.
        }
        $scheme = strtolower($parts['scheme']);
        $host = strtolower($parts['host']);
        if (!in_array($scheme, ['http', 'https'], true)) {
            return null;
        }
        if (preg_match('/^(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?)*)$/', $host) !== 1) {
            return null;
        }
        if ($scheme === 'http' && !$allowInsecure && !self::isLocal($host)) {
            return null;
        }
        $port = $parts['port'] ?? null;
        if ($port !== null && (($scheme === 'https' && $port === 443) || ($scheme === 'http' && $port === 80))) {
            $port = null;
        }
        return $scheme . '://' . $host . ($port !== null ? ':' . $port : '');
    }

    /** Origin of an arbitrary URL (used for site_url sent by the plugin). */
    public static function ofUrl(string $url, bool $allowInsecure = false): ?string
    {
        $parts = parse_url(trim($url));
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
            return null;
        }
        $origin = $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
        return self::normalize($origin, $allowInsecure);
    }

    public static function isLocal(string $host): bool
    {
        return in_array($host, ['localhost', '127.0.0.1', '[::1]'], true)
            || str_ends_with($host, '.localhost') || str_ends_with($host, '.test');
    }
}
