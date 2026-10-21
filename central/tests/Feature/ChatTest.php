<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Tests\Browser;
use Signalpost\Tests\TestCase;
use Signalpost\Tests\WidgetFixtures;

final class ChatTest extends TestCase
{
    use WidgetFixtures;

    private int $owner;
    private int $ws;
    private array $site;
    private Browser $op;

    protected function setUp(): void
    {
        parent::setUp();
        $this->owner = $this->makeUser('owner@example.com', false, 'active', 'Olivia');
        $this->ws = $this->makeWorkspace($this->owner);
        $this->site = $this->connectedSite($this->ws, $this->owner);
        $this->op = $this->loginAs('owner@example.com');
    }

    private function dash(string $method, string $path, ?array $json = null): \Signalpost\Http\Response
    {
        return $this->op->api($method, "/api/v1/dashboard/w/{$this->ws}" . $path, $json);
    }

    public function testVisitorCanStartConversationAndOperatorCanReply(): void
    {
        [$token, $state] = $this->newVisitor($this->site);
        $this->assertTrue($state['chat']['available']);
        $this->assertNull($state['chat']['conversation']);
        $this->assertSame([], $state['chat']['messages']);
        $this->assertArrayNotHasKey('token_hash', $state['visitor']);

        $sent = $this->visitorSend($this->site, $token, "Hello, I need help\nwith my order");
        $this->assertSame(201, $sent->status, $sent->body);
        $this->assertSame("Hello, I need help\nwith my order", $sent->data()['message']['body']);

        $list = $this->dash('GET', '/conversations')->data()['items'];
        $this->assertCount(1, $list);
        $this->assertTrue($list[0]['unread']);
        $this->assertSame('open', $list[0]['status']);
        $convId = $list[0]['id'];

        $detail = $this->dash('GET', "/conversations/{$convId}")->data();
        $this->assertSame('Hello, I need help' . "\n" . 'with my order', $detail['messages'][0]['body']);
        $this->assertSame($this->visitorRow($token)['public_id'], $detail['visitor']['public_id']);

        $reply = $this->dash('POST', "/conversations/{$convId}/messages", ['client_message_id' => 'op-msg-0001', 'body' => 'Happy to help!']);
        $this->assertSame(201, $reply->status, $reply->body);

        // Visitor polls incrementally from their last seen message.
        $lastId = $sent->data()['message']['id'];
        $poll = $this->widget($this->site, 'GET', '/messages?after=' . $lastId, $token)->data();
        $this->assertCount(1, $poll['messages']);
        $this->assertSame('operator', $poll['messages'][0]['sender']);
        $this->assertSame('Olivia', $poll['messages'][0]['author']);
        $this->assertSame('Happy to help!', $poll['messages'][0]['body']);
        $this->assertArrayNotHasKey('sender_user_id', $poll['messages'][0]);
        $this->assertNotNull($this->app->db()->value("SELECT delivered_at FROM messages WHERE sender_type = 'operator'"), 'delivery recorded');

        // Unread clears after operator reads.
        $this->assertFalse($this->dash('GET', '/conversations')->data()['items'][0]['unread']);
    }

