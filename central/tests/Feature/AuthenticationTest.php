<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Admin\PlatformSettings;
use Signalpost\Auth\Mailer;
use Signalpost\Tests\TestCase;

final class AuthenticationTest extends TestCase
{
    public function testUnauthenticatedUsersCannotAccessDashboard(): void
    {
        $owner = $this->makeUser('owner@example.com', true);
        $ws = $this->makeWorkspace($owner);
        foreach (['/', "/w/{$ws}", "/w/{$ws}/members", '/account', '/admin'] as $path) {
            $res = $this->request('GET', $path);
            $this->assertSame(303, $res->status, $path);
            $this->assertSame('/login', $res->headers['Location'], $path);
        }
        $this->assertSame(401, $this->request('GET', "/w/{$ws}", ['headers' => ['Accept' => 'application/json']])->status);
    }

    public function testWebInstallerRequiresSetupTokenAndWorksOnlyOnce(): void
    {
        $b = $this->client();
        $res = $b->get('/install');
        $this->assertSame(200, $res->status);
        $tokenFile = $this->storage . '/setup-token.txt';
        $this->assertFileExists($tokenFile);
        $this->assertSame('0600', substr(sprintf('%o', fileperms($tokenFile)), -4));
        $token = trim(file_get_contents($tokenFile));
        $this->assertStringNotContainsString($token, $res->body, 'token must never be shown in the page');

        $form = ['_csrf' => $b->cookies['sp_csrf'], 'email' => 'boss@example.com', 'display_name' => 'Boss', 'workspace_name' => 'Main',
            'password' => 'a-long-enough-pass', 'password_confirm' => 'a-long-enough-pass'];
        $this->assertSame(422, $b->post('/install', ['form' => $form + ['setup_token' => 'wrong']])->status);
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM users'));
        $this->assertSame(419, $b->post('/install', ['form' => ['_csrf' => 'x', 'setup_token' => $token] + $form])->status);

        $res = $b->post('/install', ['form' => $form + ['setup_token' => $token]]);
        $this->assertSame(303, $res->status);
        $this->assertFileDoesNotExist($tokenFile);
        $user = $this->app->db()->one('SELECT * FROM users');
        $this->assertSame('boss@example.com', $user['email']);
        $this->assertSame(1, (int) $user['is_platform_admin']);
        $this->assertNotSame('a-long-enough-pass', $user['password_hash']);
        $this->assertTrue(password_verify('a-long-enough-pass', $user['password_hash']));

        $this->assertSame(404, $b->get('/install')->status);
        $this->assertSame(404, $b->post('/install', ['form' => $form + ['setup_token' => $token]])->status);
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM users'));
    }

    public function testLoginIssuesHashedSessionAndRegeneratesToken(): void
    {
        $this->makeUser('ann@example.com');
        $b = $this->loginAs('ANN@example.com');
        $cookie = $b->cookies['sp_session'];
        $this->assertNotEmpty($cookie);
        $row = $this->app->db()->one('SELECT token_hash FROM user_sessions');
        $this->assertSame(hash('sha256', $cookie), $row['token_hash']);
        $this->assertStringNotContainsString($cookie, json_encode($this->app->db()->all('SELECT * FROM user_sessions')));

        // Logging in again from the same browser issues a different token and revokes the old one.
        $b->get('/login');
        $b->post('/login', ['form' => ['email' => 'ann@example.com', 'password' => self::PASSWORD, '_csrf' => $b->csrf]]);
        $this->assertNotSame($cookie, $b->cookies['sp_session']);
        $old = $this->client();
        $old->cookies['sp_session'] = $cookie;
        $this->assertSame(303, $old->get('/account')->status);
    }

