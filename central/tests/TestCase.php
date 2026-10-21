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
