<?php

declare(strict_types=1);

namespace Signalpost\Privacy;

use Signalpost\Audit\AuditLog;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Security\Passwords;
use Signalpost\Tenancy\WorkspaceContext;

/**
 * Permanent workspace deletion. Only the primary owner can do it, after
 * typing the workspace name and re-entering their password. All workspace
 * data is removed through foreign-key cascades scoped to this workspace ID;
 * no other workspace's rows can be affected. A platform-level audit entry
 * (without personal data) survives the deletion.
 */
final class WorkspaceDeletionService
{
    public function __construct(private readonly App $app)
    {
    }

    public function delete(WorkspaceContext $ctx, string $confirmName, string $password): void
    {
        $ctx->require('workspace.manage');
        if ($ctx->userId !== $ctx->primaryOwnerId) {
            throw HttpException::forbidden('Only the primary owner can delete this workspace.');
        }
        $db = $this->app->db();
        $ws = $db->one('SELECT id, name FROM workspaces WHERE id = ?', [$ctx->workspaceId]);
        if ($ws === null) {
            throw HttpException::notFound();
        }
        $errors = [];
        if (trim($confirmName) !== $ws['name']) {
            $errors['confirm_name'] = 'Type the workspace name exactly.';
        }
        $hash = (string) $db->value('SELECT password_hash FROM users WHERE id = ?', [$ctx->userId]);
        if (!Passwords::verify($password, $hash)) {
            $errors['password'] = 'Password is incorrect.';
        }
        if ($errors !== []) {
            throw HttpException::validation($errors);
        }
        $counts = [
            'websites' => (int) $db->value('SELECT COUNT(*) FROM websites WHERE workspace_id = ?', [$ws['id']]),
            'visitors' => (int) $db->value('SELECT COUNT(*) FROM visitors WHERE workspace_id = ?', [$ws['id']]),
            'conversations' => (int) $db->value('SELECT COUNT(*) FROM conversations WHERE workspace_id = ?', [$ws['id']]),
        ];
        $db->transaction(function () use ($db, $ws): void {
            $db->exec('DELETE FROM workspaces WHERE id = ?', [$ws['id']]);
        });
        $this->app->get(AuditLog::class)->platform($ctx->userId, 'workspace.deleted', 'workspace', (int) $ws['id'], ['count' => array_sum($counts), 'workspace_id' => (int) $ws['id']]);
    }
}
