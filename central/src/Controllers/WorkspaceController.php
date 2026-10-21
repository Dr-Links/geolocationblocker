<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Core\Validator;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Tenancy\WorkspaceService;

final class WorkspaceController extends Controller
{
    public function overview(Request $request): Response
    {
        $ctx = $this->ctx($request);
        $db = $this->app->db();
        $ws = $ctx->workspaceId;
        $activeSince = $this->app->clock->sql(-$this->app->config->int('limits.active_visitor_seconds'));
        $stats = [
            'websites' => (int) $db->value('SELECT COUNT(*) FROM websites WHERE workspace_id = ?', [$ws]),
            'connected' => (int) $db->value("SELECT COUNT(*) FROM websites WHERE workspace_id = ? AND status = 'connected'", [$ws]),
            'open' => (int) $db->value("SELECT COUNT(*) FROM conversations WHERE workspace_id = ? AND status = 'open'", [$ws]),
            'pending' => (int) $db->value("SELECT COUNT(*) FROM conversations WHERE workspace_id = ? AND status = 'pending'", [$ws]),
            'active_visitors' => (int) $db->value('SELECT COUNT(*) FROM visitors WHERE workspace_id = ? AND last_seen_at >= ?', [$ws, $activeSince]),
            'messages_today' => (int) $db->value('SELECT COUNT(*) FROM messages WHERE workspace_id = ? AND created_at >= ?', [$ws, $this->app->clock->now()->format('Y-m-d 00:00:00')]),
        ];
        $recent = $ctx->can('conversations.read') ? $db->all(
            'SELECT c.id, c.status, c.last_message_at, v.public_id, v.name, s.name AS website_name
               FROM conversations c JOIN visitors v ON v.id = c.visitor_id JOIN websites s ON s.id = c.website_id
              WHERE c.workspace_id = ? ORDER BY c.last_message_id DESC LIMIT 6',
            [$ws]
        ) : [];
        $sites = $db->all('SELECT id, name, canonical_origin, status, tracking_policy, last_connected_at FROM websites WHERE workspace_id = ? ORDER BY name', [$ws]);
        return $this->page($request, 'overview', ['title' => 'Overview', 'stats' => $stats, 'recent' => $recent, 'sites' => $sites]);
    }

    public function settings(Request $request): Response
    {
        $ctx = $this->ctx($request, 'workspace.manage');
        return $this->page($request, 'workspace_settings', ['title' => 'Workspace settings', 'errors' => []]);
    }

    public function rename(Request $request): Response
    {
        $ctx = $this->ctx($request, 'workspace.manage');
        return $this->withErrors(function () use ($request, $ctx) {
            $data = Validator::of($request->allInput())->string('name', 2, 100)->check();
            $this->app->get(WorkspaceService::class)->rename($ctx, $data['name']);
            return Response::redirect("/w/{$ctx->workspaceId}/settings?ok=saved");
        }, fn ($e, $s) => $this->page($request, 'workspace_settings', ['title' => 'Workspace settings', 'errors' => $e], 'layout_app', $s));
    }

    public function audit(Request $request): Response
    {
        $ctx = $this->ctx($request, 'audit.read');
        $before = $request->queryInt('before', PHP_INT_MAX, 1);
        $rows = $this->app->db()->all(
            'SELECT a.id, a.action, a.resource_type, a.resource_id, a.metadata, a.actor_type, a.created_at, u.email AS actor_email
               FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
              WHERE a.workspace_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT 100',
            [$ctx->workspaceId, $before]
        );
        return $this->page($request, 'audit', ['title' => 'Audit history', 'rows' => $rows]);
    }
}
