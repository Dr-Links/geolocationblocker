<?php

declare(strict_types=1);

namespace Signalpost\Tests;

use Signalpost\Core\App;
use Signalpost\Core\Database;
use Signalpost\Http\Request;
use Signalpost\Http\Response;

/**
 * Base test case. Runs against a real MySQL/MariaDB test database: the schema
 * is rebuilt from migrations once per run and all tables are emptied before
 * each test. NEVER point SP_TEST_DB_NAME at a database with real data.
 */
abstract class TestCase extends \PHPUnit\Framework\TestCase
{
    private static bool $schemaReady = false;
    protected App $app;
    protected string $storage;

    public static function configForTests(string $storage): array
    {
        return [
            'app' => ['url' => 'http://chat.test', 'env' => 'testing', 'key' => str_repeat('ab', 32)],
            'db' => [
                'host' => getenv('SP_TEST_DB_HOST') ?: '127.0.0.1',
                'port' => (int) (getenv('SP_TEST_DB_PORT') ?: 3306),
                'name' => getenv('SP_TEST_DB_NAME') ?: 'lc_test',
                'user' => getenv('SP_TEST_DB_USER') ?: 'lc',
                'password' => getenv('SP_TEST_DB_PASSWORD') ?: '',
            ],
            'security' => ['force_https' => false],
            'mail' => ['transport' => 'memory'],
            'paths' => ['storage' => $storage],
        ];
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->storage = sys_get_temp_dir() . '/sp-test-' . bin2hex(random_bytes(4));
        @mkdir($this->storage . '/logs', 0777, true);
        $this->app = $this->makeApp();
        $db = $this->app->db();
        if (!self::$schemaReady) {
            self::resetSchema($db);
            $this->app->migrator()->migrate();
            self::$schemaReady = true;
        }
        self::truncateAll($db);
    }

    protected function tearDown(): void
    {
        $this->removeDir($this->storage);
        parent::tearDown();
    }

    protected function makeApp(array $override = []): App
    {
        $config = array_replace_recursive(self::configForTests($this->storage), $override);
        return ($GLOBALS['signalpost_factory'])($config);
    }

    private static function resetSchema(Database $db): void
    {
        $name = (string) $db->value('SELECT DATABASE()');
        if (!preg_match('/test/i', $name)) {
            throw new \RuntimeException('Refusing to reset a database whose name does not contain "test".');
        }
        $db->pdo()->exec('SET FOREIGN_KEY_CHECKS=0');
        foreach ($db->all('SHOW TABLES') as $row) {
            $db->pdo()->exec('DROP TABLE `' . str_replace('`', '', (string) array_values($row)[0]) . '`');
        }
        $db->pdo()->exec('SET FOREIGN_KEY_CHECKS=1');
    }

    private static function truncateAll(Database $db): void
    {
        $db->pdo()->exec('SET FOREIGN_KEY_CHECKS=0');
        foreach ($db->all('SHOW TABLES') as $row) {
            $table = (string) array_values($row)[0];
            if ($table !== 'schema_migrations') {
                $db->pdo()->exec('TRUNCATE TABLE `' . str_replace('`', '', $table) . '`');
            }
        }
        $db->pdo()->exec('SET FOREIGN_KEY_CHECKS=1');
    }

    public const PASSWORD = 'correct-horse-battery-9';

    protected function makeUser(string $email, bool $admin = false, string $status = 'active', string $name = 'Test User'): int
    {
        $id = $this->app->get(\Signalpost\Auth\AuthService::class)->createInvitedUser($email, self::PASSWORD, $name);
        $this->app->db()->exec('UPDATE users SET is_platform_admin = ?, status = ? WHERE id = ?', [$admin ? 1 : 0, $status, $id]);
        return $id;
    }

    protected function makeWorkspace(int $ownerId, string $name = 'Workspace'): int
    {
        return $this->app->get(\Signalpost\Tenancy\WorkspaceService::class)->create($ownerId, $name);
    }

    protected function addMember(int $workspaceId, int $userId, string $role = 'agent'): int
    {
        $now = $this->app->clock->sql();
        return $this->app->db()->insert('workspace_members', [
            'workspace_id' => $workspaceId, 'user_id' => $userId, 'role' => $role, 'status' => 'active', 'created_at' => $now, 'updated_at' => $now,
        ]);
    }

    /** Signs in through the real login form and returns a browser with session cookie and CSRF token. */
    protected function loginAs(string $email, string $password = self::PASSWORD): Browser
    {
        $b = $this->client();
        $b->get('/login');
        $res = $b->post('/login', ['form' => ['email' => $email, 'password' => $password, '_csrf' => $b->cookies['sp_csrf'] ?? '']]);
        $this->assertSame(303, $res->status, 'login failed: ' . substr($res->body, 0, 300));
        $b->csrf = (string) $this->app->db()->value('SELECT csrf_token FROM user_sessions WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY id DESC LIMIT 1', [strtolower($email)]);
        return $b;
    }

    protected function client(): Browser
    {
        return new Browser($this->app);
    }

    protected function request(string $method, string $path, array $opts = []): Response
    {
        return $this->client()->request($method, $path, $opts);
    }

    protected function logContents(): string
    {
        $out = '';
        foreach (glob($this->storage . '/logs/*.log') ?: [] as $f) {
            $out .= file_get_contents($f);
        }
        return $out;
    }

    private function removeDir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($it as $f) {
            $f->isDir() ? rmdir($f->getPathname()) : unlink($f->getPathname());
        }
        rmdir($dir);
    }
}