    public function testWrongPasswordIsGenericAndThrottled(): void
    {
        $this->makeUser('ann@example.com');
        $b = $this->client();
        $b->get('/login');
        $unknown = $b->post('/login', ['form' => ['email' => 'nobody@example.com', 'password' => 'whatever-123', '_csrf' => $b->cookies['sp_csrf']]]);
        $wrong = $b->post('/login', ['form' => ['email' => 'ann@example.com', 'password' => 'whatever-123', '_csrf' => $b->cookies['sp_csrf']]]);
        $this->assertSame(401, $unknown->status);
        $this->assertSame(401, $wrong->status);
        $this->assertStringContainsString('Invalid email or password', $unknown->body);
        $this->assertStringContainsString('Invalid email or password', $wrong->body);
        for ($i = 0; $i < 4; $i++) {
            $b->post('/login', ['form' => ['email' => 'ann@example.com', 'password' => 'nope-nope-nope', '_csrf' => $b->cookies['sp_csrf']]]);
        }
        $res = $b->post('/login', ['form' => ['email' => 'ann@example.com', 'password' => self::PASSWORD, '_csrf' => $b->cookies['sp_csrf']]]);
        $this->assertSame(429, $res->status, 'correct password must be refused while throttled');
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM user_sessions'));
        $this->assertGreaterThanOrEqual(5, (int) $this->app->db()->value("SELECT COUNT(*) FROM security_events WHERE event_type = 'login_failed'"));
        $this->assertSame(0, (int) $this->app->db()->value("SELECT COUNT(*) FROM security_events WHERE ip_masked = '203.0.113.10'"), 'IPs are stored masked only');

        $this->app->clock->advance(16 * 60);
        $this->assertSame(303, $b->post('/login', ['form' => ['email' => 'ann@example.com', 'password' => self::PASSWORD, '_csrf' => $b->cookies['sp_csrf']]])->status);
    }

    public function testSuspendedAndUnverifiedAccountsCannotSignIn(): void
    {
        $this->makeUser('sus@example.com', false, 'suspended');
        $this->makeUser('unv@example.com', false, 'unverified');
        $b = $this->client();
        $b->get('/login');
        $this->assertSame(403, $b->post('/login', ['form' => ['email' => 'sus@example.com', 'password' => self::PASSWORD, '_csrf' => $b->cookies['sp_csrf']]])->status);
        $this->assertSame(403, $b->post('/login', ['form' => ['email' => 'unv@example.com', 'password' => self::PASSWORD, '_csrf' => $b->cookies['sp_csrf']]])->status);
    }

    public function testLogoutRevokesSession(): void
    {
        $this->makeUser('ann@example.com');
        $b = $this->loginAs('ann@example.com');
        $cookie = $b->cookies['sp_session'];
        $this->assertSame(303, $b->submit('/logout')->status);
        $replay = $this->client();
        $replay->cookies['sp_session'] = $cookie;
        $this->assertSame('/login', $replay->get('/account')->headers['Location']);
    }

    public function testCsrfIsRequiredForStateChanges(): void
    {
        $this->makeUser('ann@example.com');
        $b = $this->loginAs('ann@example.com');
        $this->assertSame(419, $b->post('/workspaces', ['form' => ['name' => 'X']])->status);
        $this->assertSame(419, $b->post('/workspaces', ['form' => ['name' => 'X', '_csrf' => str_repeat('0', 64)]])->status);
        $cross = $b->request('POST', '/workspaces', ['form' => ['name' => 'X', '_csrf' => $b->csrf], 'headers' => ['Origin' => 'https://evil.example']]);
        $this->assertSame(403, $cross->status);
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM workspaces'));
        $this->assertSame(303, $b->submit('/workspaces', ['name' => 'Legit'])->status);
        // Login form itself is CSRF protected (login CSRF).
        $c = $this->client();
        $this->assertSame(419, $c->post('/login', ['form' => ['email' => 'ann@example.com', 'password' => self::PASSWORD]])->status);
    }

