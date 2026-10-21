<?php

declare(strict_types=1);

namespace Signalpost\Sites;

use Signalpost\Admin\PlatformSettings;
use Signalpost\Audit\AuditLog;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Security\Tokens;
use Signalpost\Tenancy\WorkspaceContext;

/**
 * Website registration and per-website settings. Every read and write is
 * scoped by the authorised workspace; a website ID from another workspace
 * behaves exactly like a missing one (404).
 */
final class WebsiteService
{
    public const PAIRING_TTL = 1800;

    public function __construct(private readonly App $app)
    {
    }

    public function allowInsecureOrigins(): bool
    {
        return $this->app->config->get('app.env') !== 'production';
    }

    public function list(WorkspaceContext $ctx): array
    {
        $ctx->require('websites.read');
        return $this->app->db()->all(
            'SELECT id, name, canonical_origin, status, tracking_policy, created_at, last_connected_at, last_activity_at, plugin_version
               FROM websites WHERE workspace_id = ? ORDER BY name',
            [$ctx->workspaceId]
        );
    }

    public function get(WorkspaceContext $ctx, int $websiteId, string $permission = 'websites.read'): array
    {
        $ctx->require($permission);
        $row = $this->app->db()->one('SELECT * FROM websites WHERE id = ? AND workspace_id = ?', [$websiteId, $ctx->workspaceId]);
        if ($row === null) {
            throw HttpException::notFound();
        }
        return $row;
    }

