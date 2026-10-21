<?php

declare(strict_types=1);

namespace Signalpost\Tenancy;

/**
 * Role-based access control. Extend by adding roles or permissions here;
 * every protected operation checks a permission, never a role name directly.
 */
final class Roles
{
    public const OWNER = 'owner';
    public const AGENT = 'agent';
    /** Platform administrator acting under an explicit, time-limited support grant. */
    public const SUPPORT = 'support';

    public const ASSIGNABLE = [self::OWNER, self::AGENT];

    private const PERMISSIONS = [
        self::OWNER => ['*'],
        self::AGENT => [
            'workspace.view',
            'conversations.read', 'conversations.reply', 'conversations.update',
            'visitors.read', 'visitors.block',
            'websites.read',
        ],
        self::SUPPORT => [
            'workspace.view', 'conversations.read', 'visitors.read', 'websites.read', 'audit.read',
        ],
    ];

    public static function allows(string $role, string $permission): bool
    {
        $perms = self::PERMISSIONS[$role] ?? [];
        return in_array('*', $perms, true) || in_array($permission, $perms, true);
    }

    public static function label(string $role): string
    {
        return match ($role) {
            self::OWNER => 'Owner',
            self::AGENT => 'Agent',
            self::SUPPORT => 'Platform support (read-only)',
            default => 'Unknown',
        };
    }
}
