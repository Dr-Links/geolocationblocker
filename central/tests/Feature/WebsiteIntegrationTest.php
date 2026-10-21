<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Sites\Origin;
use Signalpost\Sites\SettingsSchema;
use Signalpost\Tests\Browser;
use Signalpost\Tests\TestCase;

final class WebsiteIntegrationTest extends TestCase
{
    private int $owner;
    private int $ws;
    private Browser $ob;

    protected function setUp(): void
    {
        parent::setUp();
        $this->owner = $this->makeUser('owner@example.com');
        $this->ws = $this->makeWorkspace($this->owner, 'Owner Co');
        $this->ob = $this->loginAs('owner@example.com');
    }

    private function createSite(Browser $b, int $ws, string $name, string $origin): int
    {
        $res = $b->submit("/w/{$ws}/websites", ['name' => $name, 'origin' => $origin]);
        $this->assertSame(303, $res->status, $res->body);
        preg_match('#/websites/(\d+)#', $res->headers['Location'], $m);
        return (int) $m[1];
    }

    private function pairingCode(Browser $b, int $ws, int $site): string
    {
        $res = $b->submit("/w/{$ws}/websites/{$site}/pairing-code");
        $this->assertSame(200, $res->status);
        $this->assertSame(1, preg_match('#<div class="secret-box"[^>]*>([A-Z2-9\-]{19})</div>#', $res->body, $m));
        return $m[1];
    }

    /** @return array{credential:string, public_key:string} */
    private function pair(string $code, string $siteUrl): array
    {
        $res = $this->request('POST', '/api/v1/integration/pair', ['json' => ['pairing_code' => $code, 'site_url' => $siteUrl, 'plugin_version' => '1.0.0', 'wp_version' => '6.8.3']]);
        $this->assertSame(200, $res->status, $res->body);
        $d = $res->data();
        return ['credential' => $d['credential'], 'public_key' => $d['website']['public_key']];
    }

    private function api(string $method, string $path, string $credential, ?array $json = null): \Signalpost\Http\Response
    {
        $opts = ['headers' => ['Authorization' => 'Bearer ' . $credential]];
        if ($json !== null) {
            $opts['json'] = $json;
        }
        return $this->request($method, $path, $opts);
    }

    public function testOriginNormalisation(): void
    {
        $this->assertSame('https://www.example.com', Origin::normalize('HTTPS://WWW.Example.com/'));
        $this->assertSame('https://example.com:8443', Origin::normalize('https://example.com:8443'));
        $this->assertSame('https://example.com', Origin::normalize('https://example.com:443'));
        $this->assertNull(Origin::normalize('http://example.com'), 'plain http rejected outside local dev');
        $this->assertSame('http://shop.test', Origin::normalize('http://shop.test'));
        foreach (['https://example.com/blog', 'https://user:pw@example.com', 'https://example.com?x=1', 'javascript:alert(1)', 'ftp://example.com', 'https://exa mple.com', 'https://<x>.com'] as $bad) {
            $this->assertNull(Origin::normalize($bad), $bad);
        }
        $this->assertSame('https://example.com', Origin::ofUrl('https://example.com/blog/wp'));
    }

    public function testOwnerRegistersWebsiteWithDefaultsAndValidation(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $site = $this->app->db()->one('SELECT * FROM websites WHERE id = ?', [$id]);
        $this->assertSame('pending', $site['status']);
        $this->assertSame('essential', $site['tracking_policy']);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $site['public_key']);
        $settings = $this->app->get(\Signalpost\Sites\WebsiteService::class)->settings($id);
        $this->assertFalse($settings['tracking']['analytics_enabled'], 'analytics disabled by default');
        $this->assertContains('/checkout', $settings['tracking']['excluded_paths']);

