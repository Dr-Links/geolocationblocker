<?php

declare(strict_types=1);

namespace Signalpost\Audit;

use Signalpost\Core\App;

/**
 * Audit trail for sensitive actions. Metadata is reduced to short scalar
 * values and passed through an allowlist of keys, so message bodies,
 * secrets, passwords and contact details cannot be recorded by mistake.
 */
final class AuditLog
{
    private const ALLOWED_META = [
        'role', 'old_role', 'new_role', 'status', 'old_status', 'new_status', 'website_id', 'visitor_id',
        'conversation_id', 'key_prefix', 'reason_given', 'policy', 'count', 'dry_run', 'categories',
        'expires_at', 'grant_id', 'setting', 'changed', 'origin', 'name', 'target_user_id', 'mode',
        'workspace_id', 'deleted', 'format', 'via', 'invitation_id', 'migrations',
    ];

    public function __construct(private readonly App $app)
    {
    }

    public function workspace(int $workspaceId, ?int $actorUserId, string $action, string $resourceType = '', string|int $resourceId = '', array $meta = [], string $actorType = 'user'): void
    {
        $this->write('workspace', $workspaceId, $actorUserId, $actorType, $action, $resourceType, (string) $resourceId, $meta);
    }

    public function platform(?int $actorUserId, string $action, string $resourceType = '', string|int $resourceId = '', array $meta = [], string $actorType = 'user'): void
    {
        $this->write('platform', null, $actorUserId, $actorType, $action, $resourceType, (string) $resourceId, $meta);
    }

    public static function sanitize(array $meta): array
    {
        $out = [];
        foreach ($meta as $k => $v) {
            if (!in_array($k, self::ALLOWED_META, true)) {
                continue;
            }
            if (is_bool($v) || is_int($v) || $v === null) {
                $out[$k] = $v;
            } elseif (is_string($v)) {
                $out[$k] = mb_substr($v, 0, 120);
            } elseif (is_array($v)) {
                $out[$k] = array_slice(array_map(static fn ($x) => is_scalar($x) ? mb_substr((string) $x, 0, 60) : '', array_values($v)), 0, 20);
            }
        }
        return $out;
    }

    private function write(string $scope, ?int $wsId, ?int $actor, string $actorType, string $action, string $type, string $id, array $meta): void
    {
        $clean = self::sanitize($meta);
        $this->app->db()->insert('audit_logs', [
            'scope' => $scope,
            'workspace_id' => $wsId,
            'actor_user_id' => $actor,
            'actor_type' => $actorType,
            'action' => substr($action, 0, 64),
            'resource_type' => substr($type, 0, 32),
            'resource_id' => substr($id, 0, 64),
            'metadata' => $clean === [] ? null : json_encode($clean, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            'created_at' => $this->app->clock->sql(),
        ]);
    }
}
