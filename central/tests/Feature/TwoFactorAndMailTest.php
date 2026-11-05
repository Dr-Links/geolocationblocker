<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Auth\Mailer;
use Signalpost\Security\Totp;
use Signalpost\Tests\Browser;
use Signalpost\Tests\TestCase;

final class TwoFactorAndMailTest extends TestCase
{
    private function enable(Browser $b): array
    {
        $page = $b->submit('/account/2fa/setup')->body;
        preg_match('#<div class="secret-box" data-copy-source>([A-Z2-7 ]+)</div>#', $page, $m);
        $this->assertNotEmpty($m, substr(strip_tags($page), 0, 600));
        $secret = str_replace(' ', '', $m[1]);
        $this->assertSame(422, $b->submit('/account/2fa/enable', ['code' => '000000'])->status);
        $res = $b->submit('/account/2fa/enable', ['code' => Totp::code($secret, intdiv($this->app->clock->timestamp(), 30))]);
        $this->assertSame(200, $res->status);
        preg_match('#<pre class="recovery-codes" data-copy-source>([^<]+)</pre>#', $res->body, $rc);
        return [$secret, explode("\n", trim($rc[1]))];
    }

    private function passwordStep(string $email): Browser
    {
        $b = $this->client();
        $b->get('/login');
        $res = $b->post('/login', ['form' => ['email' => $email, 'password' => self::PASSWORD, '_csrf' => $b->cookies['sp_csrf']]]);
        $this->assertSame('/login/2fa', $res->headers['Location']);
        return $b;
    }

    public function testEnableStoresSecretEncryptedAndShowsRecoveryCodesOnce(): void
    {
        $id = $this->makeUser('ann@example.com');
        $other = $this->loginAs('ann@example.com');
        $b = $this->loginAs('ann@example.com');
        [$secret, $codes] = $this->enable($b);
        $this->assertCount(10, $codes);
        $row = $this->app->db()->one('SELECT totp_secret, totp_enabled_at FROM users WHERE id = ?', [$id]);
        $this->assertStringStartsWith('v1:', $row['totp_secret']);
        $dump = json_encode($this->app->db()->all('SELECT * FROM users')) . json_encode($this->app->db()->all('SELECT * FROM user_recovery_codes')) . json_encode($this->app->db()->all('SELECT * FROM audit_logs'));
        $this->assertStringNotContainsString($secret, $dump);
        $this->assertStringNotContainsString(str_replace('-', '', $codes[0]), $dump);
        $this->assertSame(303, $other->get('/account')->status, 'other sessions end when 2FA is turned on');
        $this->assertStringNotContainsString($codes[0], $b->get('/account')->body, 'shown once');
    }

    public function testLoginRequiresSecondFactorAndRejectsReplay(): void
    {
        $this->makeUser('ann@example.com');
        [$secret] = $this->enable($this->loginAs('ann@example.com'));
        $sessionsBefore = (int) $this->app->db()->value('SELECT COUNT(*) FROM user_sessions');

        $b = $this->passwordStep('ann@example.com');
        $this->assertSame($sessionsBefore, (int) $this->app->db()->value('SELECT COUNT(*) FROM user_sessions'), 'password alone creates no session');
        $this->assertSame(303, $b->get('/account')->status);
        $this->assertSame(422, $b->post('/login/2fa', ['form' => ['code' => '123456', '_csrf' => $b->cookies['sp_csrf']]])->status);
        $this->app->clock->advance(30);
        $code = Totp::code($secret, intdiv($this->app->clock->timestamp(), 30));
        $this->assertSame(303, $b->post('/login/2fa', ['form' => ['code' => $code, '_csrf' => $b->cookies['sp_csrf']]])->status);
        $this->assertSame(200, $b->get('/account')->status);

        $c = $this->passwordStep('ann@example.com');
        $this->assertSame(422, $c->post('/login/2fa', ['form' => ['code' => $code, '_csrf' => $c->cookies['sp_csrf']]])->status, 'code replay rejected');
    }

    public function testRecoveryCodeWorksOnceAndPendingLoginExpires(): void
    {
        $this->makeUser('ann@example.com');
        [, $codes] = $this->enable($this->loginAs('ann@example.com'));
        $b = $this->passwordStep('ann@example.com');
        $this->assertSame(303, $b->post('/login/2fa', ['form' => ['code' => strtoupper($codes[3]), '_csrf' => $b->cookies['sp_csrf']]])->status);
        $c = $this->passwordStep('ann@example.com');
        $this->assertSame(422, $c->post('/login/2fa', ['form' => ['code' => $codes[3], '_csrf' => $c->cookies['sp_csrf']]])->status);

        $d = $this->passwordStep('ann@example.com');
        $this->app->clock->advance(301);
        $res = $d->post('/login/2fa', ['form' => ['code' => $codes[4], '_csrf' => $d->cookies['sp_csrf']]]);
        $this->assertSame('/login', $res->headers['Location'] ?? null, 'expired pending sign-in');
        $this->assertSame(303, $this->client()->get('/login/2fa')->status, 'no pending cookie');
    }