    public function create(WorkspaceContext $ctx, string $name, string $originInput): int
    {
        $ctx->require('websites.manage');
        $origin = Origin::normalize($originInput, $this->allowInsecureOrigins());
        if ($origin === null) {
            throw HttpException::validation(['origin' => 'Enter the site address like https://www.example.com (HTTPS, no path).']);
        }
        $db = $this->app->db();
        $max = (int) $this->app->get(PlatformSettings::class)->get('max_websites_per_workspace');
        if ((int) $db->value('SELECT COUNT(*) FROM websites WHERE workspace_id = ?', [$ctx->workspaceId]) >= $max) {
            throw HttpException::forbidden("This workspace has reached the limit of {$max} websites.");
        }
        if ($db->value('SELECT id FROM websites WHERE workspace_id = ? AND canonical_origin = ?', [$ctx->workspaceId, $origin]) !== null) {
            throw HttpException::validation(['origin' => 'This website is already registered in this workspace.']);
        }
        return $db->transaction(function () use ($db, $ctx, $name, $origin): int {
            $now = $this->app->clock->sql();
            $id = $db->insert('websites', [
                'workspace_id' => $ctx->workspaceId,
                'public_key' => Tokens::hex(16),
                'name' => $name,
                'canonical_origin' => $origin,
                'status' => 'pending',
                'tracking_policy' => 'essential',
                'created_at' => $now,
                'updated_at' => $now,
            ]);
            $db->insert('website_settings', [
                'workspace_id' => $ctx->workspaceId,
                'website_id' => $id,
                'widget_config' => json_encode(SettingsSchema::defaults(SettingsSchema::WIDGET)),
                'tracking_config' => json_encode(SettingsSchema::defaults(SettingsSchema::TRACKING)),
                'retention_config' => json_encode(SettingsSchema::defaults(SettingsSchema::RETENTION)),
                'updated_at' => $now,
            ]);
            $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'website.created', 'website', $id, ['origin' => $origin]);
            return $id;
        });
    }

    public function update(WorkspaceContext $ctx, int $websiteId, string $name, string $originInput): void
    {
        $site = $this->get($ctx, $websiteId, 'websites.manage');
        $origin = Origin::normalize($originInput, $this->allowInsecureOrigins());
        if ($origin === null) {
            throw HttpException::validation(['origin' => 'Enter the site address like https://www.example.com (HTTPS, no path).']);
        }
        $this->app->db()->exec('UPDATE websites SET name = ?, canonical_origin = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
            [$name, $origin, $this->app->clock->sql(), $websiteId, $ctx->workspaceId]);
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'website.updated', 'website', $websiteId, ['origin' => $origin, 'changed' => $origin !== $site['canonical_origin']]);
    }

    /** @return array{widget:array,tracking:array,retention:array} */
    public function settings(int $websiteId): array
    {
        $row = $this->app->db()->one('SELECT widget_config, tracking_config, retention_config FROM website_settings WHERE website_id = ?', [$websiteId]);
        $decode = static fn (?string $json) => is_array($d = json_decode((string) $json, true)) ? $d : [];
        // Re-validate on read so a corrupted row can never yield out-of-schema values.
        return [
            'widget' => SettingsSchema::validate(SettingsSchema::WIDGET, [], $decode($row['widget_config'] ?? null)),
            'tracking' => SettingsSchema::validate(SettingsSchema::TRACKING, [], $decode($row['tracking_config'] ?? null)),
            'retention' => SettingsSchema::validate(SettingsSchema::RETENTION, [], $decode($row['retention_config'] ?? null)),
        ];
    }

    /**
     * Updates one settings section after schema validation.
     * $actor is either a WorkspaceContext (dashboard) or null when called by the integration API.
     */
    public function updateSettings(int $workspaceId, int $websiteId, string $section, array $input, ?int $actorUserId, string $actorType = 'user'): array
    {
        $schema = match ($section) {
            'widget' => SettingsSchema::WIDGET,
            'tracking' => SettingsSchema::TRACKING,
            'retention' => SettingsSchema::RETENTION,
            default => throw new \InvalidArgumentException('Unknown section'),
        };
        $current = $this->settings($websiteId)[$section];
        $new = SettingsSchema::validate($schema, $input, $current);
        $column = $section . '_config';
        $db = $this->app->db();
        $db->exec("UPDATE website_settings SET {$column} = ?, updated_at = ? WHERE website_id = ? AND workspace_id = ?",
            [json_encode($new), $this->app->clock->sql(), $websiteId, $workspaceId]);
        if ($section === 'tracking') {
            $db->exec('UPDATE websites SET tracking_policy = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
                [$new['analytics_enabled'] ? 'analytics' : 'essential', $this->app->clock->sql(), $websiteId, $workspaceId]);
        }
        $changed = array_keys(array_filter($new, static fn ($v, $k) => ($current[$k] ?? null) !== $v, ARRAY_FILTER_USE_BOTH));
        if ($changed !== []) {
            $this->app->get(AuditLog::class)->workspace($workspaceId, $actorUserId, 'website.settings_changed', 'website', $websiteId, ['setting' => $section, 'changed' => $changed], $actorType);
        }
        return $new;
    }

    /** Generates a one-time pairing code (returned once, stored hashed). */
    public function createPairingCode(WorkspaceContext $ctx, int $websiteId): string
    {
        $this->get($ctx, $websiteId, 'credentials.manage');
        $db = $this->app->db();
        $now = $this->app->clock->sql();
        // Only one live code per website.
        $db->exec('UPDATE pairing_codes SET used_at = ? WHERE website_id = ? AND used_at IS NULL', [$now, $websiteId]);
        $code = Tokens::pairingCode();
        $db->insert('pairing_codes', [
            'website_id' => $websiteId,
            'code_hash' => Tokens::hash($code),
            'created_by_user_id' => $ctx->userId,
            'created_at' => $now,
            'expires_at' => $this->app->clock->sql(self::PAIRING_TTL),
        ]);
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'website.pairing_code_created', 'website', $websiteId);
        return $code;
    }

    public function activeCredentials(WorkspaceContext $ctx, int $websiteId): array
    {
        $this->get($ctx, $websiteId, 'websites.read');
        return $this->app->db()->all(
            'SELECT key_prefix, created_at, last_used_at, revoked_at FROM site_credentials
              WHERE website_id = ? AND (revoked_at IS NULL OR revoked_at > ?) ORDER BY id DESC',
            [$websiteId, $this->app->clock->sql()]
        );
    }

    public function requestRotation(WorkspaceContext $ctx, int $websiteId): void
    {
        $this->get($ctx, $websiteId, 'credentials.manage');
        $this->app->db()->exec('UPDATE websites SET rotation_requested_at = ? WHERE id = ? AND workspace_id = ?', [$this->app->clock->sql(), $websiteId, $ctx->workspaceId]);
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'website.rotation_requested', 'website', $websiteId);
    }

    /** Revokes all credentials immediately. Central data is kept. */
    public function disconnect(WorkspaceContext $ctx, int $websiteId): void
    {
        $this->get($ctx, $websiteId, 'credentials.manage');
        $this->app->get(CredentialService::class)->revokeAll($websiteId);
        $this->app->db()->exec("UPDATE websites SET status = 'disconnected', rotation_requested_at = NULL, updated_at = ? WHERE id = ?", [$this->app->clock->sql(), $websiteId]);
        $this->app->db()->exec('UPDATE pairing_codes SET used_at = ? WHERE website_id = ? AND used_at IS NULL', [$this->app->clock->sql(), $websiteId]);
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'website.disconnected', 'website', $websiteId);
    }

    /** Deletes the website and all of its visitors, conversations, events and settings. */
    public function delete(WorkspaceContext $ctx, int $websiteId, string $confirmName): void
    {
        $site = $this->get($ctx, $websiteId, 'websites.manage');
        if (trim($confirmName) !== $site['name']) {
            throw HttpException::validation(['confirm_name' => 'Type the website name exactly to confirm.']);
        }
        $this->app->db()->exec('DELETE FROM websites WHERE id = ? AND workspace_id = ?', [$websiteId, $ctx->workspaceId]);
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'website.deleted', 'website', $websiteId, ['name' => $site['name']]);
    }
}
