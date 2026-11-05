<?php

declare(strict_types=1);

namespace Signalpost\Auth;

use Signalpost\Core\HttpException;

/** Signals that a signed-in user's access period has ended (redirects to /renew). */
final class AccessExpired extends HttpException
{
    public function __construct()
    {
        parent::__construct(403, 'access_expired', 'Your access has expired.');
    }
}
