<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Admin\PlatformSettings;
use Signalpost\Auth\Mailer;
use Signalpost\Licensing\AccessService;
use Signalpost\Tests\Browser;
use Signalpost\Tests\TestCase;
use Signalpost\Tests\WidgetFixtures;

final class ActivationCodeTest extends TestCase
{
    use WidgetFixtures;

    private Browser $admin;
    private int $adminId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->adminId = $this->makeUser('root@example.com', true);
        $this->admin = $this->loginAs('root@example.com');
    }

    /** @return list<string> */
    private function generate(int $months, int $qty = 1, string $note = 'test'): array
    {
        $res = $this->admin->submit('/admin/codes', ['duration_months' => (string) $months, 'quantity' => (string) $qty, 'note' => $note]);
        $this->assertSame(200, $res->status, substr($res->body, 0, 300));
        preg_match('#<pre class="recovery-codes" data-copy-source>([^<]+)</pre>#', $res->body, $m);
        return explode("\n", trim($m[1]));
    }

    private function register(string $email, ?string $code): \Signalpost\Http\Response
    {
        $b = $this->client();
        $b->get('/register');
        return $b->post('/register', ['form' => ['_csrf' => $b->cookies['sp_csrf'], 'email' => $email, 'display_name' => 'User', 'workspace_name' => 'User Co',
            'password' => 'user-password-123', 'password_confirm' => 'user-password-123'] + ($code !== null ? ['activation_code' => $code] : [])]);
    }

    private function signupVerified(string $email, string $code): int
    {
        $this->app->get(PlatformSettings::class)->update(['require_email_verification' => false]);
        $res = $this->register($email, $code);
        $this->assertSame(303, $res->status, substr($res->body, 0, 400));
        return (int) $this->app->db()->value('SELECT id FROM users WHERE email = ?', [$email]);
    }

    public function testAdminGeneratesCodesShownOnceAndStoredHashed(): void
    {
        $codes = $this->generate(3, 2, 'Acme');
        $this->assertCount(2, $codes);
        foreach ($codes as $c) {
            $this->assertMatchesRegularExpression('/^AC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/', $c);
        }
        $dump = json_encode($this->app->db()->all('SELECT * FROM activation_codes')) . json_encode($this->app->db()->all('SELECT * FROM audit_logs'));
        $this->assertStringNotContainsString(str_replace(['AC-', '-'], '', $codes[0]), $dump, 'plaintext never stored');
        $this->assertStringNotContainsString(str_replace(['AC-', '-'], '', $codes[0]), $this->admin->get('/admin/codes')->body, 'shown once only');
        $this->assertStringContainsString(substr($codes[0], -4), $this->admin->get('/admin/codes')->body, 'hint visible');
        $this->assertSame(1, (int) $this->app->db()->value("SELECT COUNT(*) FROM audit_logs WHERE action = 'activation_code.created'"));
        $this->assertSame(422, $this->admin->submit('/admin/codes', ['duration_months' => '2', 'quantity' => '1'])->status, 'only 1/3/6/12 months');
        $this->assertSame(422, $this->admin->submit('/admin/codes', ['duration_months' => '1', 'quantity' => '51'])->status);
        $this->makeUser('mallory@example.com');
        $m = $this->loginAs('mallory@example.com');
        $this->assertSame(404, $m->get('/admin/codes')->status);
        $this->assertSame(404, $m->submit('/admin/codes', ['duration_months' => '12', 'quantity' => '5'])->status);
    }

    public function testSignupRequiresValidCodeAndEachCodeCreatesExactlyOneAccount(): void
    {
        [$code] = $this->generate(6);
        $this->assertSame(422, $this->register('nocode@example.com', null)->status);
        $this->assertSame(422, $this->register('bad@example.com', 'AC-AAAA-BBBB-CCCC-DDDD')->status);
        $this->assertSame(0, (int) $this->app->db()->value("SELECT COUNT(*) FROM users WHERE email IN ('nocode@example.com','bad@example.com')"));

        $id = $this->signupVerified('first@example.com', strtolower(str_replace('-', ' ', $code)));
        $expected = $this->app->clock->now()->modify('+6 months')->format('Y-m-d H:i:s');
        $this->assertSame($expected, $this->app->db()->value('SELECT access_expires_at FROM users WHERE id = ?', [$id]));
        $row = $this->app->db()->one('SELECT * FROM activation_codes');
        $this->assertSame($id, (int) $row['used_by_user_id']);
        $this->assertSame('signup', $row['used_for']);

        $again = $this->register('second@example.com', $code);
        $this->assertSame(422, $again->status, 'a code can never create a second account');
        $this->assertNull($this->app->db()->value("SELECT id FROM users WHERE email = 'second@example.com'"));
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM workspaces WHERE owner_user_id = ?', [$id]));
    }

    public function testCodeRedemptionIsAtomic(): void
    {
        [$code] = $this->generate(1);
        $a = $this->makeUser('a@example.com');
        $b = $this->makeUser('b@example.com');
        $svc = $this->app->get(AccessService::class);
        $this->app->db()->transaction(fn () => $svc->redeem($a, $code, 'signup', '1.1.1.1'));
        $this->expectException(\Signalpost\Core\HttpException::class);
        $this->app->db()->transaction(fn () => $svc->redeem($b, $code, 'signup', '1.1.1.1'));
    }

    public function testExistingEmailDoesNotConsumeCodeOrRevealAccount(): void
    {
        [$code] = $this->generate(1);
        $this->makeUser('taken@example.com');
        $bad = $this->register('taken@example.com', 'AC-AAAA-BBBB-CCCC-DDDD');
        $this->assertSame(422, $bad->status, 'invalid code is rejected the same way for existing and new emails');
        $res = $this->register('taken@example.com', $code);
        $this->assertSame('/login?ok=check_email', $res->headers['Location']);
        $this->assertNull($this->app->db()->value('SELECT used_at FROM activation_codes'), 'code not consumed');
    }

    public function testExpiryLocksAccountAndRenewalReopensSameAccount(): void
    {
        [$code, $renewal, $early] = $this->generate(1, 3);
        $id = $this->signupVerified('owner@example.com', $code);
        $ws = (int) $this->app->db()->value('SELECT id FROM workspaces WHERE owner_user_id = ?', [$id]);
        $b = $this->loginAs('owner@example.com', 'user-password-123');
        $this->assertSame(200, $b->get("/w/{$ws}")->status);

        // Early renewal adds a month to the end of the current period.
        $end = $this->app->db()->value('SELECT access_expires_at FROM users WHERE id = ?', [$id]);
        $this->assertSame(303, $b->submit('/renew', ['activation_code' => $early])->status);
        $this->assertSame((new \DateTimeImmutable($end, new \DateTimeZone('UTC')))->modify('+1 months')->format('Y-m-d H:i:s'), $this->app->db()->value('SELECT access_expires_at FROM users WHERE id = ?', [$id]));

        $this->app->clock->freeze($this->app->clock->now()->modify('+3 months'));
        $b = $this->loginAs('owner@example.com', 'user-password-123');
        $res = $b->get("/w/{$ws}");
        $this->assertSame('/renew', $res->headers['Location'] ?? null, 'expired account is locked to the renewal page');
        $this->assertSame('/renew', $b->get('/account')->headers['Location'] ?? null);
        $api = $b->api('GET', "/api/v1/dashboard/w/{$ws}/conversations");
        $this->assertSame(403, $api->status);
        $this->assertSame('access_expired', json_decode($api->body, true)['error']['code']);
        $this->assertSame(200, $b->get('/renew')->status);
        $this->assertStringContainsString('Your access has ended', $b->get('/renew')->body);

        $this->assertSame(422, $b->submit('/renew', ['activation_code' => $code])->status, 'used code rejected');
        $this->assertSame(303, $b->submit('/renew', ['activation_code' => $renewal])->status);
        $this->assertSame($id, (int) $this->app->db()->value("SELECT used_by_user_id FROM activation_codes WHERE used_for = 'renewal' AND used_at = ?", [$this->app->clock->sql()]), 'same account renewed');
        $this->assertSame($this->app->clock->now()->modify('+1 months')->format('Y-m-d H:i:s'), $this->app->db()->value('SELECT access_expires_at FROM users WHERE id = ?', [$id]), 'new period starts now');
        $this->assertSame(200, $b->get("/w/{$ws}")->status);
        $this->assertSame(2, (int) $this->app->db()->value("SELECT COUNT(*) FROM audit_logs WHERE action = 'user.access_renewed' AND actor_user_id = ?", [$id]), 'early renewal and post-expiry renewal both audited');
    }

    public function testCronSignsOutExpiredAccountsOnceAndSendsReminders(): void
    {
        [$code] = $this->generate(1);
        $id = $this->signupVerified('owner@example.com', $code);
        $b = $this->loginAs('owner@example.com', 'user-password-123');
        $this->app->clock->freeze($this->app->clock->now()->modify('+1 months')->modify('-3 days'));
        $r = $this->app->get(AccessService::class)->enforce();
        $this->assertSame(['expired' => 0, 'reminded' => 1], $r);
        $mail = end($this->app->get(Mailer::class)->sent);
        $this->assertSame('owner@example.com', $mail['to']);
        $this->assertStringContainsString('ends soon', $mail['subject']);
        $this->assertSame(0, $this->app->get(AccessService::class)->enforce()['reminded'], 'one reminder per period');

        $this->app->clock->advance(4 * 86400);
        $this->assertSame(['expired' => 1, 'reminded' => 0], $this->app->get(AccessService::class)->enforce());
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL', [$id]), 'signed out');
        $this->assertSame(0, $this->app->get(AccessService::class)->enforce()['expired'], 'processed once');
        $this->assertSame(1, (int) $this->app->db()->value("SELECT COUNT(*) FROM audit_logs WHERE action = 'user.access_expired'"));
    }

    public function testMembersInheritOwnerAccessAndWidgetsGoOffline(): void
    {
        [$code, $renewal] = $this->generate(1, 2);
        $owner = $this->signupVerified('owner@example.com', $code);
        $ws = (int) $this->app->db()->value('SELECT id FROM workspaces WHERE owner_user_id = ?', [$owner]);
        $agent = $this->makeUser('agent@example.com');
        $this->addMember($ws, $agent);
        $site = $this->connectedSite($ws, $owner);
        $this->assertSame(200, $this->widget($site, 'POST', '/session', null, [])->status);

        $this->app->clock->freeze($this->app->clock->now()->modify('+1 months')->modify('+1 day'));
        $a = $this->loginAs('agent@example.com');
        $res = $a->get("/w/{$ws}");
        $this->assertSame(403, $res->status);
        $this->assertStringContainsString('access has expired', $res->body);
        $this->assertSame(404, $this->widget($site, 'POST', '/session', null, [])->status, 'widget offline while owner expired');

        $this->app->get(PlatformSettings::class)->update(['expired_owner_widgets' => 'keep']);
        $this->assertSame(200, $this->widget($site, 'POST', '/session', null, [])->status, 'setting keeps widgets online');
        $this->app->get(PlatformSettings::class)->update(['expired_owner_widgets' => 'offline']);

        $o = $this->loginAs('owner@example.com', 'user-password-123');
        $o->submit('/renew', ['activation_code' => $renewal]);
        $this->assertSame(200, $a->get("/w/{$ws}")->status, 'members regain access when the owner renews');
        $this->assertSame(200, $this->widget($site, 'POST', '/session', null, [])->status);
    }

    public function testPlatformOwnerNeverExpires(): void
    {
        $this->app->db()->exec('UPDATE users SET access_expires_at = ? WHERE id = ?', [$this->app->clock->sql(-86400), $this->adminId]);
        $this->assertSame(200, $this->loginAs('root@example.com')->get('/admin')->status);
        $this->assertSame(0, $this->app->get(AccessService::class)->enforce()['expired']);
    }

    public function testRevokedCodesAndBruteForceProtection(): void
    {
        [$code, $other] = $this->generate(12, 2);
        $id = (int) $this->app->db()->value('SELECT id FROM activation_codes ORDER BY id LIMIT 1');
        $this->assertSame(303, $this->admin->submit("/admin/codes/{$id}/revoke")->status);
        $this->assertSame(422, $this->register('x@example.com', $code)->status, 'revoked code unusable');
        $this->signupVerified('y@example.com', $other);
        $used = (int) $this->app->db()->value('SELECT id FROM activation_codes WHERE used_at IS NOT NULL');
        $this->assertSame(409, $this->admin->submit("/admin/codes/{$used}/revoke")->status, 'used codes cannot be revoked');

        for ($i = 0; $i < 10; $i++) {
            $this->register("z{$i}@example.com", 'AC-AAAA-BBBB-CCCC-' . sprintf('%04d', $i));
        }
        [$fresh] = $this->generate(1);
        $this->assertSame(429, $this->register('late@example.com', $fresh)->status, 'too many wrong codes from one network');
    }

    public function testMembersNeedOwnCodeWhenConfigured(): void
    {
        $this->app->get(PlatformSettings::class)->update(['members_need_own_code' => true, 'require_email_verification' => false]);
        [$ownerCode, $memberCode] = $this->generate(3, 2);
        $owner = $this->signupVerified('owner@example.com', $ownerCode);
        $ws = (int) $this->app->db()->value('SELECT id FROM workspaces WHERE owner_user_id = ?', [$owner]);
        $o = $this->loginAs('owner@example.com', 'user-password-123');
        $o->submit("/w/{$ws}/members/invite", ['email' => 'new@example.com', 'role' => 'agent']);
        preg_match('#/invite/([A-Za-z0-9_\-]+)#', end($this->app->get(Mailer::class)->sent)['body'], $m);
        $c = $this->client();
        $c->get('/invite/' . $m[1]);
        $form = ['_csrf' => $c->cookies['sp_csrf'], 'display_name' => 'New', 'password' => 'new-password-123', 'password_confirm' => 'new-password-123'];
        $this->assertSame(422, $c->post('/invite/' . $m[1], ['form' => $form])->status);
        $this->assertNull($this->app->db()->value("SELECT id FROM users WHERE email = 'new@example.com'"), 'no account without a code');
        $this->assertSame(303, $c->post('/invite/' . $m[1], ['form' => $form + ['activation_code' => $memberCode]])->status);
        $this->assertNotNull($this->app->db()->value("SELECT access_expires_at FROM users WHERE email = 'new@example.com'"));
    }

    public function testAdminCanExtendWithoutCode(): void
    {
        [$code] = $this->generate(1);
        $id = $this->signupVerified('owner@example.com', $code);
        $before = $this->app->db()->value('SELECT access_expires_at FROM users WHERE id = ?', [$id]);
        $this->assertSame(303, $this->admin->submit("/admin/users/{$id}/extend", ['months' => '3'])->status);
        $this->assertSame((new \DateTimeImmutable($before, new \DateTimeZone('UTC')))->modify('+3 months')->format('Y-m-d H:i:s'), $this->app->db()->value('SELECT access_expires_at FROM users WHERE id = ?', [$id]));
        $this->assertSame(1, (int) $this->app->db()->value("SELECT COUNT(*) FROM audit_logs WHERE action = 'user.access_extended'"));
    }
}
