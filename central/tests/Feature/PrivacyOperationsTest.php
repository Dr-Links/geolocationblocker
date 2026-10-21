<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Core\Console;
use Signalpost\Privacy\RetentionService;
use Signalpost\Tests\Browser;
use Signalpost\Tests\TestCase;
use Signalpost\Tests\WidgetFixtures;

final class PrivacyOperationsTest extends TestCase
{
    use WidgetFixtures;

    private int $owner;
    private int $ws;
    private array $site;
    private Browser $op;

    protected function setUp(): void
    {
        parent::setUp();
        $this->owner = $this->makeUser('owner@example.com');
        $this->ws = $this->makeWorkspace($this->owner, 'Acme');
        $this->site = $this->connectedSite($this->ws, $this->owner);
        $this->op = $this->loginAs('owner@example.com');
    }

    private function n(string $table, string $where = '1=1', array $p = []): int
    {
        return (int) $this->app->db()->value("SELECT COUNT(*) FROM {$table} WHERE {$where}", $p);
    }

    /** Seeds a visitor with a conversation and analytics, aged $daysAgo. */
    private function seedVisitor(array $site, int $daysAgo, int $events = 3, bool $withConversation = true): int
    {
        $db = $this->app->db();
        $t = $this->app->clock->sql(-$daysAgo * 86400);
        $vid = $db->insert('visitors', ['public_id' => bin2hex(random_bytes(10)), 'workspace_id' => $site['workspace_id'], 'website_id' => $site['id'], 'token_hash' => bin2hex(random_bytes(32)),
            'token_issued_at' => $t, 'first_seen_at' => $t, 'last_seen_at' => $t, 'email' => "v{$daysAgo}@example.com", 'created_at' => $t, 'updated_at' => $t]);
        $sid = $db->insert('visitor_sessions', ['workspace_id' => $site['workspace_id'], 'website_id' => $site['id'], 'visitor_id' => $vid, 'started_at' => $t, 'last_activity_at' => $t]);
        for ($i = 0; $i < $events; $i++) {
            $db->insert('visitor_events', ['workspace_id' => $site['workspace_id'], 'website_id' => $site['id'], 'visitor_id' => $vid, 'session_id' => $sid, 'event_uid' => bin2hex(random_bytes(8)),
                'event_type' => 'page_view', 'page_path' => '/p' . $i, 'occurred_at' => $t, 'created_at' => $t]);
        }
        $db->insert('visitor_contact_submissions', ['workspace_id' => $site['workspace_id'], 'website_id' => $site['id'], 'visitor_id' => $vid, 'email' => "v{$daysAgo}@example.com", 'submitted_at' => $t]);
        $db->insert('consent_records', ['workspace_id' => $site['workspace_id'], 'website_id' => $site['id'], 'visitor_id' => $vid, 'category' => 'analytics', 'decision' => 'granted', 'policy_version' => '1', 'source' => 'widget', 'recorded_at' => $t]);
        if ($withConversation) {
            $cid = $db->insert('conversations', ['workspace_id' => $site['workspace_id'], 'website_id' => $site['id'], 'visitor_id' => $vid, 'created_at' => $t, 'updated_at' => $t, 'last_message_at' => $t]);
            $mid = $db->insert('messages', ['workspace_id' => $site['workspace_id'], 'conversation_id' => $cid, 'sender_type' => 'visitor', 'client_message_id' => bin2hex(random_bytes(6)), 'body' => "message from {$daysAgo} days ago", 'created_at' => $t]);
            $db->exec('UPDATE conversations SET last_message_id = ? WHERE id = ?', [$mid, $cid]);
        }
        return $vid;
    }

    public function testDryRunDoesNotDelete(): void
    {
        $this->seedVisitor($this->site, 400);
        $before = [$this->n('visitor_events'), $this->n('visitor_sessions'), $this->n('visitors'), $this->n('messages'), $this->n('consent_records')];
        $res = $this->op->submit("/w/{$this->ws}/privacy/cleanup", ['mode' => 'preview']);
        $this->assertSame(200, $res->status);
        $this->assertStringContainsString('Dry run', $res->body);
        $report = $this->app->get(RetentionService::class)->run(true);
        $this->assertTrue($report['dry_run']);
        $this->assertSame(3, $report['totals']['visitor_events']);
        $this->assertSame([$this->n('visitor_events'), $this->n('visitor_sessions'), $this->n('visitors'), $this->n('messages'), $this->n('consent_records')], $before);
    }