    public function testMessagesPersistAcrossSessionsAndReload(): void
    {
        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'First message');
        // New page load: same token restores the conversation.
        $res = $this->widget($this->site, 'POST', '/session', $token, []);
        $data = $res->data();
        $this->assertNull($data['token'], 'no new token for a known visitor');
        $this->assertSame('First message', $data['chat']['messages'][0]['body']);
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM visitors'));
        // Fresh app instance (new request lifecycle) still sees it centrally.
        $this->app = $this->makeApp();
        $this->assertSame('First message', $this->app->db()->value('SELECT body FROM messages'));
    }

    public function testRetriesDoNotCreateDuplicates(): void
    {
        [$token] = $this->newVisitor($this->site);
        $a = $this->visitorSend($this->site, $token, 'Only once', 'client-retry-01');
        $b = $this->visitorSend($this->site, $token, 'Only once', 'client-retry-01');
        $this->assertSame(201, $a->status);
        $this->assertSame(200, $b->status);
        $this->assertTrue($b->data()['duplicate']);
        $this->assertSame($a->data()['message']['id'], $b->data()['message']['id']);
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM messages'));
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM conversations'));

        $conv = (int) $this->app->db()->value('SELECT id FROM conversations');
        $r1 = $this->dash('POST', "/conversations/{$conv}/messages", ['client_message_id' => 'op-retry-001', 'body' => 'Reply']);
        $r2 = $this->dash('POST', "/conversations/{$conv}/messages", ['client_message_id' => 'op-retry-001', 'body' => 'Reply']);
        $this->assertSame(201, $r1->status);
        $this->assertSame(200, $r2->status);
        $this->assertSame(2, (int) $this->app->db()->value('SELECT COUNT(*) FROM messages'));
    }

    public function testPublicUsersCannotRetrieveArbitraryTranscripts(): void
    {
        [$alice] = $this->newVisitor($this->site);
        [$bob] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $alice, 'Alice secret');
        $bobMsg = $this->visitorSend($this->site, $bob, 'Bob hello')->data()['message']['id'];

        // Bob's cursor manipulation never reaches Alice's messages.
        foreach ([0, -5, 1, $bobMsg - 1] as $after) {
            $res = $this->widget($this->site, 'GET', '/messages?after=' . $after, $bob);
            $this->assertStringNotContainsString('Alice secret', $res->body, "after={$after}");
        }
        // No token, malformed token, or another site's key: no data.
        $this->assertSame(401, $this->widget($this->site, 'GET', '/messages')->status);
        $this->assertSame(401, $this->widget($this->site, 'GET', '/messages', str_repeat('x', 43))->status);
        $other = $this->connectedSite($this->ws, $this->owner, 'https://other.example.com', 'Other');
        $res = $this->widget($other, 'GET', '/messages', $alice);
        $this->assertSame(401, $res->status, 'token is website-scoped');
        $this->assertStringNotContainsString('Alice secret', $res->body);
        // Public visitor ID is not a credential.
        $publicId = $this->visitorRow($alice)['public_id'];
        $this->assertSame(401, $this->widget($this->site, 'GET', '/messages', $publicId)->status);
        // The widget prefix exposes no dashboard endpoints.
        $this->assertSame(404, $this->widget($this->site, 'GET', '/conversations')->status);
        $this->assertSame(404, $this->request('GET', '/api/v1/widget/' . $this->site['public_key'] . '/../dashboard/w/' . $this->ws . '/conversations')->status);
    }

    public function testDashboardPollingCannotReadOtherWorkspaces(): void
    {
        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'Private to owner');
        $conv = (int) $this->app->db()->value('SELECT id FROM conversations');

        $mallory = $this->makeUser('mallory@example.com');
        $mws = $this->makeWorkspace($mallory);
        $m = $this->loginAs('mallory@example.com');
        foreach ([
            "/api/v1/dashboard/w/{$mws}/conversations/{$conv}",
            "/api/v1/dashboard/w/{$mws}/conversations/{$conv}/messages?after=0",
            "/api/v1/dashboard/w/{$this->ws}/conversations",
            "/api/v1/dashboard/w/{$this->ws}/conversations/{$conv}/messages",
            "/api/v1/dashboard/w/{$this->ws}/live",
        ] as $path) {
            $res = $m->api('GET', $path);
            $this->assertSame(404, $res->status, $path);
            $this->assertStringNotContainsString('Private to owner', $res->body);
        }
        $this->assertSame([], $m->api('GET', "/api/v1/dashboard/w/{$mws}/conversations?since=0")->data()['items']);
        $this->assertSame(404, $m->api('POST', "/api/v1/dashboard/w/{$mws}/conversations/{$conv}/messages", ['client_message_id' => 'mallory-0001', 'body' => 'hi'])->status);
        $this->assertSame(404, $m->api('POST', "/api/v1/dashboard/w/{$mws}/conversations/{$conv}/status", ['status' => 'closed'])->status);
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM messages'));
        $this->assertSame('open', $this->app->db()->value('SELECT status FROM conversations'));
        // Search in own workspace never surfaces another workspace's message bodies.
        $this->assertSame([], $m->api('GET', "/api/v1/dashboard/w/{$mws}/conversations?q=Private")->data()['items']);
    }

    public function testDashboardApiRequiresSessionAndCsrfHeader(): void
    {
        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'Hi');
        $conv = (int) $this->app->db()->value('SELECT id FROM conversations');
        $this->assertSame(401, $this->request('GET', "/api/v1/dashboard/w/{$this->ws}/conversations")->status);
        $noCsrf = $this->op->request('POST', "/api/v1/dashboard/w/{$this->ws}/conversations/{$conv}/messages", ['json' => ['client_message_id' => 'x-12345678', 'body' => 'x']]);
        $this->assertSame(419, $noCsrf->status);
    }

    public function testMessageOutputIsSafeAgainstXss(): void
    {
        [$token] = $this->newVisitor($this->site);
        $payload = '<img src=x onerror=alert(1)><script>alert("x")</script>';
        $this->visitorSend($this->site, $token, $payload);
        $this->assertSame($payload, $this->app->db()->value('SELECT body FROM messages'), 'stored verbatim as plain text');
        $list = $this->dash('GET', '/conversations');
        $this->assertStringNotContainsString('<script>', $list->body, 'JSON escapes < and >');
        $this->assertStringContainsString('u003Cscript', $list->body, 'angle brackets are JSON-escaped');
        $this->assertSame($payload, $list->data()['items'][0]['preview']);
        // Server-rendered pages escape it too.
        $this->app->db()->exec("UPDATE visitors SET name = '<b onmouseover=alert(1)>Eve</b>'");
        $vid = (int) $this->app->db()->value('SELECT id FROM visitors');
        $page = $this->op->get("/w/{$this->ws}/visitors/{$vid}")->body;
        $this->assertStringNotContainsString('<b onmouseover', $page);
        $this->assertStringContainsString('&lt;b onmouseover=alert(1)&gt;Eve&lt;/b&gt;', $page);
    }

    public function testMessageValidation(): void
    {
        [$token] = $this->newVisitor($this->site);
        $this->assertSame(422, $this->visitorSend($this->site, $token, '   ')->status);
        $this->assertSame(422, $this->visitorSend($this->site, $token, str_repeat('a', 4001))->status);
        $this->assertSame(422, $this->widget($this->site, 'POST', '/messages', $token, ['client_message_id' => 'bad id!', 'body' => 'x'])->status);
        $this->assertSame(422, $this->widget($this->site, 'POST', '/messages', $token, ['client_message_id' => 'abcdefgh1', 'body' => ['array']])->status);
        $malformed = $this->request('POST', '/api/v1/widget/' . $this->site['public_key'] . '/messages', ['raw' => '{bad json', 'headers' => ['Content-Type' => 'application/json', 'X-Visitor-Token' => $token, 'Origin' => $this->site['canonical_origin']]]);
        $this->assertSame(400, $malformed->status);
        $this->assertSame('https://shop.example.com', $malformed->headers['Access-Control-Allow-Origin'], 'errors stay readable by the widget');
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM messages'));
    }

    public function testOriginValidationAndCors(): void
    {
        $res = $this->widget($this->site, 'POST', '/session', null, [], ['Origin' => 'https://evil.example.com']);
        $this->assertSame(403, $res->status);
        $this->assertArrayNotHasKey('Access-Control-Allow-Origin', $res->headers);

        $ok = $this->widget($this->site, 'POST', '/session', null, []);
        $this->assertSame('https://shop.example.com', $ok->headers['Access-Control-Allow-Origin']);
        $this->assertArrayNotHasKey('Access-Control-Allow-Credentials', $ok->headers);

        $pre = $this->request('OPTIONS', '/api/v1/widget/' . $this->site['public_key'] . '/messages', ['headers' => ['Origin' => 'https://shop.example.com']]);
        $this->assertSame(204, $pre->status);
        $this->assertSame('https://shop.example.com', $pre->headers['Access-Control-Allow-Origin']);
        $this->assertStringContainsString('X-Visitor-Token', $pre->headers['Access-Control-Allow-Headers']);
        $bad = $this->request('OPTIONS', '/api/v1/widget/' . $this->site['public_key'] . '/messages', ['headers' => ['Origin' => 'https://evil.example.com']]);
        $this->assertArrayNotHasKey('Access-Control-Allow-Origin', $bad->headers);
        // Dashboard API offers no CORS at all.
        $dash = $this->request('OPTIONS', "/api/v1/dashboard/w/{$this->ws}/conversations", ['headers' => ['Origin' => 'https://shop.example.com']]);
        $this->assertArrayNotHasKey('Access-Control-Allow-Origin', $dash->headers);
    }

    public function testDisconnectedOrDisabledWebsiteRefusesWidgetTraffic(): void
    {
        [$token] = $this->newVisitor($this->site);
        $this->setSiteSettings($this->site, 'widget', ['enabled' => false]);
        $this->assertSame(404, $this->visitorSend($this->site, $token, 'hi')->status);
        $this->setSiteSettings($this->site, 'widget', ['enabled' => true]);
        $this->app->db()->exec("UPDATE websites SET status = 'disconnected' WHERE id = ?", [$this->site['id']]);
        $this->assertSame(404, $this->visitorSend($this->site, $token, 'hi')->status);
        $this->assertSame(404, $this->request('POST', '/api/v1/widget/' . str_repeat('0', 32) . '/session', ['json' => []])->status);
    }

    public function testConversationReopeningRules(): void
    {
        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'one');
        $conv = (int) $this->app->db()->value('SELECT id FROM conversations');
        $this->dash('POST', "/conversations/{$conv}/status", ['status' => 'closed']);
        $this->app->clock->advance(3600);
        $this->op = $this->loginAs('owner@example.com');
        $this->visitorSend($this->site, $token, 'two (within window)');
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM conversations'));
        $this->assertSame('open', $this->app->db()->value('SELECT status FROM conversations'));

        $this->dash('POST', "/conversations/{$conv}/status", ['status' => 'closed']);
        $this->app->clock->advance(25 * 3600);
        $this->visitorSend($this->site, $token, 'three (after window)');
        $this->assertSame(2, (int) $this->app->db()->value('SELECT COUNT(*) FROM conversations'));
        $state = $this->widget($this->site, 'POST', '/session', $token, [])->data();
        $this->assertSame(['three (after window)'], array_column($state['chat']['messages'], 'body'), 'visitor sees current conversation');
    }

    public function testStatusChangesAndPaginationAndFilters(): void
    {
        $tokens = [];
        for ($i = 0; $i < 5; $i++) {
            [$t] = $this->newVisitor($this->site);
            $this->visitorSend($this->site, $t, "msg {$i}");
            $tokens[] = $t;
        }
        $page1 = $this->dash('GET', '/conversations?limit=2')->data();
        $this->assertCount(2, $page1['items']);
        $page2 = $this->dash('GET', '/conversations?limit=2&before=' . $page1['next_before'])->data();
        $this->assertCount(2, $page2['items']);
        $this->assertEmpty(array_intersect(array_column($page1['items'], 'id'), array_column($page2['items'], 'id')));

        $id = $page1['items'][0]['id'];
        $this->assertSame(422, $this->dash('POST', "/conversations/{$id}/status", ['status' => 'archived'])->status);
        $this->dash('POST', "/conversations/{$id}/status", ['status' => 'pending']);
        $this->assertCount(1, $this->dash('GET', '/conversations?status=pending')->data()['items']);
        $this->assertCount(4, $this->dash('GET', '/conversations?status=open')->data()['items']);
        $this->assertCount(1, $this->dash('GET', '/conversations?q=' . urlencode('msg 3'))->data()['items']);
        $this->assertCount(5, $this->dash('GET', '/conversations?website=' . $this->site['id'])->data()['items']);
        $this->assertCount(0, $this->dash('GET', '/conversations?website=999999')->data()['items']);
        // Incremental polling: nothing new since the newest message.
        $max = (int) $this->app->db()->value('SELECT MAX(id) FROM messages');
        $this->assertCount(0, $this->dash('GET', '/conversations?since=' . $max)->data()['items']);
        $this->visitorSend($this->site, $tokens[0], 'new one');
        $this->assertCount(1, $this->dash('GET', '/conversations?since=' . $max)->data()['items']);
    }

    public function testAgentCanReplyButSupportCannot(): void
    {
        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'hi');
        $conv = (int) $this->app->db()->value('SELECT id FROM conversations');
        $agent = $this->makeUser('agent@example.com');
        $this->addMember($this->ws, $agent);
        $a = $this->loginAs('agent@example.com');
        $this->assertSame(201, $a->api('POST', "/api/v1/dashboard/w/{$this->ws}/conversations/{$conv}/messages", ['client_message_id' => 'agent-00001', 'body' => 'agent here'])->status);

        $this->makeUser('root@example.com', true);
        $this->op->submit("/w/{$this->ws}/support-grants", ['hours' => 1, 'reason' => 'debug']);
        $root = $this->loginAs('root@example.com');
        $this->assertSame(200, $root->api('GET', "/api/v1/dashboard/w/{$this->ws}/conversations/{$conv}")->status);
        $this->assertSame(403, $root->api('POST', "/api/v1/dashboard/w/{$this->ws}/conversations/{$conv}/messages", ['client_message_id' => 'root-000001', 'body' => 'x'])->status);
        $this->assertSame(403, $root->api('POST', "/api/v1/dashboard/w/{$this->ws}/conversations/{$conv}/status", ['status' => 'closed'])->status);
    }

    public function testAuditLogsNeverContainMessageBodies(): void
    {
        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'CONFIDENTIAL-BODY-123');
        $conv = (int) $this->app->db()->value('SELECT id FROM conversations');
        $this->dash('POST', "/conversations/{$conv}/messages", ['client_message_id' => 'op-audit-01', 'body' => 'OPERATOR-BODY-456']);
        $vid = (int) $this->app->db()->value('SELECT id FROM visitors');
        $this->op->submit("/w/{$this->ws}/visitors/{$vid}/block", ['reason' => 'spam']);
        $audit = json_encode($this->app->db()->all('SELECT * FROM audit_logs'));
        $this->assertStringNotContainsString('CONFIDENTIAL-BODY-123', $audit);
        $this->assertStringNotContainsString('OPERATOR-BODY-456', $audit);
        $this->assertStringNotContainsString($token, $audit);
        $this->assertStringNotContainsString('CONFIDENTIAL-BODY-123', $this->logContents());
    }
}
