<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Tests\Browser;
use Signalpost\Tests\TestCase;
use Signalpost\Tests\WidgetFixtures;

final class BlockingTest extends TestCase
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
        $this->ws = $this->makeWorkspace($this->owner);
        $this->site = $this->connectedSite($this->ws, $this->owner);
        $this->op = $this->loginAs('owner@example.com');
    }

    private function blockedVisitor(string $policy = 'read_only'): array
    {
        $this->setSiteSettings($this->site, 'widget', ['block_conversation_action' => $policy]);
        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'abusive message');
        $vid = (int) $this->visitorRow($token)['id'];
        $res = $this->op->submit("/w/{$this->ws}/visitors/{$vid}/block", ['reason' => 'Spam links']);
        $this->assertSame(303, $res->status);
        return [$token, $vid];
    }

    public function testOperatorCanBlockAndUnblockWithAuditTrail(): void
    {
        [$token, $vid] = $this->blockedVisitor();
        $block = $this->app->db()->one('SELECT * FROM visitor_blocks');
        $this->assertSame('active', $block['status']);
        $this->assertSame('Spam links', $block['reason']);
        $this->assertSame($this->owner, (int) $block['blocked_by_user_id']);
        $this->assertNotNull($block['created_at']);
        $page = $this->op->get("/w/{$this->ws}/visitors/{$vid}")->body;
        $this->assertStringContainsString('Blocked', $page);
        $this->assertStringContainsString('owner@example.com', $page);
        $this->assertStringContainsString('Spam links', $page);
        $this->assertStringContainsString('Spam links', $this->op->get("/w/{$this->ws}/blocks")->body);

        $this->assertSame(303, $this->op->submit("/w/{$this->ws}/visitors/{$vid}/unblock")->status);
        $block = $this->app->db()->one('SELECT * FROM visitor_blocks');
        $this->assertSame('revoked', $block['status']);
        $this->assertSame($this->owner, (int) $block['revoked_by_user_id']);
        $this->assertNotNull($block['revoked_at']);
        $this->assertSame(201, $this->visitorSend($this->site, $token, 'I am back')->status);

        $actions = array_column($this->app->db()->all('SELECT action, metadata FROM audit_logs WHERE action LIKE ?', ['visitor.%']), 'metadata', 'action');
        $this->assertArrayHasKey('visitor.blocked', $actions);
        $this->assertArrayHasKey('visitor.unblocked', $actions);
        $this->assertStringNotContainsString('Spam links', json_encode($actions), 'reason stays in the block record, not the audit log');
    }

    public function testBlockedVisitorCannotMessageOrStartConversations(): void
    {
        [$token] = $this->blockedVisitor();
        $res = $this->visitorSend($this->site, $token, 'let me in');
        $this->assertSame(403, $res->status);
        $this->assertSame('chat_unavailable', json_decode($res->body, true)['error']['code']);
        $this->assertStringNotContainsStringIgnoringCase('block', $res->body, 'generic denial, no moderation details');
        $this->assertStringNotContainsString('Spam', $res->body);

        // Even after the conversation would normally be closed and a new one started.
        $conv = (int) $this->app->db()->value('SELECT id FROM conversations');
        $this->op->api('POST', "/api/v1/dashboard/w/{$this->ws}/conversations/{$conv}/status", ['status' => 'closed']);
        $this->app->clock->advance(48 * 3600);
        $this->op = $this->loginAs('owner@example.com');
        $this->assertSame(403, $this->visitorSend($this->site, $token, 'new conversation?')->status);
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM conversations'));
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM messages'));

        $session = $this->widget($this->site, 'POST', '/session', $token, [])->data();
        $this->assertFalse($session['chat']['available']);
        $this->assertSame(403, $this->widget($this->site, 'POST', '/contact', $token, ['name' => 'x'])->status);
        // Blocked visitors cannot keep writing consent or analytics either.
        $this->setSiteSettings($this->site, 'tracking', ['analytics_enabled' => true]);
        $this->assertSame(403, $this->widget($this->site, 'POST', '/consent', $token, ['analytics' => true])->status);
        $this->assertSame(403, $this->widget($this->site, 'POST', '/events', $token, ['events' => []])->status);
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM consent_records'));
        // JavaScript cannot bypass enforcement: a direct API call with a fresh client ID is refused too.
        $this->assertSame(403, $this->widget($this->site, 'POST', '/messages', $token, ['client_message_id' => 'direct-api-call-1', 'body' => 'bypass'])->status);
    }

    public function testBlockPolicyReadOnlyVersusClose(): void
    {
        [, $vid] = $this->blockedVisitor('read_only');
        $conv = $this->app->db()->one('SELECT status, read_only FROM conversations WHERE visitor_id = ?', [$vid]);
        $this->assertSame('open', $conv['status']);
        $this->assertSame(1, (int) $conv['read_only']);

        [, $vid2] = $this->blockedVisitor('close');
        $conv2 = $this->app->db()->one('SELECT status, read_only FROM conversations WHERE visitor_id = ?', [$vid2]);
        $this->assertSame('closed', $conv2['status']);
    }

    public function testBlocksAreScopedToWebsiteAndWorkspace(): void
    {
        [$token, $vid] = $this->blockedVisitor();
        // The same browser on another website of the workspace has a separate identity and is unaffected.
        $other = $this->connectedSite($this->ws, $this->owner, 'https://blog.example.com', 'Blog');
        [$otherToken] = $this->newVisitor($other);
        $this->assertSame(201, $this->visitorSend($other, $otherToken, 'hello blog')->status);

        // A user from another workspace cannot block/unblock or see this visitor.
        $mallory = $this->makeUser('mallory@example.com');
        $mws = $this->makeWorkspace($mallory);
        $m = $this->loginAs('mallory@example.com');
        $this->assertSame(404, $m->submit("/w/{$mws}/visitors/{$vid}/unblock")->status);
        $this->assertSame(404, $m->submit("/w/{$mws}/visitors/{$vid}/block", ['reason' => 'x'])->status);
        $this->assertSame(404, $m->get("/w/{$mws}/visitors/{$vid}")->status);
        $this->assertSame(404, $m->get("/w/{$this->ws}/visitors/{$vid}")->status);
        $this->assertSame('active', $this->app->db()->value('SELECT status FROM visitor_blocks'));
        $this->assertStringNotContainsString('Spam', $m->get("/w/{$mws}/blocks")->body);
    }

    public function testAgentCanBlockButSupportCannot(): void
    {
        [$token] = $this->newVisitor($this->site);
        $vid = (int) $this->visitorRow($token)['id'];
        $agent = $this->makeUser('agent@example.com');
        $this->addMember($this->ws, $agent);
        $a = $this->loginAs('agent@example.com');
        $this->assertSame(303, $a->submit("/w/{$this->ws}/visitors/{$vid}/block")->status);
        $this->assertSame(303, $a->submit("/w/{$this->ws}/visitors/{$vid}/unblock")->status);

        $this->makeUser('root@example.com', true);
        $this->op->submit("/w/{$this->ws}/support-grants", ['hours' => 1, 'reason' => 'debug']);
        $root = $this->loginAs('root@example.com');
        $this->assertSame(200, $root->get("/w/{$this->ws}/visitors/{$vid}")->status);
        $this->assertSame(403, $root->submit("/w/{$this->ws}/visitors/{$vid}/block")->status);
        $this->assertSame(403, $root->submit("/w/{$this->ws}/visitors/{$vid}/delete")->status);
    }

    public function testNoIpBasedBlockingExists(): void
    {
        $this->blockedVisitor();
        $columns = array_column($this->app->db()->all('SHOW COLUMNS FROM visitor_blocks'), 'Field');
        foreach ($columns as $c) {
            $this->assertStringNotContainsStringIgnoringCase('ip', $c);
        }
        // Another visitor from the very same IP address can chat normally.
        [$fresh] = $this->newVisitor($this->site);
        $this->assertSame(201, $this->visitorSend($this->site, $fresh, 'same network, different visitor')->status);
    }

    public function testClearingStorageLimitationIsDocumented(): void
    {
        $doc = (string) @file_get_contents(dirname(__DIR__, 3) . '/docs/PRIVACY.md');
        $this->assertStringContainsString('clears browser storage', $doc, 'docs/PRIVACY.md must explain the visitor-ID blocking limitation');
        $page = $this->op->get("/w/{$this->ws}/blocks")->body;
        $this->assertStringContainsString('Clearing browser storage', $page);
    }

    public function testVisitorDeletionRemovesDependentDataButKeepsDetachedConsent(): void
    {
        $this->setSiteSettings($this->site, 'tracking', ['analytics_enabled' => true]);
        [$token] = $this->newVisitor($this->site);
        $this->widget($this->site, 'POST', '/consent', $token, ['analytics' => true]);
        $this->widget($this->site, 'POST', '/events', $token, ['events' => [['type' => 'page_view', 'uid' => 'abcdefabcdefabcd', 'path' => '/x']]]);
        $this->visitorSend($this->site, $token, 'delete me');
        $vid = (int) $this->visitorRow($token)['id'];
        $agent = $this->makeUser('agent@example.com');
        $this->addMember($this->ws, $agent);
        $this->assertSame(403, $this->loginAs('agent@example.com')->submit("/w/{$this->ws}/visitors/{$vid}/delete")->status, 'owner-only');
        $this->assertSame(303, $this->op->submit("/w/{$this->ws}/visitors/{$vid}/delete")->status);
        foreach (['visitors', 'conversations', 'messages', 'visitor_events', 'visitor_sessions'] as $t) {
            $this->assertSame(0, (int) $this->app->db()->value("SELECT COUNT(*) FROM {$t}"), $t);
        }
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM consent_records WHERE visitor_id IS NULL'));
        $this->assertSame(401, $this->widget($this->site, 'GET', '/messages', $token)->status);
    }
}