    public function testCleanupAppliesIndependentRetentionPerCategory(): void
    {
        $this->setSiteSettings($this->site, 'retention', ['events_days' => 30, 'sessions_days' => 30, 'contacts_days' => 60, 'conversations_days' => 365, 'visitor_inactive_days' => 90, 'consent_days' => 1095]);
        $old = $this->seedVisitor($this->site, 45);
        $fresh = $this->seedVisitor($this->site, 5);
        $report = $this->app->get(RetentionService::class)->run(false);
        $this->assertTrue($report['complete']);
        $this->assertSame(0, $this->n('visitor_events', 'visitor_id = ?', [$old]), 'old analytics removed');
        $this->assertSame(0, $this->n('visitor_sessions', 'visitor_id = ?', [$old]));
        $this->assertSame(1, $this->n('visitor_contact_submissions', 'visitor_id = ?', [$old]), 'contacts kept (60 days)');
        $this->assertSame(1, $this->n('messages', "body = 'message from 45 days ago'"), 'conversation retention is independent');
        $this->assertSame(1, $this->n('visitors', 'id = ?', [$old]));
        $this->assertSame(3, $this->n('visitor_events', 'visitor_id = ?', [$fresh]), 'recent data untouched');
    }

    public function testInactiveVisitorsRemovedOnlyAfterTheirConversations(): void
    {
        $this->setSiteSettings($this->site, 'retention', ['visitor_inactive_days' => 30, 'conversations_days' => 0]);
        $withConv = $this->seedVisitor($this->site, 100, 1, true);
        $noConv = $this->seedVisitor($this->site, 100, 1, false);
        $this->app->get(RetentionService::class)->run(false);
        $this->assertSame(1, $this->n('visitors', 'id = ?', [$withConv]), 'conversations kept forever keep their visitor');
        $this->assertSame(0, $this->n('visitors', 'id = ?', [$noConv]));
        $this->assertSame(1, $this->n('messages'));

        $this->setSiteSettings($this->site, 'retention', ['conversations_days' => 50]);
        $this->app->get(RetentionService::class)->run(false);
        $this->assertSame(0, $this->n('messages'));
        $this->assertSame(0, $this->n('visitors'));
        $this->assertSame(2, $this->n('consent_records', 'visitor_id IS NULL'), 'consent records are detached and follow their own retention');
    }

    public function testCleanupRunsInBoundedBatches(): void
    {
        // Keep the profile so only the event category is exercised.
        $this->setSiteSettings($this->site, 'retention', ['visitor_inactive_days' => 3650]);
        $this->seedVisitor($this->site, 400, 50, false);
        $first = $this->app->get(RetentionService::class)->run(false, null, 2);
        $this->assertFalse($first['complete'], 'capped run reports remaining work');
        $this->assertSame(2 * RetentionService::MAX_BATCHES_PER_CATEGORY, $first['totals']['visitor_events']);
        $this->assertSame(10, $this->n('visitor_events'));
        $second = $this->app->get(RetentionService::class)->run(false, null, 2);
        $this->assertSame(10, $second['totals']['visitor_events']);
        $this->assertSame(0, $this->n('visitor_events'));
    }

    public function testWorkspaceCleanupDoesNotTouchOtherWorkspaces(): void
    {
        $other = $this->makeUser('other@example.com');
        $ows = $this->makeWorkspace($other, 'Other');
        $osite = $this->connectedSite($ows, $other, 'https://other.example.com', 'Other site');
        $this->seedVisitor($this->site, 400);
        $this->seedVisitor($osite, 400);
        $res = $this->op->submit("/w/{$this->ws}/privacy/cleanup", ['mode' => 'run']);
        $this->assertSame(200, $res->status);
        $this->assertSame(0, $this->n('visitor_events', 'workspace_id = ?', [$this->ws]));
        $this->assertSame(3, $this->n('visitor_events', 'workspace_id = ?', [$ows]));
        $this->assertSame(1, $this->n('audit_logs', "action = 'retention.cleanup' AND workspace_id = ?", [$this->ws]));
    }

