<?php

declare(strict_types=1);

use Signalpost\Controllers\HealthController;
use Signalpost\Http\Router;

/*
 * Route table. The third argument is the guard (trust boundary):
 *   public      - no authentication
 *   guest       - optional session, CSRF (double-submit) on writes
 *   session     - dashboard user session required, CSRF on writes
 *   integration - WordPress server-to-server site credential
 *   widget      - public visitor widget, scoped to one website
 */
return static function (Router $r): void {
    $r->get('/api/v1/health', [HealthController::class, 'health']);
};