    public function testSessionsExpireWhenIdleAndAbsolute(): void
    {
        $this->makeUser('ann@example.com');
        $b = $this->loginAs('ann@example.com');
        $this->assertSame(200, $b->get('/account')->status);
        $this->app->clock->freeze($this->app->clock->now()->modify('+121 minutes'));
        $this->assertSame(303, $b->get('/account')->status, 'idle timeout');

        $this->app->clock->unfreeze();
        $b2 = $this->loginAs('ann@example.com');
        for ($h = 1; $h <= 169; $h++) {
            $this->app->clock->freeze((new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->modify("+{$h} hours"));
            $res = $b2->get('/account');
            if ($res->status !== 200) {
                break;
            }
        }
        $this->assertSame(168, $h, 'absolute lifetime of 168h is enforced even with continuous activity');
    }

    public function testRegistrationRespectsPlatformMode(): void
    {
        $b = $this->client();
        $this->assertSame(403, $b->get('/register')->status, 'default mode is invite_only');
        $b->get('/login');
        $form = ['_csrf' => $b->cookies['sp_csrf'], 'email' => 'new@example.com', 'display_name' => 'New', 'workspace_name' => 'NewCo',
            'password' => 'brand-new-pass-1', 'password_confirm' => 'brand-new-pass-1'];
        $this->assertSame(403, $b->post('/register', ['form' => $form])->status);
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM users'));

        $this->app->get(PlatformSettings::class)->update(['registration_mode' => 'open']);
        $this->assertSame(303, $b->post('/register', ['form' => $form])->status);
        $user = $this->app->db()->one("SELECT * FROM users WHERE email = 'new@example.com'");
        $this->assertSame('unverified', $user['status']);
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM workspace_members WHERE user_id = ? AND role = ?', [$user['id'], 'owner']));

        // Cannot sign in before verification.
        $this->assertSame(403, $b->post('/login', ['form' => ['email' => 'new@example.com', 'password' => 'brand-new-pass-1', '_csrf' => $b->cookies['sp_csrf']]])->status);

        $mail = $this->app->get(Mailer::class)->sent;
        $this->assertCount(1, $mail);
        preg_match('#token=([A-Za-z0-9_\-]+)#', $mail[0]['body'], $m);
        $this->assertSame(200, $b->get('/verify-email?token=' . $m[1])->status, 'GET does not consume the token');
        $this->assertSame('unverified', $this->app->db()->value('SELECT status FROM users WHERE id = ?', [$user['id']]));
        $this->assertSame(303, $b->post('/verify-email', ['form' => ['token' => $m[1], '_csrf' => $b->cookies['sp_csrf']]])->status);
        $this->assertSame('active', $this->app->db()->value('SELECT status FROM users WHERE id = ?', [$user['id']]));
        $this->assertSame(400, $b->post('/verify-email', ['form' => ['token' => $m[1], '_csrf' => $b->cookies['sp_csrf']]])->status, 'single use');
        $this->loginAs('new@example.com', 'brand-new-pass-1');

        // Registering an existing address does not reveal that it exists and creates nothing.
        $again = $b->post('/register', ['form' => $form]);
        $this->assertSame('/login?ok=check_email', $again->headers['Location']);
        $this->assertSame(1, (int) $this->app->db()->value("SELECT COUNT(*) FROM users WHERE email = 'new@example.com'"));
    }

    public function testPasswordResetFlow(): void
    {
        $id = $this->makeUser('ann@example.com');
        $other = $this->loginAs('ann@example.com');
        $b = $this->client();
        $b->get('/forgot-password');
        $r1 = $b->post('/forgot-password', ['form' => ['email' => 'ghost@example.com', '_csrf' => $b->cookies['sp_csrf']]]);
        $r2 = $b->post('/forgot-password', ['form' => ['email' => 'ann@example.com', '_csrf' => $b->cookies['sp_csrf']]]);
        $this->assertSame($r1->headers['Location'], $r2->headers['Location'], 'no account enumeration');
        $mail = $this->app->get(Mailer::class)->sent;
        $this->assertCount(1, $mail);
        preg_match('#token=([A-Za-z0-9_\-]+)#', $mail[0]['body'], $m);
        $token = $m[1];
        $this->assertNull($this->app->db()->value('SELECT id FROM user_tokens WHERE token_hash = ?', [$token]), 'token stored hashed only');

        $bad = $b->post('/reset-password', ['form' => ['token' => $token, 'password' => 'short', 'password_confirm' => 'short', '_csrf' => $b->cookies['sp_csrf']]]);
        $this->assertSame(422, $bad->status);
        $ok = $b->post('/reset-password', ['form' => ['token' => $token, 'password' => 'my-new-password-1', 'password_confirm' => 'my-new-password-1', '_csrf' => $b->cookies['sp_csrf']]]);
        $this->assertSame(303, $ok->status);
        $this->assertSame(303, $other->get('/account')->status, 'existing sessions revoked after reset');
        $reuse = $b->post('/reset-password', ['form' => ['token' => $token, 'password' => 'another-pass-123', 'password_confirm' => 'another-pass-123', '_csrf' => $b->cookies['sp_csrf']]]);
        $this->assertSame(400, $reuse->status, 'single use');
        $this->loginAs('ann@example.com', 'my-new-password-1');
    }

    public function testExpiredResetTokenIsRejected(): void
    {
        $this->makeUser('ann@example.com');
        $b = $this->client();
        $b->get('/forgot-password');
        $b->post('/forgot-password', ['form' => ['email' => 'ann@example.com', '_csrf' => $b->cookies['sp_csrf']]]);
        preg_match('#token=([A-Za-z0-9_\-]+)#', $this->app->get(Mailer::class)->sent[0]['body'], $m);
        $this->app->clock->advance(3601);
        $res = $b->post('/reset-password', ['form' => ['token' => $m[1], 'password' => 'my-new-password-1', 'password_confirm' => 'my-new-password-1', '_csrf' => $b->cookies['sp_csrf']]]);
        $this->assertSame(400, $res->status);
    }

    public function testPasswordChangeRevokesOtherSessions(): void
    {
        $this->makeUser('ann@example.com');
        $phone = $this->loginAs('ann@example.com');
        $laptop = $this->loginAs('ann@example.com');
        $res = $laptop->submit('/account/password', ['current_password' => self::PASSWORD, 'new_password' => 'fresh-password-42', 'new_password_confirm' => 'fresh-password-42']);
        $this->assertSame(303, $res->status);
        $this->assertSame(200, $laptop->get('/account')->status);
        $this->assertSame(303, $phone->get('/account')->status);
        $wrong = $laptop->submit('/account/password', ['current_password' => 'nope', 'new_password' => 'fresh-password-43', 'new_password_confirm' => 'fresh-password-43']);
        $this->assertSame(422, $wrong->status);
    }

    public function testUserCannotRevokeAnotherUsersSession(): void
    {
        $this->makeUser('ann@example.com');
        $this->makeUser('bob@example.com');
        $ann = $this->loginAs('ann@example.com');
        $bob = $this->loginAs('bob@example.com');
        $bobSession = (int) $this->app->db()->value("SELECT s.id FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'bob@example.com'");
        $this->assertSame(404, $ann->submit("/account/sessions/{$bobSession}/revoke")->status);
        $this->assertSame(200, $bob->get('/account')->status);
    }

    public function testCliOwnerCreationRefusedWhenUsersExist(): void
    {
        $this->makeUser('ann@example.com');
        $this->expectException(\Signalpost\Core\HttpException::class);
        $this->app->get(\Signalpost\Auth\AuthService::class)->createPlatformOwner('x@example.com', 'long-password-1', 'X', 'W');
    }

    public function testAuditLogsNeverContainPasswords(): void
    {
        $this->makeUser('ann@example.com');
        $b = $this->loginAs('ann@example.com');
        $b->submit('/account/password', ['current_password' => self::PASSWORD, 'new_password' => 'fresh-password-42', 'new_password_confirm' => 'fresh-password-42']);
        $dump = json_encode($this->app->db()->all('SELECT * FROM audit_logs'));
        $this->assertStringContainsString('user.password_changed', $dump);
        $this->assertStringNotContainsString('fresh-password-42', $dump);
        $this->assertStringNotContainsString(self::PASSWORD, $dump);
        $this->assertStringNotContainsString('fresh-password-42', $this->logContents());
    }
}