    public function testPlatformCleanupRemovesOldSecurityRecords(): void
    {
        $db = $this->app->db();
        $db->insert('security_events', ['event_type' => 'login_failed', 'ip_masked' => '1.2.3.0/24', 'created_at' => $this->app->clock->sql(-40 * 86400)]);
        $db->insert('security_events', ['event_type' => 'login_failed', 'ip_masked' => '1.2.3.0/24', 'created_at' => $this->app->clock->sql(-1 * 86400)]);
        $report = $this->app->get(RetentionService::class)->run(false);
        $this->assertSame(1, $report['totals']['security_events']);
        $this->assertSame(1, $this->n('security_events'));
    }

    public function testExportContainsWorkspaceDataButNoSecretsOrOtherTenants(): void
    {
        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'Exported message');
        $this->app->db()->insert('site_credentials', ['website_id' => $this->site['id'], 'key_prefix' => 'abcdefabcdef', 'secret_hash' => str_repeat('f', 64), 'created_at' => $this->app->clock->sql()]);
        $other = $this->makeUser('other@example.com');
        $ows = $this->makeWorkspace($other, 'Other');
        $osite = $this->connectedSite($ows, $other, 'https://other.example.com', 'Other site');
        [$ot] = $this->newVisitor($osite);
        $this->visitorSend($osite, $ot, 'Other tenant message');

