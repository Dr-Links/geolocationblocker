<?php

declare(strict_types=1);

namespace Signalpost\Visitors;

use Signalpost\Audit\AuditLog;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Sites\WebsiteService;
use Signalpost\Tenancy\WorkspaceContext;

/**
 * Visitor blocking by opaque visitor ID only, scoped to one website in one
 * workspace. There is deliberately no IP-based blocking. A person who clears
 * browser storage or switches browser gets a new visitor ID and is not
 * recognised; this limitation is documented and must not be circumvented
 * with fingerprinting or IP matching.
 */
final class BlockService
{
    public function __construct(private readonly App $app)
    {
    }

    public function isBlocked(int $visitorId): bool
    {
        return $this->app->db()->value("SELECT id FROM visitor_blocks WHERE visitor_id = ? AND status = 'active' LIMIT 1", [$visitorId]) !== null;
    }

    public function activeBlock(WorkspaceContext $ctx, int $visitorId): ?array
    {
        return $this->app->db()->one(
            "SELECT b.id, b.reason, b.created_at, u.email AS blocked_by FROM visitor_blocks b LEFT JOIN users u ON u.id = b.blocked_by_user_id
              WHERE b.visitor_id = ? AND b.workspace_id = ? AND b.status = 'active' ORDER BY b.id DESC LIMIT 1",
            [$visitorId, $ctx->workspaceId]
        );
    }

    public function block(WorkspaceContext $ctx, int $visitorId, ?string $reason): void
    {
        $ctx->require('visitors.block');
        $visitor = $this->app->get(VisitorService::class)->get($ctx, $visitorId);
        if ($this->isBlocked($visitorId)) {
            return;
        }
        $db = $this->app->db();
        $widget = $this->app->get(WebsiteService::class)->settings((int) $visitor['website_id'])['widget'];
        $db->transaction(function () use ($db, $ctx, $visitor, $reason, $widget): void {
            $now = $this->app->clock->sql();
            $id = $db->insert('visitor_blocks', [
                'workspace_id' => $ctx->workspaceId,
                'website_id' => $visitor['website_id'],
                'visitor_id' => $visitor['id'],
                'blocked_by_user_id' => $ctx->userId,
                'reason' => $reason,
                'status' => 'active',
                'created_at' => $now,
            ]);
            if ($widget['block_conversation_action'] === 'close') {
                $db->exec("UPDATE conversations SET status = 'closed', closed_at = COALESCE(closed_at, ?), read_only = 1, updated_at = ? WHERE visitor_id = ? AND workspace_id = ?", [$now, $now, $visitor['id'], $ctx->workspaceId]);
            } else {
                $db->exec('UPDATE conversations SET read_only = 1, updated_at = ? WHERE visitor_id = ? AND workspace_id = ?', [$now, $visitor['id'], $ctx->workspaceId]);
            }
            // The reason is kept in the block record only; the audit log notes whether one was given.
            $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'visitor.blocked', 'visitor', $visitor['public_id'], [
                'website_id' => (int) $visitor['website_id'], 'reason_given' => $reason !== null && $reason !== '', 'policy' => $widget['block_conversation_action'],
            ]);
        });
    }

    public function unblock(WorkspaceContext $ctx, int $visitorId): void
    {
        $ctx->require('visitors.block');
        $visitor = $this->app->get(VisitorService::class)->get($ctx, $visitorId);
        $db = $this->app->db();
        $now = $this->app->clock->sql();
        $n = $db->exec("UPDATE visitor_blocks SET status = 'revoked', revoked_at = ?, revoked_by_user_id = ? WHERE visitor_id = ? AND workspace_id = ? AND status = 'active'",
            [$now, $ctx->userId, $visitorId, $ctx->workspaceId]);
        if ($n === 0) {
            return;
        }
        $db->exec('UPDATE conversations SET read_only = 0, updated_at = ? WHERE visitor_id = ? AND workspace_id = ?', [$now, $visitorId, $ctx->workspaceId]);
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'visitor.unblocked', 'visitor', $visitor['public_id'], ['website_id' => (int) $visitor['website_id']]);
    }

    public function list(WorkspaceContext $ctx, bool $includeRevoked = false): array
    {
        $ctx->require('visitors.read');
        return $this->app->db()->all(
            'SELECT b.id, b.visitor_id, b.reason, b.status, b.created_at, b.revoked_at, v.public_id, v.name, s.name AS website_name,
                    ub.email AS blocked_by, ur.email AS revoked_by
               FROM visitor_blocks b JOIN visitors v ON v.id = b.visitor_id JOIN websites s ON s.id = b.website_id
               LEFT JOIN users ub ON ub.id = b.blocked_by_user_id LEFT JOIN users ur ON ur.id = b.revoked_by_user_id
              WHERE b.workspace_id = ?' . ($includeRevoked ? '' : " AND b.status = 'active'") . ' ORDER BY b.id DESC LIMIT 200',
            [$ctx->workspaceId]
        );
    }

    public function history(WorkspaceContext $ctx, int $visitorId): array
    {
        $this->app->get(VisitorService::class)->get($ctx, $visitorId);
        return $this->app->db()->all(
            'SELECT b.reason, b.status, b.created_at, b.revoked_at, ub.email AS blocked_by, ur.email AS revoked_by
               FROM visitor_blocks b LEFT JOIN users ub ON ub.id = b.blocked_by_user_id LEFT JOIN users ur ON ur.id = b.revoked_by_user_id
              WHERE b.visitor_id = ? AND b.workspace_id = ? ORDER BY b.id DESC',
            [$visitorId, $ctx->workspaceId]
        );
    }

    /** Throws the generic denial used by the widget API. */
    public static function deny(): never
    {
        throw new HttpException(403, 'chat_unavailable', 'Chat is not available right now.');
    }
}
