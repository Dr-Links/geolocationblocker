<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Tests\TestCase;

/** Uploading new code over an installed site whose database is one migration behind. */
final class UpgradeTest extends TestCase
{
    private function rollBackMigration0009(): void
    {
        $pdo = $this->app->db()->pdo();
        $pdo->exec('DROP TABLE activation_codes');
        $pdo->exec('ALTER TABLE users DROP KEY idx_users_access_expires, DROP COLUMN access_expires_at, DROP COLUMN access_reminder_sent_at, DROP COLUMN access_expiry_processed_at');
        $pdo->exec("DELETE FROM schema_migrations WHERE version = '0009_activation_codes'");
    }

    protected function tearDown(): void
    {
        // Leave the schema complete for the other tests even if an assertion failed.
        if ($this->app->migrator()->pending() !== []) {
            $this->app->migrator()->migrate();
        }
        parent::tearDown();
    }

    public function testSignedInUsersAreSentToSecureUpgradeAndUpgradeKeepsAccountsUnlimited(): void
    {
        $owner = $this->makeUser('owner@example.com', true);
        $agent = $this->makeUser('agent@example.com');
        $ws = $this->makeWorkspace($owner);
        $this->addMember($ws, $agent);
        $b = $this->loginAs('owner@example.com');
        $this->rollBackMigration0009();

        foreach (['/', "/w/{$ws}", '/admin'] as $p) {
            $res = $b->get($p);
            $this->assertSame('/upgrade', $res->headers['Location'] ?? null, $p);
        }
        $api = $b->api('GET', "/api/v1/dashboard/w/{$ws}/conversations");
        $this->assertSame(503, $api->status);
        $this->assertSame('upgrade_required', json_decode($api->body, true)['error']['code']);

        $u = $this->client();
        $page = $u->get('/upgrade');
        $this->assertSame(200, $page->status);
        $this->assertStringContainsString('0009_activation_codes', $page->body);
        $tokenFile = $this->storage . '/upgrade-token.txt';
        $this->assertFileExists($tokenFile);
        $this->assertSame('0600', substr(sprintf('%o', fileperms($tokenFile)), -4));
        $token = trim(file_get_contents($tokenFile));
        $this->assertStringNotContainsString($token, $page->body);

        $this->assertSame(419, $u->post('/upgrade', ['form' => ['upgrade_token' => $token]])->status, 'CSRF required');
        $this->assertSame(422, $u->post('/upgrade', ['form' => ['_csrf' => $u->cookies['sp_csrf'], 'upgrade_token' => 'wrong']])->status);
        $this->assertSame(['0009_activation_codes'], $this->app->migrator()->pending(), 'nothing applied with a wrong token');

        $res = $u->post('/upgrade', ['form' => ['_csrf' => $u->cookies['sp_csrf'], 'upgrade_token' => $token]]);
        $this->assertSame('/login?ok=upgraded', $res->headers['Location']);
        $this->assertSame([], $this->app->migrator()->pending());
        $this->assertFileDoesNotExist($tokenFile);
        $this->assertSame(404, $this->client()->get('/upgrade')->status, 'disabled once up to date');

        // Existing accounts keep working without a time limit; the session survived the update.
        $this->assertSame(200, $b->get("/w/{$ws}")->status);
        $this->assertSame(200, $this->loginAs('agent@example.com')->get("/w/{$ws}")->status);
        $this->assertNull($this->app->db()->value('SELECT access_expires_at FROM users WHERE id = ?', [$agent]));
        $this->assertSame(1, (int) $this->app->db()->value("SELECT COUNT(*) FROM audit_logs WHERE action = 'platform.migrated'"));
    }

    public function testUpgradePageIsNotAvailableWhenUpToDate(): void
    {
        $this->makeUser('owner@example.com', true);
        $this->assertSame(404, $this->client()->get('/upgrade')->status);
        $this->assertSame(404, $this->client()->post('/upgrade', ['form' => ['upgrade_token' => 'x']])->status);
        $this->assertFileDoesNotExist($this->storage . '/upgrade-token.txt');
    }
}
