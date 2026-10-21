<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Tests\TestCase;

final class FoundationTest extends TestCase
{
    public function testMigrationsAreAppliedAndNonePending(): void
    {
        $this->assertSame([], $this->app->migrator()->pending());
        $tables = array_map(fn ($r) => array_values($r)[0], $this->app->db()->all('SHOW TABLES'));
        foreach (['users', 'workspaces', 'workspace_members', 'audit_logs', 'schema_migrations'] as $t) {
            $this->assertContains($t, $tables);
        }
    }

    public function testMigrateIsIdempotent(): void
    {
        $this->assertSame([], $this->app->migrator()->migrate());
    }

    public function testHealthEndpoint(): void
    {
        $res = $this->request('GET', '/api/v1/health');
        $this->assertSame(200, $res->status);
        $this->assertSame(['status' => 'ok', 'database' => 'ok'], $res->data());
        $this->assertSame('nosniff', $res->headers['X-Content-Type-Options']);
    }

    public function testUnknownApiRouteReturnsJson404(): void
    {
        $res = $this->request('GET', '/api/v1/nope');
        $this->assertSame(404, $res->status);
        $this->assertSame('not_found', json_decode($res->body, true)['error']['code']);
    }

    public function testWrongMethodReturns405(): void
    {
        $this->assertSame(405, $this->request('DELETE', '/api/v1/health')->status);
    }

    public function testOversizedBodyIsRejected(): void
    {
        $res = $this->request('POST', '/api/v1/health', ['raw' => str_repeat('a', 70000)]);
        $this->assertSame(413, $res->status);
    }

    public function testUnhandledErrorsAreGenericAndLoggedWithoutSecrets(): void
    {
        $this->app->router()->get('/api/v1/boom', [self::class, 'boom']);
        $this->app->set(self::class, $this);
        $res = $this->request('GET', '/api/v1/boom');
        $this->assertSame(500, $res->status);
        $this->assertStringNotContainsString('SQLSTATE', $res->body);
        $this->assertStringNotContainsString('.php', $res->body);
        $this->assertStringNotContainsString('s3cr3t', $res->body);
        $log = $this->logContents();
        $this->assertStringContainsString('Unhandled exception', $log);
        $this->assertStringNotContainsString('s3cr3t-value', $log);
    }

    public function boom(): never
    {
        throw new \RuntimeException('SQLSTATE failure with password=s3cr3t-value in /var/www/x.php');
    }

    public function testHttpsIsEnforcedWhenConfigured(): void
    {
        $app = $this->makeApp(['security' => ['force_https' => true]]);
        $browser = new \Signalpost\Tests\Browser($app);
        $this->assertSame(403, $browser->get('/api/v1/health')->status);
        $this->assertSame(200, $browser->get('/api/v1/health', ['secure' => true])->status);
        // Spoofed X-Forwarded-Proto from an untrusted peer is ignored.
        $this->assertSame(403, $browser->get('/api/v1/health', ['headers' => ['X-Forwarded-Proto' => 'https']])->status);
    }

    public function testFreshDatabaseRedirectsToInstaller(): void
    {
        // Simulate a brand-new installation by pointing at an empty schema-less table set.
        $this->app->db()->pdo()->exec('RENAME TABLE users TO users_tmp_fresh');
        try {
            $res = $this->request('GET', '/login');
            $this->assertSame(303, $res->status);
            $this->assertSame('/install', $res->headers['Location']);
            $api = $this->request('GET', '/api/v1/dashboard/w/1/conversations');
            $this->assertNotSame(303, $api->status, 'APIs never redirect to the installer');
            $this->assertStringStartsWith('application/json', $api->headers['Content-Type']);
        } finally {
            $this->app->db()->pdo()->exec('RENAME TABLE users_tmp_fresh TO users');
        }
    }

    public function testSecurityHeadersOnHtml(): void
    {
        $res = $this->request('GET', '/definitely-missing');
        $this->assertSame(404, $res->status);
        $this->assertStringContainsString("frame-ancestors 'none'", $res->headers['Content-Security-Policy']);
        $this->assertSame('DENY', $res->headers['X-Frame-Options']);
    }
}
