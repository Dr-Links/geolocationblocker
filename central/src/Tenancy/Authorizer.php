<?php

declare(strict_types=1);

namespace Signalpost\Tenancy;

use Signalpost\Audit\AuditLog;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Http\Request;

/**
 * Single choke point for workspace authorisation.
 *
 * Verifies: authenticated identity (from the session guard), active
 * membership in an active workspace (or an active support grant for a
 * platform admin), and the permission required for the operation.
 * Non-members get 404 so workspace existence is not disclosed.
 */
final class Authorizer
{
    public function __construct(private readonly App $app)
    {
    }

    public function context(Request $request, int $workspaceId, string $permission = 'workspace.view'): WorkspaceContext
    {
        $user = $request->attributes['user'] ?? null;
        if ($user === null) {
            throw HttpException::unauthorized();
        }
        $cacheKey = 'ws_ctx_' . $workspaceId;
        $ctx = $request->attributes[$cacheKey] ?? null;
        if ($ctx === null) {
            $ctx = $this->resolve((int) $user['id'], (bool) $user['is_platform_admin'], $workspaceId, $request);
            $request->attributes[$cacheKey] = $ctx;
        }
        $ctx->require($permission);
        return $ctx;
    }

    private function resolve(int $userId, bool $isAdmin, int $workspaceId, Request $request): WorkspaceContext
    {
        $db = $this->app->db();
        $row = $db->one(
            "SELECT w.id, w.name, w.owner_user_id, m.role
               FROM workspaces w
               JOIN workspace_members m ON m.workspace_id = w.id
              WHERE w.id = ? AND w.status = 'active' AND m.user_id = ? AND m.status = 'active'",
            [$workspaceId, $userId]
        );
        if ($row !== null && in_array($row['role'], Roles::ASSIGNABLE, true)) {
            return new WorkspaceContext((int) $row['id'], $row['name'], $userId, $row['role'], (int) $row['owner_user_id']);
        }
        if ($isAdmin) {
            $grant = $db->one(
                "SELECT g.id, w.name, w.owner_user_id FROM support_grants g JOIN workspaces w ON w.id = g.workspace_id
                  WHERE g.workspace_id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND w.status = 'active'
                  ORDER BY g.expires_at DESC LIMIT 1",
                [$workspaceId, $this->app->clock->sql()]
            );
            if ($grant !== null) {
                // Every route read under a grant is audited (polling included), at most once per
                // route per 10 minutes so polling does not flood the log.
                $route = substr($request->path, 0, 64);
                $recent = $db->value(
                    "SELECT id FROM audit_logs WHERE workspace_id = ? AND actor_user_id = ? AND action = 'support.access' AND resource_id = ? AND created_at > ? LIMIT 1",
                    [$workspaceId, $userId, $route, $this->app->clock->sql(-600)]
                );
                if ($recent === null) {
                    $this->app->get(AuditLog::class)->workspace($workspaceId, $userId, 'support.access', 'route', $route, ['grant_id' => (int) $grant['id']], 'support');
                }
                return new WorkspaceContext($workspaceId, $grant['name'], $userId, Roles::SUPPORT, (int) $grant['owner_user_id']);
            }
        }
        throw HttpException::notFound();
    }

    /** Workspaces the user can enter (memberships plus active support grants). */
    public function accessibleWorkspaces(array $user): array
    {
        $db = $this->app->db();
        $rows = $db->all(
            "SELECT w.id, w.name, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
              WHERE m.user_id = ? AND m.status = 'active' AND w.status = 'active' ORDER BY w.name",
            [$user['id']]
        );
        if ($user['is_platform_admin']) {
            $support = $db->all(
                "SELECT DISTINCT w.id, w.name, 'support' AS role FROM support_grants g JOIN workspaces w ON w.id = g.workspace_id
                  WHERE g.revoked_at IS NULL AND g.expires_at > ? AND w.status = 'active'
                    AND w.id NOT IN (SELECT workspace_id FROM workspace_members WHERE user_id = ? AND status = 'active')",
                [$this->app->clock->sql(), $user['id']]
            );
            $rows = array_merge($rows, $support);
        }
        return $rows;
    }
}
