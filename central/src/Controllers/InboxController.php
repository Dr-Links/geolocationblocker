<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Sites\WebsiteService;

/** HTML shells for the JavaScript-driven inbox and live visitor views. */
final class InboxController extends Controller
{
    public function inbox(Request $request): Response
    {
        $ctx = $this->ctx($request, 'conversations.read');
        return $this->page($request, 'inbox', [
            'title' => 'Inbox',
            'sites' => $this->app->get(WebsiteService::class)->list($ctx),
            'pollMs' => $this->app->config->int('polling.dashboard_ms'),
            'maxBackoffMs' => $this->app->config->int('polling.max_backoff_ms'),
            'maxChars' => $this->app->config->int('limits.message_max_chars'),
        ]);
    }

    public function live(Request $request): Response
    {
        $ctx = $this->ctx($request, 'visitors.read');
        return $this->page($request, 'live', [
            'title' => 'Live visitors',
            'sites' => $this->app->get(WebsiteService::class)->list($ctx),
            'pollMs' => max(5000, $this->app->config->int('polling.dashboard_ms')),
            'activeSeconds' => $this->app->config->int('limits.active_visitor_seconds'),
            'recentMinutes' => $this->app->config->int('limits.recent_visitor_minutes'),
        ]);
    }
}
