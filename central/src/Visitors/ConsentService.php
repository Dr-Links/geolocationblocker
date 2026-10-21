<?php

declare(strict_types=1);

namespace Signalpost\Visitors;

use Signalpost\Core\App;

/**
 * Consent states: unknown | essential | analytics | withdrawn.
 *
 * Optional analytics are permitted only when the website's policy enables
 * them AND, for the consent basis, the visitor opted in under the current
 * policy version. Anything else (including missing data) means "not permitted".
 */
final class ConsentService
{
    public function __construct(private readonly App $app)
    {
    }

    public static function analyticsPermitted(array $tracking, ?array $visitor): bool
    {
        if (empty($tracking['analytics_enabled']) || $visitor === null) {
            return false;
        }
        $state = (string) ($visitor['consent_state'] ?? 'unknown');
        if (($tracking['legal_basis'] ?? 'consent') === 'consent') {
            return $state === 'analytics'
                && (string) ($visitor['consent_policy_version'] ?? '') === (string) ($tracking['policy_version'] ?? '');
        }
        if (($tracking['legal_basis'] ?? '') === 'other') {
            // Objection-based: collect unless the visitor declined or withdrew.
            return !in_array($state, ['withdrawn', 'essential'], true);
        }
        return false;
    }

    /** Whether the widget should ask the visitor. */
    public static function needsPrompt(array $tracking, ?array $visitor): bool
    {
        if (empty($tracking['analytics_enabled']) || ($tracking['legal_basis'] ?? 'consent') !== 'consent') {
            return false;
        }
        if ($visitor === null) {
            return true;
        }
        return in_array($visitor['consent_state'], ['unknown'], true)
            || ($visitor['consent_state'] === 'analytics' && (string) $visitor['consent_policy_version'] !== (string) $tracking['policy_version']);
    }

    /**
     * Records a decision. Returns the new consent state.
     * Withdrawal immediately stops collection and erases this visitor's analytics data.
     */
    public function record(array $site, array $visitor, array $tracking, bool $analytics, string $source): string
    {
        $previous = (string) $visitor['consent_state'];
        $policy = (string) $tracking['policy_version'];
        $now = $this->app->clock->sql();
        if ($analytics) {
            $state = 'analytics';
            $decision = 'granted';
        } elseif ($previous === 'analytics' || ($tracking['legal_basis'] === 'other' && $previous !== 'withdrawn')) {
            $state = 'withdrawn';
            $decision = 'withdrawn';
        } else {
            $state = $previous === 'withdrawn' ? 'withdrawn' : 'essential';
            $decision = 'denied';
        }
        $db = $this->app->db();
        $db->transaction(function () use ($db, $site, $visitor, $state, $decision, $policy, $source, $now): void {
            if ($decision === 'withdrawn') {
                $db->exec("UPDATE consent_records SET withdrawn_at = ? WHERE visitor_id = ? AND decision = 'granted' AND withdrawn_at IS NULL", [$now, $visitor['id']]);
                $this->eraseAnalytics((int) $visitor['id']);
            }
            $db->insert('consent_records', [
                'workspace_id' => $site['workspace_id'],
                'website_id' => $site['id'],
                'visitor_id' => $visitor['id'],
                'category' => 'analytics',
                'decision' => $decision,
                'policy_version' => $policy,
                'source' => $source,
                'recorded_at' => $now,
            ]);
            $db->exec('UPDATE visitors SET consent_state = ?, consent_policy_version = ?, consent_updated_at = ?, updated_at = ? WHERE id = ?',
                [$state, $policy, $now, $now, $visitor['id']]);
        });
        return $state;
    }

    /** Removes optional analytics data and observed attributes for one visitor. */
    public function eraseAnalytics(int $visitorId): void
    {
        $db = $this->app->db();
        $db->exec('DELETE FROM visitor_events WHERE visitor_id = ?', [$visitorId]);
        $db->exec('DELETE FROM visitor_sessions WHERE visitor_id = ?', [$visitorId]);
        $db->exec('UPDATE visitors SET visit_count = 0, last_page_path = NULL, last_page_at = NULL, browser = NULL, os = NULL,
                          country_code = NULL, country_source = NULL WHERE id = ?', [$visitorId]);
    }
}
