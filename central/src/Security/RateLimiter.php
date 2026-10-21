<?php

declare(strict_types=1);

namespace Signalpost\Security;

use Signalpost\Core\App;
use Signalpost\Core\HttpException;

/**
 * Fixed-window rate limiter stored in MySQL (no Redis needed on shared hosting).
 * Bucket keys are hashed with the app key, so raw IPs and emails are never stored.
 */
final class RateLimiter
{
    public function __construct(private readonly App $app)
    {
    }

    /** Records a hit and returns true if still within the limit. */
    public function hit(string $bucket, int $max, int $windowSeconds): bool
    {
        $key = Tokens::keyedHash($this->app->config->appKey(), 'ratelimit', $bucket);
        $now = $this->app->clock->timestamp();
        $window = $now - ($now % $windowSeconds);
        $db = $this->app->db();
        $db->exec(
            'INSERT INTO rate_limits (bucket, window_start, hits, expires_at) VALUES (:b, :w, 1, :e)
             ON DUPLICATE KEY UPDATE hits = IF(window_start = VALUES(window_start), hits + 1, 1),
                                     window_start = VALUES(window_start), expires_at = VALUES(expires_at)',
            ['b' => $key, 'w' => $window, 'e' => $window + $windowSeconds]
        );
        $hits = (int) $db->value('SELECT hits FROM rate_limits WHERE bucket = ?', [$key]);
        return $hits <= $max;
    }

    public function enforce(string $bucket, int $max, int $windowSeconds): void
    {
        if (!$this->hit($bucket, $max, $windowSeconds)) {
            throw HttpException::tooMany();
        }
    }

    /** Count without incrementing. */
    public function count(string $bucket, int $windowSeconds): int
    {
        $key = Tokens::keyedHash($this->app->config->appKey(), 'ratelimit', $bucket);
        $now = $this->app->clock->timestamp();
        $window = $now - ($now % $windowSeconds);
        return (int) ($this->app->db()->value(
            'SELECT hits FROM rate_limits WHERE bucket = ? AND window_start = ?',
            [$key, $window]
        ) ?? 0);
    }

    public function clear(string $bucket): void
    {
        $key = Tokens::keyedHash($this->app->config->appKey(), 'ratelimit', $bucket);
        $this->app->db()->exec('DELETE FROM rate_limits WHERE bucket = ?', [$key]);
    }

    public function purgeExpired(): int
    {
        return $this->app->db()->exec('DELETE FROM rate_limits WHERE expires_at < ? LIMIT 5000', [$this->app->clock->timestamp()]);
    }
}
