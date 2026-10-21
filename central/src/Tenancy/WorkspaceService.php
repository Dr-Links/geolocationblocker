<?php

declare(strict_types=1);

namespace Signalpost\Tenancy;

use Signalpost\Admin\PlatformSettings;
use Signalpost\Audit\AuditLog;
use Signalpost\Auth\Mailer;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Security\Tokens;

/**
 * Workspaces, memberships, invitations and support grants.
 * Every mutating method takes an authorised WorkspaceContext and only
 * touches rows belonging to that context's workspace.
 */
final class WorkspaceService
{
    public function __construct(private readonly App $app)
    {
    }

    public function create(int $userId, string $name): int
    {
        $db = $this->app->db();
        $max = (int) $this->app->get(PlatformSettings::class)->get('max_workspaces_per_user');
        $owned = (int) $db->value("SELECT COUNT(*) FROM workspaces WHERE owner_user_id = ? AND status <> 'deleted'", [$userId]);
        if ($owned >= $max) {
            throw HttpException::forbidden("You have reached the limit of {$max} workspaces.");
        }
        return $db->transaction(function () use ($db, $userId, $name): int {
            $now = $this->app->clock->sql();
            $wsId = $db->insert('workspaces', [
                'name' => $name, 'owner_user_id' => $userId, 'status' => 'active', 'created_at' => $now, 'updated_at' => $now,
            ]);
            $db->insert('workspace_members', [
                'workspace_id' => $wsId, 'user_id' => $userId, 'role' => Roles::OWNER, 'status' => 'active', 'created_at' => $now, 'updated_at' => $now,
            ]);
            $this->app->get(AuditLog::class)->workspace($wsId, $userId, 'workspace.created', 'workspace', $wsId);
            return $wsId;
        });
    }

