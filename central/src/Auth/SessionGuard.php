<?php

declare(strict_types=1);

namespace Signalpost\Auth;

use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Security\Tokens;

/**
 * Guard for the dashboard trust boundary.
 *
 *  - "session": requires a valid session; state-changing requests must carry
 *    the session-bound CSRF token (form field _csrf or X-CSRF-Token header).
 *  - "guest": session optional; state-changing requests use a double-submit
 *    CSRF cookie (login, registration, password reset, installer).
 *
 * Additionally, cross-origin state-changing requests are rejected by
 * comparing Origin/Referer with the configured application URL.
 */
final class SessionGuard
{
    public const GUEST_CSRF_COOKIE = 'sp_csrf';

    public function __construct(private readonly App $app)
    {
    }

    public function before(Request $request, string $guard, array $opts): void
    {
        $loaded = $this->app->get(SessionManager::class)->load($request);
        if ($loaded !== null) {
            [$session, $user] = $loaded;
            $request->attributes['session'] = $session;
            $request->attributes['user'] = $user;
        }

        if ($guard === 'session' && $loaded === null) {
            throw HttpException::unauthorized();
        }

        $writes = !in_array($request->method, ['GET', 'HEAD'], true);
        if (!$writes) {
            $this->ensureGuestCsrfCookie($request);
            return;
        }
        $this->checkSameOrigin($request);

        $sent = (string) ($request->header('x-csrf-token') ?? $request->input('_csrf', ''));
        if ($loaded !== null) {
            if ($sent === '' || !hash_equals($loaded[0]['csrf_token'], $sent)) {
                // Also accept the guest token on guest routes (e.g. login form opened before a session existed).
                if (!($guard === 'guest' && $this->guestTokenValid($request, $sent))) {
                    throw new HttpException(419, 'csrf_failed', 'Your form has expired. Please reload the page and try again.');
                }
            }
        } elseif (!$this->guestTokenValid($request, $sent)) {
            throw new HttpException(419, 'csrf_failed', 'Your form has expired. Please reload the page and try again.');
        }
    }

    public function after(Request $request, Response $response): Response
    {
        if (isset($request->attributes['new_guest_csrf'])) {
            $response->cookie(self::GUEST_CSRF_COOKIE, $request->attributes['new_guest_csrf'], [
                'path' => '/', 'secure' => $this->app->isSecure($request), 'httponly' => true, 'samesite' => 'Lax',
            ]);
        }
        return $response;
    }

    /** CSRF token to embed in forms for this request. */
    public static function token(Request $request): string
    {
        if (isset($request->attributes['session'])) {
            return $request->attributes['session']['csrf_token'];
        }
        return (string) ($request->attributes['guest_csrf'] ?? '');
    }

    private function ensureGuestCsrfCookie(Request $request): void
    {
        $existing = $request->cookie(self::GUEST_CSRF_COOKIE);
        if ($existing !== null && preg_match('/^[0-9a-f]{64}$/', $existing) === 1) {
            $request->attributes['guest_csrf'] = $existing;
            return;
        }
        $new = Tokens::hex(32);
        $request->attributes['guest_csrf'] = $new;
        $request->attributes['new_guest_csrf'] = $new;
    }

    private function guestTokenValid(Request $request, string $sent): bool
    {
        $cookie = $request->cookie(self::GUEST_CSRF_COOKIE);
        return $cookie !== null && $sent !== '' && strlen($cookie) === 64 && hash_equals($cookie, $sent);
    }

    private function checkSameOrigin(Request $request): void
    {
        $source = $request->header('origin') ?? $request->header('referer');
        if ($source === null || $source === '' || $source === 'null') {
            return; // Non-browser clients; CSRF token check still applies.
        }
        $expected = parse_url((string) $this->app->config->get('app.url'));
        $actual = parse_url($source);
        if (!is_array($expected) || !is_array($actual)
            || strtolower($actual['host'] ?? '') !== strtolower($expected['host'] ?? '')
            || ($actual['scheme'] ?? '') !== ($expected['scheme'] ?? '')
            || ($actual['port'] ?? null) !== ($expected['port'] ?? null)) {
            throw new HttpException(403, 'cross_origin', 'Cross-origin request rejected.');
        }
    }
}
