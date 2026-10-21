<?php

declare(strict_types=1);

namespace Signalpost\Auth;

use Signalpost\Core\App;
use Signalpost\Http\ClientIp;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Security\Tokens;
use Signalpost\Security\UserAgent;

/**
 * Database-backed dashboard sessions.
 *
 * The cookie holds a random 256-bit token; only its SHA-256 hash is stored.
 * A fresh token is issued at every login (session ID regeneration). Sessions
 * expire after an idle period and an absolute lifetime and can be revoked
 * individually or all at once (logout everywhere, password reset, suspension).
 */
final class SessionManager
{
    public function __construct(private readonly App $app)
    {
    }

    public function cookieName(Request $request): string
    {
        $base = (string) $this->app->config->get('security.session_cookie');
        // __Host- prefix forces Secure, Path=/ and no Domain when served over HTTPS.
        return $this->app->isSecure($request) ? '__Host-' . $base : $base;
    }

    /** @return array{token:string,session:array} */
    public function create(int $userId, Request $request): array
    {
        $token = Tokens::random(32);
        $now = $this->app->clock;
        $row = [
            'user_id' => $userId,
            'token_hash' => Tokens::hash($token),
            'csrf_token' => Tokens::hex(32),
            'user_agent_summary' => UserAgent::summary($request->header('user-agent')),
            'ip_masked' => ClientIp::mask($this->app->clientIp($request)),
            'created_at' => $now->sql(),
            'last_seen_at' => $now->sql(),
            'expires_at' => $now->sql($this->app->config->int('security.session_absolute_hours') * 3600),
        ];
        $row['id'] = $this->app->db()->insert('user_sessions', $row);
        return ['token' => $token, 'session' => $row];
    }

    public function attachCookie(Response $response, Request $request, string $token): void
    {
        $response->cookie($this->cookieName($request), $token, [
            'expires' => $this->app->clock->timestamp() + $this->app->config->int('security.session_absolute_hours') * 3600,
            'path' => '/',
            'secure' => $this->app->isSecure($request),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }

    public function clearCookie(Response $response, Request $request): void
    {
        $response->cookie($this->cookieName($request), '', [
            'expires' => 1, 'path' => '/', 'secure' => $this->app->isSecure($request), 'httponly' => true, 'samesite' => 'Lax',
        ]);
    }

    /** Returns [session, user] for a valid session cookie, or null. */
    public function load(Request $request): ?array
    {
        $token = $request->cookie($this->cookieName($request));
        if ($token === null || strlen($token) < 40 || strlen($token) > 64) {
            return null;
        }
        $db = $this->app->db();
        $row = $db->one(
            'SELECT s.*, u.email, u.display_name, u.status AS user_status, u.is_platform_admin
               FROM user_sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ?',
            [Tokens::hash($token)]
        );
        if ($row === null || $row['revoked_at'] !== null) {
            return null;
        }
        $now = $this->app->clock->timestamp();
        $idle = $this->app->config->int('security.session_idle_minutes') * 60;
        if (strtotime($row['expires_at'] . ' UTC') <= $now || strtotime($row['last_seen_at'] . ' UTC') + $idle <= $now) {
            $this->revoke((int) $row['id']);
            return null;
        }
        if ($row['user_status'] !== 'active') {
            // Suspended or unverified accounts lose access immediately.
            $this->revoke((int) $row['id']);
            return null;
        }
        if (strtotime($row['last_seen_at'] . ' UTC') + 60 <= $now) {
            $db->exec('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?', [$this->app->clock->sql(), $row['id']]);
        }
        $user = [
            'id' => (int) $row['user_id'],
            'email' => $row['email'],
            'display_name' => $row['display_name'],
            'is_platform_admin' => (bool) $row['is_platform_admin'],
        ];
        return [$row, $user];
    }

    public function revoke(int $sessionId): void
    {
        $this->app->db()->exec('UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [$this->app->clock->sql(), $sessionId]);
    }

    public function revokeAllForUser(int $userId, ?int $exceptSessionId = null): int
    {
        return $this->app->db()->exec(
            'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?',
            [$this->app->clock->sql(), $userId, $exceptSessionId ?? 0]
        );
    }

    public function activeForUser(int $userId): array
    {
        return $this->app->db()->all(
            'SELECT id, user_agent_summary, ip_masked, created_at, last_seen_at, expires_at FROM user_sessions
              WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 50',
            [$userId, $this->app->clock->sql()]
        );
    }
}
