<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Tests\TestCase;
use Signalpost\Tests\WidgetFixtures;
use Signalpost\Visitors\GeoService;
use Signalpost\Visitors\TrackingService;

final class VisitorTrackingTest extends TestCase
{
    use WidgetFixtures;

    private int $owner;
    private int $ws;
    private array $site;

    protected function setUp(): void
    {
        parent::setUp();
        $this->owner = $this->makeUser('owner@example.com');
        $this->ws = $this->makeWorkspace($this->owner);
        $this->site = $this->connectedSite($this->ws, $this->owner);
    }

    private function enableAnalytics(array $extra = []): void
    {
        $this->setSiteSettings($this->site, 'tracking', $extra + ['analytics_enabled' => true]);
    }

    private function pageView(string $path, ?string $uid = null, array $extra = []): array
    {
        return ['type' => 'page_view', 'uid' => $uid ?? bin2hex(random_bytes(8)), 'path' => $path] + $extra;
    }

    private function sendEvents(string $token, array $events, array $headers = []): \Signalpost\Http\Response
    {
        return $this->widget($this->site, 'POST', '/events', $token, ['events' => $events], $headers);
    }

    private function grant(string $token, bool $yes = true): \Signalpost\Http\Response
    {
        return $this->widget($this->site, 'POST', '/consent', $token, ['analytics' => $yes, 'source' => 'widget']);
    }

    private function rows(string $table): int
    {
        return (int) $this->app->db()->value("SELECT COUNT(*) FROM {$table}");
    }

