<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Core\HttpException;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Security\RateLimiter;
use Signalpost\Sites\CredentialService;
use Signalpost\Sites\SettingsSchema;
use Signalpost\Sites\WebsiteService;

/**
 * WordPress connector API (/api/v1/integration/*).
 */
final class IntegrationController extends Controller
{
    /** Fields the WordPress plugin may change. Tracking policy and retention stay dashboard-only. */
    private const PLUGIN_WIDGET_FIELDS = [
        'enabled', 'brand_name', 'primary_color', 'position', 'offset_px', 'launcher_label', 'greeting_title',
        'welcome_message', 'prechat_name', 'prechat_email', 'prechat_phone', 'prechat_notice', 'hidden_paths',
    ];
    private const PLUGIN_TRACKING_FIELDS = ['excluded_paths', 'consent_source'];

    public function pair(Request $request): Response
    {
        $this->app->get(RateLimiter::class)->enforce('pair:ip:' . $this->app->clientIp($request), 10, 3600);
        $in = $request->json();
        $code = is_string($in['pairing_code'] ?? null) ? $in['pairing_code'] : '';
        $siteUrl = is_string($in['site_url'] ?? null) ? substr($in['site_url'], 0, 255) : '';
        $result = $this->app->get(CredentialService::class)->pair(
            $code,
            $siteUrl,
            is_string($in['plugin_version'] ?? null) ? $in['plugin_version'] : null,
            is_string($in['wp_version'] ?? null) ? $in['wp_version'] : null,
        );
        return Response::json($result + ['endpoints' => $this->endpoints()]);
    }

    public function config(Request $request): Response
    {
        $site = $request->attributes['website'];
        return Response::json($this->configPayload($site));
    }

    public function heartbeat(Request $request): Response
    {
        $site = $request->attributes['website'];
        $in = $request->json();
        $plugin = is_string($in['plugin_version'] ?? null) && preg_match('/^[0-9A-Za-z.\-+]{1,20}$/', $in['plugin_version']) ? $in['plugin_version'] : $site['plugin_version'];
        $wp = is_string($in['wp_version'] ?? null) && preg_match('/^[0-9A-Za-z.\-+]{1,20}$/', $in['wp_version']) ? $in['wp_version'] : $site['platform_version'];
        $this->app->db()->exec('UPDATE websites SET plugin_version = ?, platform_version = ?, last_connected_at = ? WHERE id = ?',
            [$plugin, $wp, $this->app->clock->sql(), $site['id']]);
        return Response::json(['status' => $site['status'], 'rotation_requested' => $site['rotation_requested_at'] !== null]);
    }

    public function rotate(Request $request): Response
    {
        if ($request->attributes['credential_in_grace']) {
            throw HttpException::forbidden('This credential has been superseded. Use the newest credential.');
        }
        $credential = $this->app->get(CredentialService::class)->rotate($request->attributes['website']);
        return Response::json(['credential' => $credential, 'grace_seconds' => CredentialService::ROTATION_GRACE]);
    }

    public function disconnect(Request $request): Response
    {
        $site = $request->attributes['website'];
        $this->app->get(CredentialService::class)->revokeAll((int) $site['id']);
        $this->app->db()->exec("UPDATE websites SET status = 'disconnected', updated_at = ? WHERE id = ?", [$this->app->clock->sql(), $site['id']]);
        $this->app->get(\Signalpost\Audit\AuditLog::class)->workspace((int) $site['workspace_id'], null, 'website.disconnected', 'website', (int) $site['id'], ['via' => 'plugin'], 'integration');
        // Central conversations and visitor data are intentionally kept.
        return Response::json(['disconnected' => true, 'data_retained' => true]);
    }

    public function updateSettings(Request $request): Response
    {
        if ($request->attributes['credential_in_grace']) {
            throw HttpException::forbidden('This credential has been superseded. Use the newest credential.');
        }
        $site = $request->attributes['website'];
        $in = $request->json();
        $sites = $this->app->get(WebsiteService::class);
        $widget = array_intersect_key(is_array($in['widget'] ?? null) ? $in['widget'] : [], array_flip(self::PLUGIN_WIDGET_FIELDS));
        $tracking = array_intersect_key(is_array($in['tracking'] ?? null) ? $in['tracking'] : [], array_flip(self::PLUGIN_TRACKING_FIELDS));
        if ($widget !== []) {
            $sites->updateSettings((int) $site['workspace_id'], (int) $site['id'], 'widget', $widget, null, 'integration');
        }
        if ($tracking !== []) {
            $sites->updateSettings((int) $site['workspace_id'], (int) $site['id'], 'tracking', $tracking, null, 'integration');
        }
        return Response::json($this->configPayload($site));
    }

    private function configPayload(array $site): array
    {
        $settings = $this->app->get(WebsiteService::class)->settings((int) $site['id']);
        $polling = $this->app->config->get('polling');
        return [
            'website' => [
                'public_key' => $site['public_key'],
                'name' => $site['name'],
                'origin' => $site['canonical_origin'],
                'status' => $site['status'],
            ],
            'rotation_requested' => $site['rotation_requested_at'] !== null,
            'widget' => $settings['widget'],
            'tracking' => $settings['tracking'],
            'polling' => $polling,
            'endpoints' => $this->endpoints(),
        ];
    }

    private function endpoints(): array
    {
        $base = rtrim((string) $this->app->config->get('app.url'), '/');
        return [
            'api_base' => $base . '/api/v1',
            'widget_script' => $base . '/widget/v1/widget.js',
            'widget_style' => $base . '/widget/v1/widget.css',
        ];
    }
}
