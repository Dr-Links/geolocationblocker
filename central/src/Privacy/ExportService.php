<?php

declare(strict_types=1);

namespace Signalpost\Privacy;

use Signalpost\Audit\AuditLog;
use Signalpost\Core\App;
use Signalpost\Tenancy\WorkspaceContext;

/**
 * Workspace and visitor data export (JSON).
 *
 * Columns are listed explicitly: password hashes, session and visitor token
 * hashes, credential hashes, pairing codes and invitation tokens are never
 * exported. Large tables are streamed in pages so memory stays bounded.
 */
final class ExportService
{
    /** table => [columns, owning-workspace column]. */
    private const TABLES = [
        'websites' => 'id, name, canonical_origin, status, tracking_policy, plugin_version, platform_version, created_at, updated_at, last_activity_at, last_connected_at',
        'website_settings' => 'website_id, widget_config, tracking_config, retention_config, updated_at',
        'visitors' => 'id, public_id, website_id, first_seen_at, last_seen_at, visit_count, name, email, phone, consent_state, consent_policy_version, consent_updated_at, country_code, country_source, browser, os, last_page_path, last_page_at, created_at, updated_at',
        'visitor_contact_submissions' => 'id, website_id, visitor_id, name, email, phone, submitted_at',
        'conversations' => 'id, website_id, visitor_id, status, read_only, assigned_user_id, created_at, updated_at, closed_at, last_message_at',
        'messages' => 'id, conversation_id, sender_type, sender_user_id, body, created_at, delivered_at',
        'visitor_sessions' => 'id, website_id, visitor_id, started_at, last_activity_at, ended_at, page_views',
        'visitor_events' => 'id, website_id, visitor_id, session_id, event_type, page_path, page_title, referrer_origin, occurred_at',
        'consent_records' => 'id, website_id, visitor_id, category, decision, policy_version, source, recorded_at, withdrawn_at',
        'visitor_blocks' => 'id, website_id, visitor_id, blocked_by_user_id, reason, status, created_at, revoked_at, revoked_by_user_id',
        'audit_logs' => 'id, actor_user_id, actor_type, action, resource_type, resource_id, metadata, created_at',
    ];

    public function __construct(private readonly App $app)
    {
    }

    /** Streams the export as JSON to the output (echo). */
    public function streamWorkspace(WorkspaceContext $ctx): \Closure
    {
        $ctx->require('privacy.manage');
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'workspace.exported', 'workspace', $ctx->workspaceId, ['format' => 'json']);
        $db = $this->app->db();
        $wsId = $ctx->workspaceId;
        $generated = gmdate('Y-m-d\TH:i:s\Z', $this->app->clock->timestamp());
        return function () use ($db, $wsId, $generated): void {
            $enc = static fn ($v) => json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
            echo '{"format":"signalpost-export","version":1,"generated_at":', $enc($generated), ',';
            echo '"workspace":', $enc($db->one('SELECT id, name, status, created_at, updated_at FROM workspaces WHERE id = ?', [$wsId])), ',';
            echo '"members":', $enc($db->all('SELECT u.id AS user_id, u.email, u.display_name, m.role, m.status, m.created_at FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', [$wsId])), ',';
            $first = true;
            foreach (self::TABLES as $table => $columns) {
                echo $first ? '' : ',', $enc($table), ':[';
                $first = false;
                $lastId = 0;
                $sep = '';
                $hasId = str_starts_with($columns, 'id,');
                do {
                    $rows = $hasId
                        ? $db->all("SELECT {$columns} FROM {$table} WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT 500", [$wsId, $lastId])
                        : $db->all("SELECT {$columns} FROM {$table} WHERE workspace_id = ?", [$wsId]);
                    foreach ($rows as $row) {
                        echo $sep, $enc($row);
                        $sep = ',';
                        if ($hasId) {
                            $lastId = (int) $row['id'];
                        }
                    }
                    if (function_exists('flush')) {
                        @flush();
                    }
                } while ($hasId && count($rows) === 500);
                echo ']';
            }
            echo '}';
        };
    }

    /** Everything held about one visitor (for access requests). */
    public function visitor(WorkspaceContext $ctx, int $visitorId): array
    {
        $ctx->require('privacy.manage');
        $db = $this->app->db();
        $v = $db->one('SELECT ' . self::TABLES['visitors'] . ' FROM visitors WHERE id = ? AND workspace_id = ?', [$visitorId, $ctx->workspaceId]);
        if ($v === null) {
            throw \Signalpost\Core\HttpException::notFound();
        }
        $convIds = array_map('intval', array_column($db->all('SELECT id FROM conversations WHERE visitor_id = ? AND workspace_id = ?', [$visitorId, $ctx->workspaceId]), 'id'));
        $messages = $convIds === [] ? [] : $db->all(
            'SELECT conversation_id, sender_type, body, created_at FROM messages WHERE workspace_id = ? AND conversation_id IN (' . implode(',', $convIds) . ') ORDER BY id',
            [$ctx->workspaceId]
        );
        $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'visitor.exported', 'visitor', $v['public_id']);
        return [
            'format' => 'signalpost-visitor-export',
            'generated_at' => gmdate('Y-m-d\TH:i:s\Z', $this->app->clock->timestamp()),
            'visitor' => $v,
            'contact_submissions' => $db->all('SELECT name, email, phone, submitted_at FROM visitor_contact_submissions WHERE visitor_id = ? AND workspace_id = ?', [$visitorId, $ctx->workspaceId]),
            'conversations' => $db->all('SELECT id, status, created_at, closed_at FROM conversations WHERE visitor_id = ? AND workspace_id = ?', [$visitorId, $ctx->workspaceId]),
            'messages' => $messages,
            'page_views' => $db->all('SELECT page_path, page_title, referrer_origin, occurred_at FROM visitor_events WHERE visitor_id = ? AND workspace_id = ? ORDER BY id', [$visitorId, $ctx->workspaceId]),
            'sessions' => $db->all('SELECT started_at, last_activity_at, page_views FROM visitor_sessions WHERE visitor_id = ? AND workspace_id = ?', [$visitorId, $ctx->workspaceId]),
            'consent_records' => $db->all('SELECT category, decision, policy_version, source, recorded_at, withdrawn_at FROM consent_records WHERE visitor_id = ? AND workspace_id = ?', [$visitorId, $ctx->workspaceId]),
        ];
    }
}
