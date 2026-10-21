<?php

declare(strict_types=1);

namespace Signalpost\Visitors;

use Signalpost\Core\App;
use Signalpost\Http\Request;
use Signalpost\Security\UserAgent;
use Signalpost\Sites\Origin;
use Signalpost\Sites\SettingsSchema;

/**
 * Optional page-view analytics.
 *
 * Visit (session) rule: a visit is a run of eligible activity with gaps no
 * longer than the website's inactivity threshold (default 30 minutes).
 * The first eligible event after a longer gap starts a new visit and
 * increments the visitor's visit count. Chat polling never counts.
 */
final class TrackingService
{
    public function __construct(private readonly App $app)
    {
    }

    /** Strips query string and fragment, decodes and bounds the path. Returns null if unusable. */
    public static function sanitizePath(mixed $path): ?string
    {
        if (!is_string($path) || $path === '') {
            return null;
        }
        $path = preg_replace('/[?#].*$/s', '', $path) ?? '';
        $path = rawurldecode($path);
        $path = (string) preg_replace('/[\x00-\x1F\x7F]/u', '', $path);
        if (!mb_check_encoding($path, 'UTF-8') || $path === '' || $path[0] !== '/' || str_starts_with($path, '//')) {
            return null;
        }
        return mb_substr($path, 0, 512);
    }

    public static function sanitizeTitle(mixed $title): ?string
    {
        if (!is_string($title)) {
            return null;
        }
        $title = trim((string) preg_replace('/[\x00-\x1F\x7F]/u', ' ', $title));
        if ($title === '' || !mb_check_encoding($title, 'UTF-8')) {
            return null;
        }
        return mb_substr($title, 0, 200);
    }

    /** Referrer reduced to its origin; same-site referrers are dropped. */
    public static function sanitizeReferrer(mixed $referrer, string $siteOrigin): ?string
    {
        if (!is_string($referrer) || $referrer === '' || strlen($referrer) > 2048) {
            return null;
        }
        $origin = Origin::ofUrl($referrer, true);
        return $origin !== null && $origin !== $siteOrigin ? $origin : null;
    }

    /**
     * Ingests a bounded batch of events. Returns counts. Never stores anything
     * unless analytics are permitted for this visitor at this moment.
     *
     * @return array{accepted:bool,stored:int,skipped:int}
     */
    public function ingest(array $site, array $visitor, array $tracking, array $events, Request $request): array
    {
        if (!ConsentService::analyticsPermitted($tracking, $visitor)) {
            return ['accepted' => false, 'stored' => 0, 'skipped' => count($events)];
        }
        $max = $this->app->config->int('limits.events_per_batch');
        $events = array_slice($events, 0, $max);
        $db = $this->app->db();
        $now = $this->app->clock->timestamp();
        $stored = 0;
        $skipped = 0;
        foreach ($events as $event) {
            if (!is_array($event) || ($event['type'] ?? '') !== 'page_view' || !is_string($event['uid'] ?? null)
                || preg_match('/^[A-Za-z0-9]{16,32}$/', $event['uid']) !== 1) {
                $skipped++;
                continue;
            }
            $path = self::sanitizePath($event['path'] ?? null);
            if ($path === null || SettingsSchema::pathMatches($path, $tracking['excluded_paths'])) {
                $skipped++;
                continue;
            }
            // Client clocks are untrusted: accept up to 10 minutes in the past, never the future.
            $ts = is_int($event['ts'] ?? null) ? intdiv($event['ts'], 1000) : $now;
            $ts = max($now - 600, min($now, $ts));
            $occurred = gmdate('Y-m-d H:i:s', $ts);

            $sessionId = $this->sessionFor($site, $visitor, $tracking, $ts, $request);
            try {
                $db->insert('visitor_events', [
                    'workspace_id' => $site['workspace_id'],
                    'website_id' => $site['id'],
                    'visitor_id' => $visitor['id'],
                    'session_id' => $sessionId,
                    'event_uid' => substr($event['uid'], 0, 32),
                    'event_type' => 'page_view',
                    'page_path' => $path,
                    'page_title' => $tracking['record_page_titles'] ? self::sanitizeTitle($event['title'] ?? null) : null,
                    'referrer_origin' => $tracking['record_referrer'] ? self::sanitizeReferrer($event['referrer'] ?? null, $site['canonical_origin']) : null,
                    'occurred_at' => $occurred,
                    'created_at' => $this->app->clock->sql(),
                ]);
            } catch (\PDOException $e) {
                if ($db->isDuplicateKey($e)) {
                    $skipped++; // Retried batch: already stored.
                    continue;
                }
                throw $e;
            }
            $db->exec('UPDATE visitor_sessions SET page_views = page_views + 1 WHERE id = ?', [$sessionId]);
            $db->exec('UPDATE visitors SET last_page_path = ?, last_page_at = ?, last_seen_at = GREATEST(last_seen_at, ?) WHERE id = ?',
                [$path, $occurred, $occurred, $visitor['id']]);
            $stored++;
        }
        return ['accepted' => true, 'stored' => $stored, 'skipped' => $skipped];
    }

    private function sessionFor(array $site, array $visitor, array $tracking, int $ts, Request $request): int
    {
        $db = $this->app->db();
        $timeout = (int) $tracking['session_timeout_minutes'] * 60;
        $at = gmdate('Y-m-d H:i:s', $ts);
        $current = $db->one('SELECT id, last_activity_at FROM visitor_sessions WHERE visitor_id = ? ORDER BY last_activity_at DESC, id DESC LIMIT 1', [$visitor['id']]);
        if ($current !== null && strtotime($current['last_activity_at'] . ' UTC') >= $ts - $timeout) {
            $db->exec('UPDATE visitor_sessions SET last_activity_at = GREATEST(last_activity_at, ?) WHERE id = ?', [$at, $current['id']]);
            return (int) $current['id'];
        }
        $id = $db->insert('visitor_sessions', [
            'workspace_id' => $site['workspace_id'],
            'website_id' => $site['id'],
            'visitor_id' => $visitor['id'],
            'started_at' => $at,
            'last_activity_at' => $at,
            'page_views' => 0,
        ]);
        if ($current !== null) {
            $db->exec('UPDATE visitor_sessions SET ended_at = last_activity_at WHERE id = ? AND ended_at IS NULL', [$current['id']]);
        }
        $updates = ['visit_count = visit_count + 1'];
        $params = [];
        // Observed / inferred attributes are refreshed once per visit, only when enabled.
        if ($tracking['collect_browser']) {
            $ua = UserAgent::parse($request->header('user-agent'));
            $updates[] = 'browser = ?';
            $updates[] = 'os = ?';
            array_push($params, $ua['browser'], $ua['os']);
        }
        if ($tracking['estimate_country']) {
            $geo = $this->app->get(GeoService::class)->estimate($request);
            $updates[] = 'country_code = ?';
            $updates[] = 'country_source = ?';
            array_push($params, $geo['country'], $geo['source']);
        }
        $params[] = $visitor['id'];
        $db->exec('UPDATE visitors SET ' . implode(', ', $updates) . ' WHERE id = ?', $params);
        return $id;
    }
}
