<?php

declare(strict_types=1);

namespace Signalpost\Privacy;

use Signalpost\Core\App;
use Signalpost\Sites\WebsiteService;

/**
 * Retention cleanup, run by cron (bin/console cron:run) or manually.
 *
 * - Per-website limits come from each website's validated retention settings.
 * - Deletion happens in bounded batches (DELETE ... LIMIT n) with a cap on
 *   batches per category per run, so a run never holds long locks on shared
 *   hosting; anything left over is removed by the next run.
 * - Dry-run mode only counts.
 * - Inactive visitor profiles are removed only when none of their
 *   conversations are still inside the conversation retention window.
 */
final class RetentionService
{
    public const MAX_BATCHES_PER_CATEGORY = 20;
    public const SECURITY_EVENTS_DAYS = 30;

    public function __construct(private readonly App $app)
    {
    }

    /**
     * @return array{dry_run:bool, totals:array<string,int>, complete:bool}
     */
    public function run(bool $dryRun, ?int $workspaceId = null, ?int $batchSize = null): array
    {
        $batch = max(1, min($batchSize ?? $this->app->config->int('limits.cleanup_batch_size'), 5000));
        $db = $this->app->db();
        $totals = [
            'visitor_events' => 0, 'visitor_sessions' => 0, 'contact_submissions' => 0,
            'conversations' => 0, 'visitors' => 0, 'consent_records' => 0,
        ];
        $complete = true;
        $sites = $workspaceId === null
            ? $db->all("SELECT w.id, w.workspace_id FROM websites w JOIN workspaces ws ON ws.id = w.workspace_id ORDER BY w.id")
            : $db->all('SELECT id, workspace_id FROM websites WHERE workspace_id = ? ORDER BY id', [$workspaceId]);
        $settings = $this->app->get(WebsiteService::class);
        foreach ($sites as $site) {
            $r = $settings->settings((int) $site['id'])['retention'];
            $sid = (int) $site['id'];
            $c = fn (int $days) => $this->app->clock->sql(-$days * 86400);

            $jobs = [
                'visitor_events' => ['visitor_events', 'website_id = ? AND occurred_at < ?', [$sid, $c($r['events_days'])]],
                'visitor_sessions' => ['visitor_sessions', 'website_id = ? AND last_activity_at < ?', [$sid, $c($r['sessions_days'])]],
                'contact_submissions' => ['visitor_contact_submissions', 'website_id = ? AND submitted_at < ?', [$sid, $c($r['contacts_days'])]],
                'consent_records' => ['consent_records', 'website_id = ? AND recorded_at < ?', [$sid, $c($r['consent_days'])]],
            ];
            if ($r['conversations_days'] > 0) {
                $jobs['conversations'] = ['conversations', 'website_id = ? AND COALESCE(last_message_at, created_at) < ?', [$sid, $c($r['conversations_days'])]];
            }
            // Visitors last: only once their conversations are gone (or none exist).
            $jobs['visitors'] = ['visitors', 'website_id = ? AND last_seen_at < ? AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.visitor_id = visitors.id)', [$sid, $c($r['visitor_inactive_days'])]];

            foreach ($jobs as $key => [$table, $where, $params]) {
                [$n, $done] = $this->purge($table, $where, $params, $dryRun, $batch);
                $totals[$key] += $n;
                $complete = $complete && $done;
            }
        }

        if ($workspaceId === null) {
            $platform = $this->purgePlatform($dryRun, $batch);
            $totals += $platform['totals'];
            $complete = $complete && $platform['complete'];
        }
        return ['dry_run' => $dryRun, 'totals' => $totals, 'complete' => $complete];
    }

    /** @return array{0:int,1:bool} [rows affected or counted, finished] */
    private function purge(string $table, string $where, array $params, bool $dryRun, int $batch): array
    {
        $db = $this->app->db();
        if ($dryRun) {
            return [(int) $db->value("SELECT COUNT(*) FROM {$table} WHERE {$where}", $params), true];
        }
        $total = 0;
        for ($i = 0; $i < self::MAX_BATCHES_PER_CATEGORY; $i++) {
            $n = $db->exec("DELETE FROM {$table} WHERE {$where} LIMIT {$batch}", $params);
            $total += $n;
            if ($n < $batch) {
                return [$total, true];
            }
        }
        return [$total, false];
    }

    /** Platform-level housekeeping: security records, expired sessions and tokens. */
    private function purgePlatform(bool $dryRun, int $batch): array
    {
        $jobs = [
            'security_events' => ['security_events', 'created_at < ?', [$this->app->clock->sql(-self::SECURITY_EVENTS_DAYS * 86400)]],
            'expired_sessions' => ['user_sessions', '(expires_at < ? OR revoked_at < ?)', [$this->app->clock->sql(-86400), $this->app->clock->sql(-30 * 86400)]],
            'expired_tokens' => ['user_tokens', 'expires_at < ?', [$this->app->clock->sql(-7 * 86400)]],
            'expired_pairing_codes' => ['pairing_codes', 'expires_at < ?', [$this->app->clock->sql(-7 * 86400)]],
            'expired_invitations' => ['workspace_invitations', 'expires_at < ?', [$this->app->clock->sql(-30 * 86400)]],
            'old_credentials' => ['site_credentials', 'revoked_at IS NOT NULL AND revoked_at < ?', [$this->app->clock->sql(-90 * 86400)]],
            'rate_limits' => ['rate_limits', 'expires_at < ?', [$this->app->clock->timestamp()]],
        ];
        $totals = [];
        $complete = true;
        foreach ($jobs as $key => [$table, $where, $params]) {
            [$n, $done] = $this->purge($table, $where, $params, $dryRun, $batch);
            $totals[$key] = $n;
            $complete = $complete && $done;
        }
        return ['totals' => $totals, 'complete' => $complete];
    }
}