    public function rename(WorkspaceContext $ctx, string $name): void
    {
        $ctx->require('workspace.manage');
        $this->app->db()->exec('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?', [$name, $this->app->clock->sql(), $ctx->workspaceId]);
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'workspace.renamed', 'workspace', $ctx->workspaceId);
    }

    public function members(WorkspaceContext $ctx): array
    {
        $ctx->require('workspace.view');
        return $this->app->db()->all(
            'SELECT m.id, m.user_id, m.role, m.status, m.created_at, u.email, u.display_name, u.status AS user_status
               FROM workspace_members m JOIN users u ON u.id = m.user_id
              WHERE m.workspace_id = ? ORDER BY m.status, u.email',
            [$ctx->workspaceId]
        );
    }

    public function invitations(WorkspaceContext $ctx): array
    {
        $ctx->require('members.manage');
        return $this->app->db()->all(
            'SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at FROM workspace_invitations
              WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
            [$ctx->workspaceId, $this->app->clock->sql()]
        );
    }

    /** Returns the one-time invitation URL (also emailed). */
    public function invite(WorkspaceContext $ctx, string $email, string $role): string
    {
        $ctx->require('members.manage');
        if (!in_array($role, Roles::ASSIGNABLE, true)) {
            throw HttpException::validation(['role' => 'Invalid role.']);
        }
        $db = $this->app->db();
        $max = (int) $this->app->get(PlatformSettings::class)->get('max_members_per_workspace');
        $count = (int) $db->value("SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ? AND status = 'active'", [$ctx->workspaceId]);
        if ($count >= $max) {
            throw HttpException::forbidden("This workspace has reached the limit of {$max} members.");
        }
        $existing = $db->value(
            "SELECT m.id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ? AND m.status = 'active'",
            [$ctx->workspaceId, $email]
        );
        if ($existing !== null) {
            throw HttpException::validation(['email' => 'This person is already a member.']);
        }
        $token = Tokens::random(32);
        $id = $db->insert('workspace_invitations', [
            'workspace_id' => $ctx->workspaceId,
            'email' => $email,
            'role' => $role,
            'token_hash' => Tokens::hash($token),
            'invited_by_user_id' => $ctx->userId,
            'created_at' => $this->app->clock->sql(),
            'expires_at' => $this->app->clock->sql(7 * 86400),
        ]);
        $mailer = $this->app->get(Mailer::class);
        $url = $mailer->url('/invite/' . $token);
        $mailer->send($email, 'You are invited to a Signalpost workspace', "You have been invited to join the Signalpost workspace \"{$ctx->workspaceName}\" as " . Roles::label($role) . ".\n\nAccept within 7 days:\n{$url}\n");
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'member.invited', 'invitation', $id, ['role' => $role]);
        return $url;
    }

    public function revokeInvitation(WorkspaceContext $ctx, int $invitationId): void
    {
        $ctx->require('members.manage');
        $n = $this->app->db()->exec(
            'UPDATE workspace_invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL',
            [$this->app->clock->sql(), $invitationId, $ctx->workspaceId]
        );
        if ($n !== 1) {
            throw HttpException::notFound();
        }
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'member.invitation_revoked', 'invitation', $invitationId);
    }

    /** Looks up a pending invitation by token (no side effects). */
    public function findInvitation(string $token): ?array
    {
        if ($token === '' || strlen($token) > 128) {
            return null;
        }
        return $this->app->db()->one(
            "SELECT i.*, w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id
              WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? AND w.status = 'active'",
            [Tokens::hash($token), $this->app->clock->sql()]
        );
    }

    /** Accepts an invitation for a signed-in user whose email matches the invitation. */
    public function acceptInvitation(string $token, array $user): int
    {
        $db = $this->app->db();
        return $db->transaction(function () use ($db, $token, $user): int {
            $inv = $this->findInvitation($token);
            if ($inv === null) {
                throw HttpException::badRequest('This invitation is invalid or has expired.');
            }
            if (strtolower($inv['email']) !== strtolower($user['email'])) {
                throw HttpException::forbidden('This invitation was sent to a different email address. Sign in with that address to accept it.');
            }
            $now = $this->app->clock->sql();
            $n = $db->exec('UPDATE workspace_invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL', [$now, $inv['id']]);
            if ($n !== 1) {
                throw HttpException::badRequest('This invitation is invalid or has expired.');
            }
            // Any other pending invitation for this address is now obsolete.
            $db->exec('UPDATE workspace_invitations SET revoked_at = ? WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL',
                [$now, $inv['workspace_id'], strtolower($inv['email'])]);
            $db->exec(
                "INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)
                 ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active', updated_at = VALUES(updated_at)",
                [$inv['workspace_id'], $user['id'], $inv['role'], $now, $now]
            );
            $this->app->get(AuditLog::class)->workspace((int) $inv['workspace_id'], (int) $user['id'], 'member.joined', 'user', (int) $user['id'], ['role' => $inv['role'], 'invitation_id' => (int) $inv['id']]);
            return (int) $inv['workspace_id'];
        });
    }

    public function changeRole(WorkspaceContext $ctx, int $memberId, string $role): void
    {
        $ctx->require('members.manage');
        if (!in_array($role, Roles::ASSIGNABLE, true)) {
            throw HttpException::validation(['role' => 'Invalid role.']);
        }
        $member = $this->member($ctx, $memberId);
        if ((int) $member['user_id'] === $ctx->primaryOwnerId) {
            throw HttpException::forbidden('The primary owner\'s role cannot be changed.');
        }
        $this->app->db()->exec('UPDATE workspace_members SET role = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [$role, $this->app->clock->sql(), $memberId, $ctx->workspaceId]);
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'member.role_changed', 'member', $memberId, ['old_role' => $member['role'], 'new_role' => $role, 'target_user_id' => (int) $member['user_id']]);
    }

    public function revokeMember(WorkspaceContext $ctx, int $memberId): void
    {
        $ctx->require('members.manage');
        $member = $this->member($ctx, $memberId);
        if ((int) $member['user_id'] === $ctx->primaryOwnerId) {
            throw HttpException::forbidden('The primary owner cannot be removed.');
        }
        $this->app->db()->exec("UPDATE workspace_members SET status = 'revoked', updated_at = ? WHERE id = ? AND workspace_id = ?", [$this->app->clock->sql(), $memberId, $ctx->workspaceId]);
        // A removed member must not be able to rejoin with an older, still-pending invitation.
        $this->app->db()->exec(
            'UPDATE workspace_invitations i JOIN users u ON u.email = i.email SET i.revoked_at = ?
              WHERE i.workspace_id = ? AND u.id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL',
            [$this->app->clock->sql(), $ctx->workspaceId, $member['user_id']]
        );
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'member.revoked', 'member', $memberId, ['target_user_id' => (int) $member['user_id']]);
    }

    public function supportGrants(WorkspaceContext $ctx): array
    {
        $ctx->require('workspace.manage');
        return $this->app->db()->all(
            'SELECT g.id, g.reason, g.created_at, g.expires_at, g.revoked_at, u.email AS granted_by
               FROM support_grants g LEFT JOIN users u ON u.id = g.granted_by_user_id
              WHERE g.workspace_id = ? ORDER BY g.created_at DESC LIMIT 20',
            [$ctx->workspaceId]
        );
    }

    public function grantSupport(WorkspaceContext $ctx, int $hours, string $reason): int
    {
        $ctx->require('workspace.manage');
        $max = (int) $this->app->get(PlatformSettings::class)->get('support_grant_max_hours');
        $hours = max(1, min($hours, $max));
        $id = $this->app->db()->insert('support_grants', [
            'workspace_id' => $ctx->workspaceId,
            'granted_by_user_id' => $ctx->userId,
            'reason' => $reason,
            'created_at' => $this->app->clock->sql(),
            'expires_at' => $this->app->clock->sql($hours * 3600),
        ]);
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'support.granted', 'support_grant', $id, ['expires_at' => $this->app->clock->sql($hours * 3600)]);
        return $id;
    }

    public function revokeSupport(WorkspaceContext $ctx, int $grantId): void
    {
        $ctx->require('workspace.manage');
        $n = $this->app->db()->exec(
            'UPDATE support_grants SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL',
            [$this->app->clock->sql(), $grantId, $ctx->workspaceId]
        );
        if ($n !== 1) {
            throw HttpException::notFound();
        }
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'support.revoked', 'support_grant', $grantId);
    }

    private function member(WorkspaceContext $ctx, int $memberId): array
    {
        $m = $this->app->db()->one('SELECT id, user_id, role, status FROM workspace_members WHERE id = ? AND workspace_id = ?', [$memberId, $ctx->workspaceId]);
        if ($m === null) {
            throw HttpException::notFound();
        }
        return $m;
    }
}
