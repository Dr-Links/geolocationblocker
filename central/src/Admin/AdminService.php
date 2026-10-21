<?php

declare(strict_types=1);

namespace Signalpost\Admin;

use Signalpost\Audit\AuditLog;
use Signalpost\Auth\SessionManager;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;

/**
 * Platform administration. Deliberately has no access to conversations,
 * messages or visitor data: it works with account- and workspace-level
 * metadata only.
 */
final class AdminService
{
    public function __construct(private readonly App $app)
    {
    }

    public function users(string $search = '', int $page = 1): array
    {
        $params = [];
        $where = '1=1';
        if ($search !== '') {
            $where = 'u.email LIKE ?';
            $params[] = '%' . addcslashes($search, '%_\\') . '%';
        }
        $offset = (max(1, $page) - 1) * 50;
        return $this->app->db()->all(
            "SELECT u.id, u.email, u.display_name, u.status, u.is_platform_admin, u.created_at, u.last_login_at,
                    (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = u.id AND m.status = 'active') AS workspaces
               FROM users u WHERE {$where} ORDER BY u.id LIMIT 50 OFFSET {$offset}",
            $params
        );
    }

    public function workspaces(): array
    {
        return $this->app->db()->all(
            "SELECT w.id, w.name, w.status, w.created_at, u.email AS owner_email,
                    (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id AND m.status = 'active') AS members,
                    (SELECT COUNT(*) FROM websites s WHERE s.workspace_id = w.id) AS websites
               FROM workspaces w JOIN users u ON u.id = w.owner_user_id ORDER BY w.id LIMIT 500"
        );
    }

    public function setUserStatus(int $actorId, int $userId, string $status): void
    {
        if (!in_array($status, ['active', 'suspended'], true)) {
            throw HttpException::validation(['status' => 'Invalid status.']);
        }
        if ($userId === $actorId) {
            throw HttpException::forbidden('You cannot change your own account status.');
        }
        $user = $this->app->db()->one('SELECT id, status, is_platform_admin FROM users WHERE id = ?', [$userId]);
        if ($user === null) {
            throw HttpException::notFound();
        }
        $this->app->db()->exec('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [$status, $this->app->clock->sql(), $userId]);
        if ($status === 'suspended') {
            $this->app->get(SessionManager::class)->revokeAllForUser($userId);
        }
        $this->app->get(AuditLog::class)->platform($actorId, $status === 'suspended' ? 'user.suspended' : 'user.reactivated', 'user', $userId, ['old_status' => $user['status'], 'new_status' => $status]);
    }

    public function setWorkspaceStatus(int $actorId, int $workspaceId, string $status): void
    {
        if (!in_array($status, ['active', 'suspended'], true)) {
            throw HttpException::validation(['status' => 'Invalid status.']);
        }
        $n = $this->app->db()->exec("UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ? AND status IN ('active','suspended')", [$status, $this->app->clock->sql(), $workspaceId]);
        if ($n === 0 && $this->app->db()->value('SELECT id FROM workspaces WHERE id = ?', [$workspaceId]) === null) {
            throw HttpException::notFound();
        }
        $this->app->get(AuditLog::class)->platform($actorId, 'workspace.' . ($status === 'suspended' ? 'suspended' : 'reactivated'), 'workspace', $workspaceId);
    }

    public function audit(int $limit = 200): array
    {
        return $this->app->db()->all(
            "SELECT a.id, a.action, a.resource_type, a.resource_id, a.metadata, a.created_at, a.actor_type, u.email AS actor_email
               FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
              WHERE a.scope = 'platform' ORDER BY a.id DESC LIMIT " . max(1, min($limit, 500))
        );
    }

    public function securityEvents(int $limit = 100): array
    {
        return $this->app->db()->all(
            'SELECT event_type, ip_masked, created_at, user_id FROM security_events ORDER BY id DESC LIMIT ' . max(1, min($limit, 500))
        );
    }

    public function health(): array
    {
        $db = $this->app->db();
        $migrator = $this->app->migrator();
        $settings = $this->app->get(PlatformSettings::class);
        $storage = (string) $this->app->config->get('paths.storage');
        return [
            'php_version' => PHP_VERSION,
            'db_version' => (string) $db->value('SELECT VERSION()'),
            'app_version' => SIGNALPOST_VERSION,
            'migrations_applied' => count($migrator->applied()),
            'migrations_pending' => $migrator->pending(),
            'storage_writable' => is_writable($storage . '/logs'),
            'config_world_readable' => $this->configWorldReadable(),
            'https_forced' => (bool) $this->app->config->get('security.force_https'),
            'last_cron_run' => $settings->getState('last_cron_run'),
            'counts' => [
                'users' => (int) $db->value('SELECT COUNT(*) FROM users'),
                'workspaces' => (int) $db->value('SELECT COUNT(*) FROM workspaces'),
                'websites' => (int) $db->value('SELECT COUNT(*) FROM websites'),
            ],
            'failed_logins_24h' => (int) $db->value("SELECT COUNT(*) FROM security_events WHERE event_type = 'login_failed' AND created_at > ?", [$this->app->clock->sql(-86400)]),
            'recent_errors' => $this->app->logger()->recent(30),
        ];
    }

    private function configWorldReadable(): ?bool
    {
        $file = getenv('SIGNALPOST_CONFIG') ?: SIGNALPOST_ROOT . '/config/config.php';
        if (!is_file($file)) {
            return null;
        }
        return (fileperms($file) & 0004) === 0004;
    }
}