    public function testEssentialChatWorksWithAnalyticsDisabledAndNothingOptionalIsStored(): void
    {
        [$token, $state] = $this->newVisitor($this->site);
        $this->assertFalse($state['analytics']['permitted']);
        $this->assertFalse($state['analytics']['needs_prompt']);
        $this->assertSame(201, $this->visitorSend($this->site, $token, 'Help')->status);
        $res = $this->sendEvents($token, [$this->pageView('/products')], ['User-Agent' => 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0']);
        $this->assertSame(202, $res->status);
        $this->assertFalse($res->data()['accepted']);
        $this->assertSame(0, $this->rows('visitor_events'));
        $this->assertSame(0, $this->rows('visitor_sessions'));
        $v = $this->visitorRow($token);
        $this->assertSame(0, (int) $v['visit_count']);
        $this->assertNull($v['browser']);
        $this->assertNull($v['last_page_path']);
        // Analytics consent cannot be "granted" when the website has analytics off.
        $this->assertFalse($this->grant($token)->data()['analytics_permitted']);
        $this->assertSame(0, $this->rows('consent_records'));
    }

    public function testOptionalAnalyticsRequireConsentFirstAndFailClosed(): void
    {
        $this->enableAnalytics();
        [$token, $state] = $this->newVisitor($this->site);
        $this->assertTrue($state['analytics']['needs_prompt']);
        $this->assertFalse($state['analytics']['permitted']);
        $this->assertFalse($this->sendEvents($token, [$this->pageView('/before-consent')])->data()['accepted']);
        $this->assertSame(0, $this->rows('visitor_events'));

        $res = $this->grant($token);
        $this->assertSame('analytics', $res->data()['consent_state']);
        $this->assertTrue($res->data()['analytics_permitted']);
        $rec = $this->app->db()->one('SELECT * FROM consent_records');
        $this->assertSame('granted', $rec['decision']);
        $this->assertSame('1', $rec['policy_version']);
        $this->assertNotNull($rec['recorded_at']);

        $this->assertSame(1, $this->sendEvents($token, [$this->pageView('/after-consent')])->data()['stored']);

        // A new policy version requires asking again; collection stops until then.
        $this->enableAnalytics(['policy_version' => '2']);
        $state = $this->widget($this->site, 'POST', '/session', $token, [])->data();
        $this->assertTrue($state['analytics']['needs_prompt']);
        $this->assertFalse($this->sendEvents($token, [$this->pageView('/policy-changed')])->data()['accepted']);
        $this->assertSame(1, $this->rows('visitor_events'));
    }

    public function testDeclineRecordsEssentialOnly(): void
    {
        $this->enableAnalytics();
        [$token] = $this->newVisitor($this->site);
        $this->assertSame('essential', $this->grant($token, false)->data()['consent_state']);
        $this->assertFalse($this->sendEvents($token, [$this->pageView('/x')])->data()['accepted']);
        $this->assertSame(201, $this->visitorSend($this->site, $token, 'still can chat')->status);
    }

    public function testConsentWithdrawalStopsCollectionAndErasesAnalytics(): void
    {
        $this->enableAnalytics(['collect_browser' => true]);
        [$token] = $this->newVisitor($this->site);
        $this->grant($token);
        $this->sendEvents($token, [$this->pageView('/a'), $this->pageView('/b')], ['User-Agent' => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) Safari/605.1.15']);
        $this->assertSame(2, $this->rows('visitor_events'));
        $this->assertSame('Safari', $this->visitorRow($token)['browser']);

        $res = $this->grant($token, false);
        $this->assertSame('withdrawn', $res->data()['consent_state']);
        $this->assertSame(0, $this->rows('visitor_events'));
        $this->assertSame(0, $this->rows('visitor_sessions'));
        $v = $this->visitorRow($token);
        $this->assertNull($v['browser']);
        $this->assertNull($v['last_page_path']);
        $this->assertSame(0, (int) $v['visit_count']);
        $this->assertFalse($this->sendEvents($token, [$this->pageView('/c')])->data()['accepted']);
        $this->assertSame(0, $this->rows('visitor_events'));
        $this->assertSame(1, (int) $this->app->db()->value("SELECT COUNT(*) FROM consent_records WHERE decision = 'withdrawn'"));
        $this->assertNotNull($this->app->db()->value("SELECT withdrawn_at FROM consent_records WHERE decision = 'granted'"));
        // Chat keeps working after withdrawal.
        $this->assertSame(201, $this->visitorSend($this->site, $token, 'chat still works')->status);
    }

    public function testOtherLegalBasisCollectsUntilObjection(): void
    {
        $this->enableAnalytics(['legal_basis' => 'other']);
        [$token, $state] = $this->newVisitor($this->site);
        $this->assertFalse($state['analytics']['needs_prompt']);
        $this->assertTrue($state['analytics']['permitted']);
        $this->assertSame(1, $this->sendEvents($token, [$this->pageView('/page')])->data()['stored']);
        $this->assertSame('withdrawn', $this->grant($token, false)->data()['consent_state']);
        $this->assertFalse($this->sendEvents($token, [$this->pageView('/page2')])->data()['accepted']);
    }

    public function testExcludedPagesQueryStringsAndFragmentsAreSanitised(): void
    {
        $this->enableAnalytics();
        [$token] = $this->newVisitor($this->site);
        $this->grant($token);
        $res = $this->sendEvents($token, [
            $this->pageView('/checkout/step-1?card=4111111111111111'),
            $this->pageView('/my-account/orders'),
            $this->pageView('/wp-login.php?redirect=x'),
            $this->pageView('/blog/post?utm_source=mail&token=secret#comments'),
            $this->pageView('https://evil.example.com/other-site'),
            $this->pageView('//evil.example.com/x'),
            $this->pageView('/caf%C3%A9'),
        ]);
        $this->assertSame(2, $res->data()['stored']);
        $paths = array_column($this->app->db()->all('SELECT page_path FROM visitor_events ORDER BY id'), 'page_path');
        $this->assertSame(['/blog/post', '/café'], $paths);
        $dump = json_encode($this->app->db()->all('SELECT * FROM visitor_events'));
        $this->assertStringNotContainsString('4111', $dump);
        $this->assertStringNotContainsString('secret', $dump);
        $this->assertStringNotContainsString('utm_source', $dump);
        $this->assertSame('/blog/post', TrackingService::sanitizePath('/blog/post#frag'));
    }

    public function testTitlesAndReferrersOnlyWhenEnabledAndReferrerReducedToOrigin(): void
    {
        $this->enableAnalytics();
        [$token] = $this->newVisitor($this->site);
        $this->grant($token);
        $this->sendEvents($token, [$this->pageView('/a', null, ['title' => 'Secret title', 'referrer' => 'https://google.com/search?q=private'])]);
        $row = $this->app->db()->one('SELECT page_title, referrer_origin FROM visitor_events');
        $this->assertNull($row['page_title']);
        $this->assertNull($row['referrer_origin']);

        $this->enableAnalytics(['record_page_titles' => true, 'record_referrer' => true]);
        $this->sendEvents($token, [
            $this->pageView('/b', null, ['title' => "Pricing\n<script>", 'referrer' => 'https://google.com/search?q=private']),
            $this->pageView('/c', null, ['referrer' => 'https://shop.example.com/internal']),
        ]);
        $rows = $this->app->db()->all('SELECT page_title, referrer_origin FROM visitor_events ORDER BY id');
        $this->assertSame('Pricing <script>', $rows[1]['page_title'], 'stored as plain text, escaped on output');
        $this->assertSame('https://google.com', $rows[1]['referrer_origin']);
        $this->assertNull($rows[2]['referrer_origin'], 'same-site referrer dropped');
    }

    public function testRepeatedEventsAreDeduplicated(): void
    {
        $this->enableAnalytics();
        [$token] = $this->newVisitor($this->site);
        $this->grant($token);
        $batch = [$this->pageView('/x', 'aaaaaaaaaaaaaaaa1'), $this->pageView('/y', 'bbbbbbbbbbbbbbbb2')];
        $this->assertSame(2, $this->sendEvents($token, $batch)->data()['stored']);
        $retry = $this->sendEvents($token, $batch)->data();
        $this->assertSame(0, $retry['stored']);
        $this->assertSame(2, $retry['skipped']);
        $this->assertSame(2, $this->rows('visitor_events'));
        $this->assertSame(2, (int) $this->app->db()->value('SELECT page_views FROM visitor_sessions'));
    }

    public function testVisitCountsFollowSessionRules(): void
    {
        $this->enableAnalytics(['session_timeout_minutes' => 30]);
        [$token] = $this->newVisitor($this->site);
        $this->grant($token);
        $this->sendEvents($token, [$this->pageView('/1')]);
        $this->app->clock->advance(10 * 60);
        $this->sendEvents($token, [$this->pageView('/2')]);
        // Chat activity and polling never count as visits.
        $this->visitorSend($this->site, $token, 'hello');
        for ($i = 0; $i < 5; $i++) {
            $this->widget($this->site, 'GET', '/messages?after=0', $token);
        }
        $this->assertSame(1, (int) $this->visitorRow($token)['visit_count']);
        $this->app->clock->advance(29 * 60);
        $this->sendEvents($token, [$this->pageView('/3')]);
        $this->assertSame(1, (int) $this->visitorRow($token)['visit_count'], 'within 30 min of last activity');
        $this->app->clock->advance(31 * 60);
        $this->sendEvents($token, [$this->pageView('/4')]);
        $this->assertSame(2, (int) $this->visitorRow($token)['visit_count'], 'gap > threshold starts a new visit');
        $this->assertSame(2, $this->rows('visitor_sessions'));
        $this->assertNotNull($this->app->db()->value('SELECT ended_at FROM visitor_sessions ORDER BY id LIMIT 1'));
    }

    public function testBatchAndPayloadLimits(): void
    {
        $this->enableAnalytics();
        [$token] = $this->newVisitor($this->site);
        $this->grant($token);
        $events = [];
        for ($i = 0; $i < 21; $i++) {
            $events[] = $this->pageView('/p' . $i);
        }
        $this->assertSame(422, $this->sendEvents($token, $events)->status);
        $big = $this->widget($this->site, 'POST', '/events', $token, ['events' => [$this->pageView('/' . str_repeat('a', 70000))]]);
        $this->assertSame(413, $big->status);
        $this->assertSame(0, $this->rows('visitor_events'));
    }

    public function testCoarseBrowserMetadataOnlyAndNoFingerprint(): void
    {
        $this->enableAnalytics(['collect_browser' => true]);
        [$token] = $this->newVisitor($this->site);
        $this->grant($token);
        $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.89 Safari/537.36';
        $this->sendEvents($token, [$this->pageView('/x', null, ['screen' => '2560x1440', 'timezone' => 'Europe/Berlin', 'plugins' => 'pdf,flash', 'canvas' => 'abc123'])], ['User-Agent' => $ua]);
        $v = $this->visitorRow($token);
        $this->assertSame('Chrome', $v['browser']);
        $this->assertSame('Windows', $v['os']);
        $dump = json_encode($this->app->db()->all('SELECT * FROM visitors')) . json_encode($this->app->db()->all('SELECT * FROM visitor_events'));
        foreach (['129.0', 'Win64', '2560x1440', 'Europe/Berlin', 'abc123', 'AppleWebKit'] as $needle) {
            $this->assertStringNotContainsString($needle, $dump, $needle);
        }
        // Two visitors with identical browser characteristics are never merged.
        [$token2] = $this->newVisitor($this->site);
        $this->grant($token2);
        $this->sendEvents($token2, [$this->pageView('/x')], ['User-Agent' => $ua]);
        $this->assertSame(2, $this->rows('visitors'));
        $this->assertNotSame($this->visitorRow($token)['public_id'], $this->visitorRow($token2)['public_id']);
    }

    public function testCountryEstimationFromLocalTableWithoutStoringIp(): void
    {
        $app = $this->makeApp(['geo' => ['provider' => 'table']]);
        $this->app = $app;
        $n = $app->get(GeoService::class)->import(__DIR__ . '/../fixtures/geo-sample.csv');
        $this->assertSame(3, $n, 'invalid rows skipped');
        $this->assertSame('NL', $app->get(GeoService::class)->lookup('203.0.113.77'));
        $this->assertSame('DE', $app->get(GeoService::class)->lookup('2001:db8::1234'));
        $this->assertNull($app->get(GeoService::class)->lookup('198.51.100.1'));

        $this->enableAnalytics(['estimate_country' => true]);
        [$token] = $this->newVisitor($this->site);
        $this->grant($token);
        $this->widget($this->site, 'POST', '/events', $token, ['events' => [$this->pageView('/a')]]);
        $v = $this->visitorRow($token);
        $this->assertSame('NL', $v['country_code'], 'test client IP is 203.0.113.10');
        $this->assertSame('local_db', $v['country_source']);
        foreach (['visitors', 'visitor_events', 'visitor_sessions', 'consent_records', 'messages', 'audit_logs'] as $t) {
            $this->assertStringNotContainsString('203.0.113.10', json_encode($this->app->db()->all("SELECT * FROM {$t}")), $t);
        }
    }

    public function testUnknownCountryDoesNotBreakProfiles(): void
    {
        $this->app = $this->makeApp(['geo' => ['provider' => 'table']]);
        $this->enableAnalytics(['estimate_country' => true]);
        [$token] = $this->newVisitor($this->site);
        $this->grant($token);
        $this->sendEvents($token, [$this->pageView('/a')]);
        $v = $this->visitorRow($token);
        $this->assertNull($v['country_code']);
        $b = $this->loginAs('owner@example.com');
        $page = $b->get("/w/{$this->ws}/visitors/{$v['id']}");
        $this->assertSame(200, $page->status);
        $this->assertStringContainsString('unknown', $page->body);
        $this->assertSame(200, $b->api('GET', "/api/v1/dashboard/w/{$this->ws}/live")->status);
    }

    public function testTrustedHeaderGeoOnlyFromTrustedProxy(): void
    {
        $this->app = $this->makeApp(['geo' => ['provider' => 'trusted_header'], 'security' => ['trusted_proxies' => ['10.0.0.0/8']]]);
        $this->enableAnalytics(['estimate_country' => true]);
        [$token] = $this->newVisitor($this->site);
        $this->grant($token);
        $this->request('POST', '/api/v1/widget/' . $this->site['public_key'] . '/events', ['json' => ['events' => [$this->pageView('/a')]], 'headers' => ['X-Visitor-Token' => $token, 'CF-IPCountry' => 'FR', 'Origin' => $this->site['canonical_origin']]]);
        $this->assertNull($this->visitorRow($token)['country_code'], 'spoofed header from untrusted peer ignored');
        $this->app->clock->advance(31 * 60);
        $this->request('POST', '/api/v1/widget/' . $this->site['public_key'] . '/events', ['ip' => '10.1.2.3', 'json' => ['events' => [$this->pageView('/b')]], 'headers' => ['X-Visitor-Token' => $token, 'CF-IPCountry' => 'FR', 'X-Forwarded-For' => '198.51.100.9', 'Origin' => $this->site['canonical_origin']]]);
        $this->assertSame('FR', $this->visitorRow($token)['country_code']);
    }

    public function testPrechatFormValidationAndNoEcho(): void
    {
        $this->setSiteSettings($this->site, 'widget', ['prechat_name' => 'required', 'prechat_email' => 'optional']);
        [$token, $state] = $this->newVisitor($this->site);
        $this->assertSame(['name'], $state['chat']['prechat']['missing_required']);
        $this->assertSame(409, $this->visitorSend($this->site, $token, 'hi')->status, 'required form before chatting');

        $bad = $this->widget($this->site, 'POST', '/contact', $token, ['name' => 'Ann', 'email' => 'not-an-email']);
        $this->assertSame(422, $bad->status);
        $missing = $this->widget($this->site, 'POST', '/contact', $token, ['email' => 'ann@example.com']);
        $this->assertSame(422, $missing->status);

        $ok = $this->widget($this->site, 'POST', '/contact', $token, ['name' => '<img src=x onerror=alert(1)>Ann', 'email' => 'Ann@Example.com', 'phone' => '+1 555 0100', 'ssn' => '123']);
        $this->assertSame(200, $ok->status);
        $this->assertSame(['name', 'email'], $ok->data()['saved']);
        $this->assertStringNotContainsString('ann@example.com', $ok->body, 'contact details are not echoed by public endpoints');
        $v = $this->visitorRow($token);
        $this->assertSame('<img src=x onerror=alert(1)>Ann', $v['name']);
        $this->assertSame('ann@example.com', $v['email']);
        $this->assertNull($v['phone'], 'field turned off is ignored');
        $this->assertSame(201, $this->visitorSend($this->site, $token, 'now I can chat')->status);
        $session = $this->widget($this->site, 'POST', '/session', $token, []);
        $this->assertStringNotContainsString('ann@example.com', $session->body);
        $this->assertStringNotContainsString('onerror', $session->body);
    }

    public function testVisitorIdSubstitutionCannotTouchAnotherProfile(): void
    {
        $this->setSiteSettings($this->site, 'widget', ['prechat_email' => 'optional']);
        [$alice] = $this->newVisitor($this->site);
        [$mallory] = $this->newVisitor($this->site);
        $aliceRow = $this->visitorRow($alice);
        $res = $this->widget($this->site, 'POST', '/contact', $mallory, ['email' => 'mallory@example.com', 'visitor_id' => $aliceRow['id'], 'public_id' => $aliceRow['public_id']]);
        $this->assertSame(200, $res->status);
        $this->assertNull($this->visitorRow($alice)['email']);
        $this->assertSame('mallory@example.com', $this->visitorRow($mallory)['email']);
        // Using Alice's public ID as a token does not work.
        $this->assertSame(401, $this->widget($this->site, 'POST', '/contact', $aliceRow['public_id'], ['email' => 'x@example.com'])->status);
    }

    public function testVisitorTokenRotationKeepsIdentity(): void
    {
        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'before rotation');
        $id = (int) $this->visitorRow($token)['id'];
        $this->app->clock->advance(31 * 86400);
        $state = $this->widget($this->site, 'POST', '/session', $token, [])->data();
        $new = $state['token'];
        $this->assertIsString($new);
        $this->assertNotSame($token, $new);
        $this->assertSame('before rotation', $state['chat']['messages'][0]['body']);
        $this->assertSame($id, (int) $this->visitorRow($new)['id']);
        $this->assertSame(200, $this->widget($this->site, 'GET', '/messages', $token)->status, 'previous token valid until next rotation');
        $this->assertStringNotContainsString($new, json_encode($this->app->db()->all('SELECT * FROM visitors')), 'token stored only as keyed hash');
    }

    public function testNoIdentityIsCreatedWithoutWidgetInteraction(): void
    {
        $this->enableAnalytics();
        // Events without a visitor token are rejected; nothing is created implicitly.
        $res = $this->widget($this->site, 'POST', '/events', null, ['events' => [$this->pageView('/x')]]);
        $this->assertSame(401, $res->status);
        $this->assertSame(0, $this->rows('visitors'));
    }

    public function testLiveVisitorsDistinguishActiveFromRecent(): void
    {
        $this->enableAnalytics();
        [$t1] = $this->newVisitor($this->site);
        $this->grant($t1);
        $this->sendEvents($t1, [$this->pageView('/pricing')]);
        [$t2] = $this->newVisitor($this->site);
        $this->app->db()->exec('UPDATE visitors SET last_seen_at = ? WHERE id = ?', [$this->app->clock->sql(-600), $this->visitorRow($t2)['id']]);
        [$t3] = $this->newVisitor($this->site);
        $this->app->db()->exec('UPDATE visitors SET last_seen_at = ? WHERE id = ?', [$this->app->clock->sql(-7200), $this->visitorRow($t3)['id']]);

        $b = $this->loginAs('owner@example.com');
        $live = $b->api('GET', "/api/v1/dashboard/w/{$this->ws}/live")->data();
        $this->assertSame(120, $live['active_window_seconds']);
        $byId = array_column($live['items'], null, 'public_id');
        $this->assertSame('active', $byId[$this->visitorRow($t1)['public_id']]['state']);
        $this->assertSame('/pricing', $byId[$this->visitorRow($t1)['public_id']]['last_page']);
        $this->assertSame('recent', $byId[$this->visitorRow($t2)['public_id']]['state']);
        $this->assertNull($byId[$this->visitorRow($t2)['public_id']]['last_page'], 'no page without analytics consent');
        $this->assertArrayNotHasKey($this->visitorRow($t3)['public_id'], $byId, 'older than the recent window');
    }
}
