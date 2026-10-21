<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Core\App;
use Signalpost\Http\Request;
use Signalpost\Http\Response;

final class HealthController
{
    public function __construct(private readonly App $app)
    {
    }

    /** Public liveness probe. Reveals no version or configuration details. */
    public function health(Request $request): Response
    {
        try {
            $this->app->db()->value('SELECT 1');
            $db = 'ok';
        } catch (\Throwable) {
            $db = 'unavailable';
        }
        return Response::json(['status' => $db === 'ok' ? 'ok' : 'degraded', 'database' => $db], $db === 'ok' ? 200 : 503);
    }
}