        $res = $this->op->submit("/w/{$this->ws}/privacy/export");
        $this->assertSame(200, $res->status);
        $this->assertStringContainsString('attachment;', $res->headers['Content-Disposition']);
        $data = json_decode($res->body, true);
        $this->assertIsArray($data, 'valid JSON');
        $this->assertSame('Acme', $data['workspace']['name']);
        $this->assertSame('Exported message', $data['messages'][0]['body']);
        $this->assertCount(1, $data['visitors']);
        foreach (['password_hash', 'token_hash', 'secret_hash', 'csrf_token', 'code_hash', str_repeat('f', 64), 'Other tenant message', $token] as $needle) {
            $this->assertStringNotContainsString($needle, $res->body, $needle);
        }
        $this->assertSame(1, $this->n('audit_logs', "action = 'workspace.exported'"));
    }

    public function testVisitorExportContainsOnlyThatVisitor(): void
    {
        [$a] = $this->newVisitor($this->site);
        [$b] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $a, 'Alice data');
        $this->visitorSend($this->site, $b, 'Bob data');
        $vid = (int) $this->visitorRow($a)['id'];
        $res = $this->op->submit("/w/{$this->ws}/visitors/{$vid}/export");
        $this->assertSame(200, $res->status);
        $this->assertStringContainsString('Alice data', $res->body);
        $this->assertStringNotContainsString('Bob data', $res->body);
        $this->assertStringNotContainsString('token_hash', $res->body);
    }

    public function testUnauthorisedExportsAndDeletionsAreRejected(): void
    {
        $agent = $this->makeUser('agent@example.com');
        $this->addMember($this->ws, $agent);
        $a = $this->loginAs('agent@example.com');
        $this->assertSame(403, $a->get("/w/{$this->ws}/privacy")->status);
        $this->assertSame(403, $a->submit("/w/{$this->ws}/privacy/export")->status);
        $this->assertSame(403, $a->submit("/w/{$this->ws}/privacy/cleanup", ['mode' => 'run'])->status);
        $this->assertSame(403, $a->submit("/w/{$this->ws}/privacy/delete-workspace", ['confirm_name' => 'Acme', 'password' => self::PASSWORD])->status);

        $mallory = $this->makeUser('mallory@example.com');
        $mws = $this->makeWorkspace($mallory, 'Mallory');
        $m = $this->loginAs('mallory@example.com');
        $this->assertSame(404, $m->submit("/w/{$this->ws}/privacy/export")->status);
        $this->assertSame(404, $m->submit("/w/{$this->ws}/privacy/delete-workspace", ['confirm_name' => 'Acme', 'password' => self::PASSWORD])->status);
        [$token] = $this->newVisitor($this->site);
        $vid = (int) $this->visitorRow($token)['id'];
        $this->assertSame(404, $m->submit("/w/{$mws}/visitors/{$vid}/export")->status);

        // Co-owner (not primary) cannot delete the workspace.
        $co = $this->makeUser('co@example.com');
        $this->addMember($this->ws, $co, 'owner');
        $this->assertSame(403, $this->loginAs('co@example.com')->submit("/w/{$this->ws}/privacy/delete-workspace", ['confirm_name' => 'Acme', 'password' => self::PASSWORD])->status);
        $this->assertSame(1, $this->n('workspaces', 'id = ?', [$this->ws]));
    }

    public function testWorkspaceDeletionRequiresConfirmationAndIsIsolated(): void
    {
        $other = $this->makeUser('other@example.com');
        $ows = $this->makeWorkspace($other, 'Other');
        $osite = $this->connectedSite($ows, $other, 'https://other.example.com', 'Other site');
        $this->seedVisitor($this->site, 1);
        $this->seedVisitor($osite, 1);
        $otherCounts = fn () => [$this->n('websites', 'workspace_id = ?', [$ows]), $this->n('visitors', 'workspace_id = ?', [$ows]), $this->n('messages', 'workspace_id = ?', [$ows]), $this->n('visitor_events', 'workspace_id = ?', [$ows])];
        $before = $otherCounts();

        $this->assertSame(422, $this->op->submit("/w/{$this->ws}/privacy/delete-workspace", ['confirm_name' => 'acme', 'password' => self::PASSWORD])->status);
        $this->assertSame(422, $this->op->submit("/w/{$this->ws}/privacy/delete-workspace", ['confirm_name' => 'Acme', 'password' => 'wrong-password'])->status);
        $this->assertSame(1, $this->n('workspaces', 'id = ?', [$this->ws]));

        $res = $this->op->submit("/w/{$this->ws}/privacy/delete-workspace", ['confirm_name' => 'Acme', 'password' => self::PASSWORD]);
        $this->assertSame(303, $res->status);
        $this->assertSame(0, $this->n('workspaces', 'id = ?', [$this->ws]));
        foreach (['websites', 'visitors', 'conversations', 'messages', 'visitor_events', 'visitor_sessions', 'consent_records', 'workspace_members', 'website_settings'] as $t) {
            $this->assertSame(0, $this->n($t, 'workspace_id = ?', [$this->ws]), $t);
        }
        $this->assertSame($before, $otherCounts(), 'other workspace untouched');
        $this->assertSame(1, $this->n('audit_logs', "scope = 'platform' AND action = 'workspace.deleted'"));
        $this->assertSame(1, $this->n('users', 'id = ?', [$this->owner]), 'the account itself remains');
        // The deleted site's widget stops working.
        $this->assertSame(404, $this->widget($this->site, 'POST', '/session', null, [])->status);
    }

    public function testCronCommandRecordsRunAndCleanupCommandSupportsDryRun(): void
    {
        $this->seedVisitor($this->site, 400);
        @mkdir($this->storage . '/cache', 0777, true);
        $console = new Console($this->app);
        ob_start();
        $code = $console->run(['cleanup', '--dry-run']);
        $out = (string) ob_get_clean();
        $this->assertSame(0, $code);
        $this->assertStringContainsString('Dry run', $out);
        $this->assertSame(3, $this->n('visitor_events'));
        ob_start();
        $code = $console->run(['cron:run']);
        ob_end_clean();
        $this->assertSame(0, $code);
        $this->assertSame(0, $this->n('visitor_events'));
        $this->assertNotNull($this->app->get(\Signalpost\Admin\PlatformSettings::class)->getState('last_cron_run'));
    }
}
