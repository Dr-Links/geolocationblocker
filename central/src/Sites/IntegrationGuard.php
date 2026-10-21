<?php

declare(strict_types=1);

namespace Signalpost\Sites;

use Signalpost\Auth\AuthService;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Http\Request;
use Signalpost\Security\RateLimiter;

/**
 * Guard for the WordPress server-to-server trust boundary.
 * The website is derived only from the credential; integration endpoints
 * never accept a website or workspace identifier from the client.
 */
final class IntegrationGuard
{
    public function __construct(private readonly App $app)
    {
    }

    public function before(Request $request, string $guard, array $opts): void
    {
        $limiter = $this->app->get(RateLimiter::class);
        $ip = $this->app->clientIp($request);
        $header = (string) $request->header('authorization');
        $credential = str_starts_with($header, 'Bearer ') ? trim(substr($header, 7)) : '';

        $failBucket = 'integration:fail:' . $ip;
        if ($limiter->count($failBucket, 300) >= 30) {
            throw HttpException::tooMany();
        }
        $site = $credential === '' ? null : $this->app->get(CredentialService::class)->authenticate($credential);
        if ($site === null) {
            $limiter->hit($failBucket, PHP_INT_MAX, 300);
            $this->app->get(AuthService::class)->securityEvent('integration_auth_failed', null, $ip);
            throw HttpException::unauthorized('Invalid or revoked site credentials.');
        }
        $limiter->enforce('integration:site:' . $site['id'], 120, 60);
        $request->attributes['website'] = $site;
        $request->attributes['credential_in_grace'] = $site['revoked_at'] !== null;
    }
}
