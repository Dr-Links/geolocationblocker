<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Core\HttpException;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Push\PushService;
use Signalpost\Security\RateLimiter;

/** Installable operator app: web manifest and Web Push subscription API. */
final class PwaController extends Controller
{
    public function manifest(Request $request): Response
    {
        $name = (string) $this->app->config->get('app.name');
        // Home-screen label: an explicit short name, else the name if it fits (~12 chars), else the name without spaces.
        $short = (string) $this->app->config->get('app.short_name', '');
        if ($short === '') {
            $compact = str_replace(' ', '', $name);
            $short = mb_strlen($name) <= 12 ? $name : (mb_strlen($compact) <= 12 ? $compact : mb_substr($compact, 0, 12));
        }
        $manifest = [
            'name' => $name,
            'short_name' => $short,
            'description' => 'Answer website visitors from one inbox.',
            'id' => '/',
            'start_url' => '/?source=pwa',
            'scope' => '/',
            'display' => 'standalone',
            'orientation' => 'any',
            'background_color' => '#f5f6f4',
            'theme_color' => '#0b2b2c',
            'icons' => [
                ['src' => '/assets/icons/icon-192.png', 'sizes' => '192x192', 'type' => 'image/png', 'purpose' => 'any'],
                ['src' => '/assets/icons/icon-512.png', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'any'],
                ['src' => '/assets/icons/maskable-512.png', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'maskable'],
            ],
            'shortcuts' => [
                ['name' => 'Inbox', 'url' => '/?go=inbox', 'icons' => [['src' => '/assets/icons/icon-192.png', 'sizes' => '192x192']]],
                ['name' => 'Live visitors', 'url' => '/?go=live', 'icons' => [['src' => '/assets/icons/icon-192.png', 'sizes' => '192x192']]],
            ],
        ];
        return new Response((string) json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), 200, [
            'Content-Type' => 'application/manifest+json; charset=utf-8',
            'Cache-Control' => 'public, max-age=3600',
        ]);
    }

    public function key(Request $request): Response
    {
        return Response::json(['public_key' => $this->app->get(PushService::class)->publicKey()]);
    }

    public function subscribe(Request $request): Response
    {
        $user = $this->user($request);
        $this->app->get(RateLimiter::class)->enforce('push:sub:' . $user['id'], 20, 3600);
        $in = $request->json();
        $keys = is_array($in['keys'] ?? null) ? $in['keys'] : [];
        $this->app->get(PushService::class)->subscribe($user['id'], $in['endpoint'] ?? null, $keys['p256dh'] ?? null, $keys['auth'] ?? null, $request->header('user-agent'));
        return Response::json(['subscribed' => true], 201);
    }

    public function unsubscribe(Request $request): Response
    {
        $this->app->get(PushService::class)->unsubscribe($this->user($request)['id'], $request->json()['endpoint'] ?? null);
        return Response::json(['subscribed' => false]);
    }

    public function test(Request $request): Response
    {
        $user = $this->user($request);
        $this->app->get(RateLimiter::class)->enforce('push:test:' . $user['id'], 5, 600);
        $n = $this->app->get(PushService::class)->sendToUser($user['id'], [
            'title' => (string) $this->app->config->get('app.name'),
            'body' => 'Notifications are working on this device.',
            'url' => '/account',
            'tag' => 'test',
        ]);
        return Response::json(['delivered' => $n]);
    }

    public function preferences(Request $request): Response
    {
        $user = $this->user($request);
        $preview = $request->input('push_show_preview');
        $this->app->db()->exec('UPDATE users SET push_show_preview = ?, updated_at = ? WHERE id = ?', [
            in_array($preview, ['1', 1, true, 'on'], true) ? 1 : 0, $this->app->clock->sql(), $user['id'],
        ]);
        return Response::redirect('/account?ok=saved#notifications');
    }

    public function removeDevice(Request $request): Response
    {
        $user = $this->user($request);
        $n = $this->app->db()->exec('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?', [$request->intParam('id'), $user['id']]);
        if ($n !== 1) {
            throw HttpException::notFound();
        }
        return Response::redirect('/account?ok=revoked#notifications');
    }
}
