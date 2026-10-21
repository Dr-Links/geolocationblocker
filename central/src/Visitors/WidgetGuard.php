<?php

declare(strict_types=1);

namespace Signalpost\Visitors;

use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Security\RateLimiter;
use Signalpost\Sites\WebsiteService;

/**
 * Guard for the public visitor widget boundary (/api/v1/widget/{site}/...).
 *
 * - {site} is the website's non-secret public key; it selects the website,
 *   it does not authenticate anything.
 * - The browser Origin, when present, must equal the website's canonical
 *   origin. This is a validation/CORS measure, NOT authentication: visitor
 *   access to data is controlled solely by the visitor token.
 * - No cookies are used; the visitor token travels in X-Visitor-Token.
 * - Only visitor-facing endpoints exist under this prefix; nothing here can
 *   reach dashboard, integration or other websites' data.
 */
final class WidgetGuard
{
    public function __construct(private readonly App $app)
    {
    }

    public function before(Request $request, string $guard, array $opts): void
    {
        $site = $this->site($request);
        $origin = $request->header('origin');
        if ($origin !== null && $origin !== '' && $origin !== $site['canonical_origin']) {
            throw new HttpException(403, 'origin_not_allowed', 'This website is not allowed to use this chat.');
        }
        if ($origin !== null && $origin !== '') {
            $request->attributes['cors_origin'] = $site['canonical_origin'];
        }
        $this->app->get(RateLimiter::class)->enforce('widget:' . $site['id'] . ':' . $this->app->clientIp($request), 240, 60);

        $settings = $this->app->get(WebsiteService::class)->settings((int) $site['id']);
        if (!$settings['widget']['enabled']) {
            throw new HttpException(404, 'chat_unavailable', 'Chat is not available right now.');
        }
        $request->attributes['website'] = $site;
        $request->attributes['settings'] = $settings;
        $request->attributes['visitor'] = $this->app->get(VisitorService::class)->resolve($site, $request->header('x-visitor-token'));
    }

    public function after(Request $request, Response $response): Response
    {
        if (isset($request->attributes['cors_origin'])) {
            $response->header('Access-Control-Allow-Origin', $request->attributes['cors_origin']);
        }
        $response->header('Vary', 'Origin');
        return $response;
    }

    public function preflight(Request $request, array $allowed): Response
    {
        $response = new Response('', 204, ['Cache-Control' => 'no-store', 'Vary' => 'Origin']);
        if (!str_starts_with($request->path, '/api/v1/widget/')) {
            return $response; // CORS is only offered on the public widget API.
        }
        try {
            $site = $this->site($request);
        } catch (HttpException) {
            return $response;
        }
        if ($request->header('origin') === $site['canonical_origin']) {
            $response->header('Access-Control-Allow-Origin', $site['canonical_origin'])
                ->header('Access-Control-Allow-Methods', implode(', ', array_unique($allowed)))
                ->header('Access-Control-Allow-Headers', 'Content-Type, X-Visitor-Token')
                ->header('Access-Control-Max-Age', '600');
        }
        return $response;
    }

    private function site(Request $request): array
    {
        $key = $request->param('site');
        if (preg_match('/^[0-9a-f]{32}$/', $key) !== 1) {
            throw new HttpException(404, 'chat_unavailable', 'Chat is not available right now.');
        }
        $site = $this->app->db()->one(
            "SELECT w.* FROM websites w JOIN workspaces ws ON ws.id = w.workspace_id
              WHERE w.public_key = ? AND w.status = 'connected' AND ws.status = 'active'",
            [$key]
        );
        if ($site === null) {
            throw new HttpException(404, 'chat_unavailable', 'Chat is not available right now.');
        }
        return $site;
    }
}