    public function testSecondFactorIsThrottled(): void
    {
        $this->makeUser('ann@example.com');
        [$secret] = $this->enable($this->loginAs('ann@example.com'));
        $b = $this->passwordStep('ann@example.com');
        for ($i = 0; $i < 5; $i++) {
            $b->post('/login/2fa', ['form' => ['code' => sprintf('%06d', $i), '_csrf' => $b->cookies['sp_csrf']]]);
        }
        $this->app->clock->advance(30);
        $good = Totp::code($secret, intdiv($this->app->clock->timestamp(), 30));
        $this->assertSame(429, $b->post('/login/2fa', ['form' => ['code' => $good, '_csrf' => $b->cookies['sp_csrf']]])->status);
    }

    public function testDisableNeedsPasswordAndCodeAndAdminResetIsAudited(): void
    {
        $id = $this->makeUser('ann@example.com');
        $b = $this->loginAs('ann@example.com');
        [$secret] = $this->enable($b);
        $this->app->clock->advance(30);
        $code = Totp::code($secret, intdiv($this->app->clock->timestamp(), 30));
        $this->assertSame(422, $b->submit('/account/2fa/disable', ['password' => 'wrong', 'code' => $code])->status);
        $this->assertNotNull($this->app->db()->value('SELECT totp_enabled_at FROM users WHERE id = ?', [$id]));

        $this->makeUser('mallory@example.com');
        $this->assertSame(404, $this->loginAs('mallory@example.com')->submit("/admin/users/{$id}/reset-2fa")->status);
        $this->makeUser('root@example.com', true);
        $this->assertSame(303, $this->loginAs('root@example.com')->submit("/admin/users/{$id}/reset-2fa")->status);
        $this->assertNull($this->app->db()->value('SELECT totp_enabled_at FROM users WHERE id = ?', [$id]));
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM user_recovery_codes'));
        $this->assertSame(1, (int) $this->app->db()->value("SELECT COUNT(*) FROM audit_logs WHERE action = 'user.2fa_reset'"));
        $this->loginAs('ann@example.com'); // plain password sign-in works again
    }

    public function testSmtpTransportDeliversWithAuthAndDotStuffing(): void
    {
        $port = random_int(20000, 40000);
        $log = sys_get_temp_dir() . '/sp-smtp-' . bin2hex(random_bytes(4)) . '.log';
        $proc = proc_open(['php', __DIR__ . '/../fixtures/fake-smtp.php', (string) $port, $log], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        usleep(400000);
        try {
            $app = $this->makeApp(['mail' => ['transport' => 'smtp', 'from' => 'chat@example.com', 'smtp' => ['host' => '127.0.0.1', 'port' => $port, 'encryption' => 'none', 'username' => 'chat@example.com', 'password' => 'right-pass']]]);
            $ok = $app->get(Mailer::class)->send('ann@example.com', 'Hello', "Line one\n.leading dot\nend");
            $this->assertTrue($ok);
            $transcript = (string) file_get_contents($log);
            $this->assertStringContainsString('MAIL FROM:<chat@example.com>', $transcript);
            $this->assertStringContainsString('RCPT TO:<ann@example.com>', $transcript);
            $this->assertStringContainsString('Subject: =?UTF-8?B?' . base64_encode('Hello') . '?=', $transcript);
            $this->assertStringContainsString(base64_encode("Line one\n.leading dot\nend"), str_replace("\r\n", '', $transcript));
            $this->assertStringNotContainsString('right-pass', $this->logContents());
        } finally {
            proc_terminate($proc);
            @unlink($log);
        }
    }

    public function testSmtpAuthFailureReturnsFalseWithoutLeakingPassword(): void
    {
        $port = random_int(20000, 40000);
        $log = sys_get_temp_dir() . '/sp-smtp-' . bin2hex(random_bytes(4)) . '.log';
        $proc = proc_open(['php', __DIR__ . '/../fixtures/fake-smtp.php', (string) $port, $log], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        usleep(400000);
        try {
            $app = $this->makeApp(['mail' => ['transport' => 'smtp', 'smtp' => ['host' => '127.0.0.1', 'port' => $port, 'encryption' => 'none', 'username' => 'x', 'password' => 'WRONG-secret-pw']]]);
            $this->assertFalse($app->get(Mailer::class)->send('ann@example.com', 'Hi', 'Body'));
            $logText = $this->logContents();
            $this->assertStringContainsString('SMTP delivery failed', $logText);
            $this->assertStringNotContainsString('WRONG-secret-pw', $logText);
        } finally {
            proc_terminate($proc);
            @unlink($log);
        }
    }
}
