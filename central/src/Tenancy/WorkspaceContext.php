<?php

declare(strict_types=1);

namespace Signalpost\Tenancy;

use Signalpost\Core\HttpException;

/** The authorised (user, workspace, role) triple for one request. */
final class WorkspaceContext
{
    public function __construct(
        public readonly int $workspaceId,
        public readonly string $workspaceName,
        public readonly int $userId,
        public readonly string $role,
        public readonly int $primaryOwnerId,
    ) {
    }

    public function can(string $permission): bool
    {
        return Roles::allows($this->role, $permission);
    }

    public function require(string $permission): void
    {
        if (!$this->can($permission)) {
            throw HttpException::forbidden();
        }
    }

    public function isSupport(): bool
    {
        return $this->role === Roles::SUPPORT;
    }
}