        $dup = $this->ob->submit("/w/{$this->ws}/websites", ['name' => 'Again', 'origin' => 'https://shop.example.com/']);
        $this->assertSame(422, $dup->status);
        $bad = $this->ob->submit("/w/{$this->ws}/websites", ['name' => 'Bad', 'origin' => 'https://shop.example.com/path']);
        $this->assertSame(422, $bad->status);
    }

    public function testAgentCanViewButNotManageWebsites(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $agent = $this->makeUser('agent@example.com');
        $this->addMember($this->ws, $agent);
        $b = $this->loginAs('agent@example.com');
        $this->assertSame(200, $b->get("/w/{$this->ws}/websites/{$id}")->status);
        $this->assertSame(403, $b->submit("/w/{$this->ws}/websites", ['name' => 'X', 'origin' => 'https://x.example.com'])->status);
        $this->assertSame(403, $b->submit("/w/{$this->ws}/websites/{$id}/pairing-code")->status);
        $this->assertSame(403, $b->submit("/w/{$this->ws}/websites/{$id}/disconnect")->status);
        $this->assertSame(403, $b->submit("/w/{$this->ws}/websites/{$id}/settings/tracking", ['analytics_enabled' => '1'])->status);
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM pairing_codes'));
    }

    public function testOtherWorkspaceCannotSeeOrTouchWebsite(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $mallory = $this->makeUser('mallory@example.com');
        $mws = $this->makeWorkspace($mallory, 'Mallory Co');
        $m = $this->loginAs('mallory@example.com');
        foreach (["/w/{$mws}/websites/{$id}", "/w/{$this->ws}/websites/{$id}", "/w/{$this->ws}/websites"] as $p) {
            $this->assertSame(404, $m->get($p)->status, $p);
        }
        foreach (['pairing-code', 'rotate', 'disconnect', 'settings/widget'] as $action) {
            $this->assertSame(404, $m->submit("/w/{$mws}/websites/{$id}/{$action}", ['enabled' => '1'])->status, $action);
        }
        $this->assertSame(404, $m->submit("/w/{$mws}/websites/{$id}/delete", ['confirm_name' => 'Shop'])->status);
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM websites'));
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM pairing_codes'));
    }

    public function testPairingCodeIsOneTimeHashedAndOriginChecked(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $code = $this->pairingCode($this->ob, $this->ws, $id);
        $this->assertNull($this->app->db()->value('SELECT id FROM pairing_codes WHERE code_hash = ?', [$code]));
        // Detail page reload does not show the code again.
        $this->assertStringNotContainsString($code, $this->ob->get("/w/{$this->ws}/websites/{$id}")->body);

        $wrongOrigin = $this->request('POST', '/api/v1/integration/pair', ['json' => ['pairing_code' => $code, 'site_url' => 'https://evil.example.com']]);
        $this->assertSame(400, $wrongOrigin->status);
        $this->assertSame('origin_mismatch', json_decode($wrongOrigin->body, true)['error']['code']);

        $paired = $this->pair(strtolower($code), 'https://shop.example.com/wordpress');
        $this->assertMatchesRegularExpression('/^spk_[0-9a-f]{12}\.[A-Za-z0-9_\-]{43}$/', $paired['credential']);
        $this->assertSame('connected', $this->app->db()->value('SELECT status FROM websites WHERE id = ?', [$id]));

        $again = $this->request('POST', '/api/v1/integration/pair', ['json' => ['pairing_code' => $code, 'site_url' => 'https://shop.example.com']]);
        $this->assertSame(400, $again->status, 'code is single use');

        // Plaintext secret is never stored.
        [, $secret] = explode('.', $paired['credential']);
        $dump = json_encode($this->app->db()->all('SELECT * FROM site_credentials')) . json_encode($this->app->db()->all('SELECT * FROM audit_logs'));
        $this->assertStringNotContainsString($secret, $dump);
        $this->assertStringContainsString(hash('sha256', $secret), $dump);
    }

    public function testExpiredPairingCodeIsRejected(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $code = $this->pairingCode($this->ob, $this->ws, $id);
        $this->app->clock->advance(1801);
        $res = $this->request('POST', '/api/v1/integration/pair', ['json' => ['pairing_code' => $code, 'site_url' => 'https://shop.example.com']]);
        $this->assertSame(400, $res->status);
    }

    public function testValidInvalidRevokedCredentials(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $cred = $this->pair($this->pairingCode($this->ob, $this->ws, $id), 'https://shop.example.com')['credential'];

        $ok = $this->api('GET', '/api/v1/integration/config', $cred);
        $this->assertSame(200, $ok->status);
        $data = $ok->data();
        $this->assertSame('Shop', $data['website']['name']);
        $this->assertArrayHasKey('widget', $data);
        $this->assertStringNotContainsString(explode('.', $cred)[1], $ok->body);

        [$prefix, $secret] = explode('.', $cred);
        foreach ([
            '',
            'garbage',
            $prefix . '.' . str_repeat('A', 43),
            'spk_000000000000.' . $secret,
            $cred . 'x',
        ] as $bad) {
            $this->assertSame(401, $this->api('GET', '/api/v1/integration/config', $bad)->status, "credential: {$bad}");
        }
        $this->assertSame(401, $this->request('GET', '/api/v1/integration/config')->status);

        $this->ob->submit("/w/{$this->ws}/websites/{$id}/disconnect");
        $this->assertSame(401, $this->api('GET', '/api/v1/integration/config', $cred)->status, 'revoked credential');
        $this->assertSame('disconnected', $this->app->db()->value('SELECT status FROM websites WHERE id = ?', [$id]));

        // Reconnect with a new pairing code.
        $cred2 = $this->pair($this->pairingCode($this->ob, $this->ws, $id), 'https://shop.example.com')['credential'];
        $this->assertSame(200, $this->api('GET', '/api/v1/integration/config', $cred2)->status);
        $this->assertSame(401, $this->api('GET', '/api/v1/integration/config', $cred)->status);
    }

    public function testRotationGracePeriodAndRequestFlag(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $old = $this->pair($this->pairingCode($this->ob, $this->ws, $id), 'https://shop.example.com')['credential'];

        $this->ob->submit("/w/{$this->ws}/websites/{$id}/rotate");
        $this->assertTrue($this->api('GET', '/api/v1/integration/config', $old)->data()['rotation_requested']);

        $rot = $this->api('POST', '/api/v1/integration/rotate', $old);
        $this->assertSame(200, $rot->status);
        $new = $rot->data()['credential'];
        $this->assertNotSame($old, $new);
        $this->assertFalse($this->api('GET', '/api/v1/integration/config', $new)->data()['rotation_requested']);
        $this->assertSame(200, $this->api('GET', '/api/v1/integration/config', $old)->status, 'old credential valid during grace');
        $this->assertSame(403, $this->api('POST', '/api/v1/integration/rotate', $old)->status, 'superseded credential cannot rotate');
        $this->assertSame(403, $this->api('PUT', '/api/v1/integration/settings', $old, ['widget' => ['enabled' => false]])->status);
        $this->assertSame(403, $this->api('POST', '/api/v1/integration/disconnect', $old)->status, 'superseded credential cannot disconnect');
        $this->assertSame(200, $this->api('GET', '/api/v1/integration/config', $new)->status);

        $this->app->clock->advance(601);
        $this->assertSame(401, $this->api('GET', '/api/v1/integration/config', $old)->status, 'old credential expired after grace');
        $this->assertSame(200, $this->api('GET', '/api/v1/integration/config', $new)->status);
    }

    public function testWebsiteCredentialCannotAccessAnotherWebsite(): void
    {
        $a = $this->createSite($this->ob, $this->ws, 'Site A', 'https://a.example.com');
        $b = $this->createSite($this->ob, $this->ws, 'Site B', 'https://b.example.com');
        $credA = $this->pair($this->pairingCode($this->ob, $this->ws, $a), 'https://a.example.com')['credential'];
        $this->pair($this->pairingCode($this->ob, $this->ws, $b), 'https://b.example.com');

        $res = $this->api('PUT', '/api/v1/integration/settings', $credA, ['website_id' => $b, 'public_key' => 'x', 'widget' => ['brand_name' => 'Hijacked', 'website_id' => $b]]);
        $this->assertSame(200, $res->status);
        $this->assertSame('Site A', $res->data()['website']['name']);
        $settings = $this->app->get(\Signalpost\Sites\WebsiteService::class);
        $this->assertSame('Hijacked', $settings->settings($a)['widget']['brand_name']);
        $this->assertSame('', $settings->settings($b)['widget']['brand_name'], 'site B untouched');
        $this->assertSame('Site A', $this->api('GET', '/api/v1/integration/config?website_id=' . $b, $credA)->data()['website']['name']);

        // A credential cannot be used to pair or re-pair the other site.
        $res = $this->request('POST', '/api/v1/integration/pair', ['json' => ['pairing_code' => 'AAAA-BBBB-CCCC-DDDD', 'site_url' => 'https://b.example.com'], 'headers' => ['Authorization' => 'Bearer ' . $credA]]);
        $this->assertSame(400, $res->status);
    }

    public function testPluginMayOnlyChangeAllowedSettings(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $cred = $this->pair($this->pairingCode($this->ob, $this->ws, $id), 'https://shop.example.com')['credential'];
        $res = $this->api('PUT', '/api/v1/integration/settings', $cred, [
            'widget' => ['primary_color' => '#AA0000', 'position' => 'left', 'reopen_window_hours' => 1],
            'tracking' => ['analytics_enabled' => true, 'legal_basis' => 'other', 'excluded_paths' => ['/secret', '/members']],
        ]);
        $this->assertSame(200, $res->status, $res->body);
        $s = $this->app->get(\Signalpost\Sites\WebsiteService::class)->settings($id);
        $this->assertSame('#aa0000', $s['widget']['primary_color']);
        $this->assertSame('left', $s['widget']['position']);
        $this->assertSame(24, $s['widget']['reopen_window_hours'], 'not a plugin-editable field');
        $this->assertFalse($s['tracking']['analytics_enabled'], 'analytics policy is dashboard-only');
        $this->assertSame('consent', $s['tracking']['legal_basis']);
        $this->assertSame(['/secret', '/members'], $s['tracking']['excluded_paths']);

        $bad = $this->api('PUT', '/api/v1/integration/settings', $cred, ['widget' => ['primary_color' => 'red; background:url(x)']]);
        $this->assertSame(422, $bad->status);
        $bad = $this->api('PUT', '/api/v1/integration/settings', $cred, ['widget' => ['hidden_paths' => ['no-slash']]]);
        $this->assertSame(422, $bad->status);
    }

    public function testPluginDisconnectKeepsCentralHistory(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $cred = $this->pair($this->pairingCode($this->ob, $this->ws, $id), 'https://shop.example.com')['credential'];
        $now = $this->app->clock->sql();
        $db = $this->app->db();
        $visitor = $db->insert('visitors', ['public_id' => 'v1', 'workspace_id' => $this->ws, 'website_id' => $id, 'token_hash' => str_repeat('a', 64), 'token_issued_at' => $now, 'first_seen_at' => $now, 'last_seen_at' => $now, 'created_at' => $now, 'updated_at' => $now]);
        $conv = $db->insert('conversations', ['workspace_id' => $this->ws, 'website_id' => $id, 'visitor_id' => $visitor, 'created_at' => $now, 'updated_at' => $now]);
        $db->insert('messages', ['workspace_id' => $this->ws, 'conversation_id' => $conv, 'sender_type' => 'visitor', 'client_message_id' => 'c1', 'body' => 'hello', 'created_at' => $now]);

        $res = $this->api('POST', '/api/v1/integration/disconnect', $cred);
        $this->assertSame(200, $res->status);
        $this->assertTrue($res->data()['data_retained']);
        $this->assertSame(401, $this->api('GET', '/api/v1/integration/config', $cred)->status);
        $this->assertSame(1, (int) $db->value('SELECT COUNT(*) FROM messages'));
        $this->assertSame(1, (int) $db->value('SELECT COUNT(*) FROM conversations'));
        $this->assertSame(1, (int) $db->value('SELECT COUNT(*) FROM websites'));
    }

    public function testSuspendedWorkspaceCredentialsStopWorking(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $cred = $this->pair($this->pairingCode($this->ob, $this->ws, $id), 'https://shop.example.com')['credential'];
        $this->app->db()->exec("UPDATE workspaces SET status = 'suspended' WHERE id = ?", [$this->ws]);
        $this->assertSame(401, $this->api('GET', '/api/v1/integration/config', $cred)->status);
    }

    public function testIntegrationAuthFailuresAreThrottled(): void
    {
        for ($i = 0; $i < 30; $i++) {
            $this->api('GET', '/api/v1/integration/config', 'spk_000000000000.' . str_repeat('B', 43));
        }
        $this->assertSame(429, $this->api('GET', '/api/v1/integration/config', 'spk_000000000000.' . str_repeat('B', 43))->status);
    }

    public function testCredentialsNeverAppearInLogs(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $cred = $this->pair($this->pairingCode($this->ob, $this->ws, $id), 'https://shop.example.com')['credential'];
        $this->app->logger()->error('debug dump', ['header' => 'Authorization: Bearer ' . $cred, 'credential' => $cred, 'note' => "used {$cred}"]);
        $this->assertStringNotContainsString(explode('.', $cred)[1], $this->logContents());
    }

    public function testDashboardSettingsValidationAndOtherBasisAcknowledgement(): void
    {
        $id = $this->createSite($this->ob, $this->ws, 'Shop', 'https://shop.example.com');
        $res = $this->ob->submit("/w/{$this->ws}/websites/{$id}/settings/widget", ['primary_color' => 'blue', 'position' => 'right', 'launcher_label' => 'Chat', 'greeting_title' => 'Hi', 'offset_px' => '20', 'reopen_window_hours' => '24']);
        $this->assertSame(422, $res->status);
        $res = $this->ob->submit("/w/{$this->ws}/websites/{$id}/settings/tracking", ['analytics_enabled' => '1', 'legal_basis' => 'other', 'policy_version' => '2', 'consent_source' => 'widget', 'excluded_paths' => "/checkout", 'session_timeout_minutes' => '30']);
        $this->assertSame(422, $res->status, 'acknowledgement required for other legal basis');
        $res = $this->ob->submit("/w/{$this->ws}/websites/{$id}/settings/tracking", ['analytics_enabled' => '1', 'legal_basis' => 'consent', 'policy_version' => '2', 'consent_source' => 'widget', 'excluded_paths' => "/checkout\n/account", 'session_timeout_minutes' => '30']);
        $this->assertSame(303, $res->status);
        $this->assertSame('analytics', $this->app->db()->value('SELECT tracking_policy FROM websites WHERE id = ?', [$id]));
        $res = $this->ob->submit("/w/{$this->ws}/websites/{$id}/settings/retention", ['events_days' => '0']);
        $this->assertSame(422, $res->status);
        $res = $this->ob->submit("/w/{$this->ws}/websites/{$id}/settings/bogus");
        $this->assertSame(404, $res->status);
    }

    public function testSettingsSchemaDropsUnknownKeys(): void
    {
        $out = SettingsSchema::validate(SettingsSchema::WIDGET, ['enabled' => '0', 'evil' => '<script>'], []);
        $this->assertArrayNotHasKey('evil', $out);
        $this->assertFalse($out['enabled']);
        $this->assertTrue(SettingsSchema::pathMatches('/checkout/step-2', ['/checkout']));
        $this->assertTrue(SettingsSchema::pathMatches('/WP-LOGIN.PHP', ['/wp-login.php']));
        $this->assertFalse(SettingsSchema::pathMatches('/checkouts-guide', ['/checkout']));
    }

    public function testWebsiteDeletionRequiresExactNameAndIsScoped(): void
    {
        $a = $this->createSite($this->ob, $this->ws, 'Site A', 'https://a.example.com');
        $b = $this->createSite($this->ob, $this->ws, 'Site B', 'https://b.example.com');
        $this->assertSame(422, $this->ob->submit("/w/{$this->ws}/websites/{$a}/delete", ['confirm_name' => 'site a'])->status);
        $this->assertSame(303, $this->ob->submit("/w/{$this->ws}/websites/{$a}/delete", ['confirm_name' => 'Site A'])->status);
        $this->assertSame([$b], array_map('intval', array_column($this->app->db()->all('SELECT id FROM websites'), 'id')));
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM website_settings'));
    }
}
