<?php

declare(strict_types=1);

namespace Signalpost\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Signalpost\Core\Config;
use Signalpost\Core\HttpException;
use Signalpost\Core\Logger;
use Signalpost\Core\Validator;
use Signalpost\Http\ClientIp;
use Signalpost\Http\Request;
use Signalpost\Http\Router;
use Signalpost\Security\Tokens;

final class FoundationUnitTest extends TestCase
{
    public function testConfigMergesOverDefaults(): void
    {
        $c = Config::fromArray(['db' => ['name' => 'x'], 'security' => ['trusted_proxies' => ['10.0.0.1']]]);
        $this->assertSame('x', $c->get('db.name'));
        $this->assertSame(3306, $c->get('db.port'));
        $this->assertSame(['10.0.0.1'], $c->get('security.trusted_proxies'));
        $this->assertFalse($c->isConfigured(), 'missing key means not configured');
    }

    public function testLoggerRedactsSensitiveKeysAndCredentialShapes(): void
    {
        $out = Logger::redact([
            'password' => 'hunter2hunter2',
            'nested' => ['token' => 'abc', 'Authorization' => 'Bearer xyz'],
            'note' => 'used key spk_ab12cd34.SECRETVALUE_123 and Bearer eyJabc.def',
            'body' => 'full message text',
            'count' => 3,
        ]);
        $json = json_encode($out);
        $this->assertStringNotContainsString('hunter2', $json);
        $this->assertStringNotContainsString('SECRETVALUE', $json);
        $this->assertStringNotContainsString('eyJabc', $json);
        $this->assertStringNotContainsString('full message text', $json);
        $this->assertSame(3, $out['count']);
    }

    public function testClientIpIgnoresForwardedHeadersFromUntrustedPeers(): void
    {
        $req = new Request('GET', '/', headers: ['x-forwarded-for' => '1.2.3.4'], remoteAddr: '198.51.100.7');
        $this->assertSame('198.51.100.7', ClientIp::resolve($req, []));
        $this->assertSame('198.51.100.7', ClientIp::resolve($req, ['10.0.0.0/8']));
    }

    public function testClientIpUsesFirstUntrustedHopBehindTrustedProxy(): void
    {
        $req = new Request('GET', '/', headers: ['x-forwarded-for' => '9.9.9.9, 1.2.3.4, 10.0.0.5'], remoteAddr: '10.0.0.2');
        // Spoofed leftmost value 9.9.9.9 is ignored: the rightmost untrusted hop wins.
        $this->assertSame('1.2.3.4', ClientIp::resolve($req, ['10.0.0.0/8']));
    }

    public function testCidrMatchingAndMasking(): void
    {
        $this->assertTrue(ClientIp::inRange('192.168.1.77', '192.168.1.0/24'));
        $this->assertFalse(ClientIp::inRange('192.168.2.1', '192.168.1.0/24'));
        $this->assertTrue(ClientIp::inRange('2001:db8::1', '2001:db8::/32'));
        $this->assertFalse(ClientIp::inRange('not-an-ip', '0.0.0.0/0'));
        $this->assertSame('203.0.113.0/24', ClientIp::mask('203.0.113.99'));
        $this->assertSame('2001:db8:1::/48', ClientIp::mask('2001:db8:1:2::5'));
    }

    public function testRouterMatchesParamsAndRejectsUnknownAndWrongMethod(): void
    {
        $r = new Router();
        $r->get('/api/v1/things/{id}', ['X', 'y'], 'session');
        $m = $r->match('GET', '/api/v1/things/42');
        $this->assertSame('42', $m['params']['id']);
        $this->assertSame('session', $m['guard']);
        try {
            $r->match('POST', '/api/v1/things/42');
            $this->fail('expected 405');
        } catch (HttpException $e) {
            $this->assertSame(405, $e->status);
        }
        try {
            $r->match('GET', '/api/v1/things/42/../../etc');
            $this->fail('expected 404');
        } catch (HttpException $e) {
            $this->assertSame(404, $e->status);
        }
    }

    public function testTokensAreRandomAndHashesAreStable(): void
    {
        $a = Tokens::random();
        $this->assertNotSame($a, Tokens::random());
        $this->assertGreaterThanOrEqual(43, strlen($a));
        $this->assertSame(Tokens::hash($a), Tokens::hash($a));
        $this->assertNotSame(Tokens::keyedHash('k1', 'p', $a), Tokens::keyedHash('k2', 'p', $a));
        $code = Tokens::pairingCode();
        $this->assertMatchesRegularExpression('/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/', $code);
        $this->assertSame($code, Tokens::normalizePairingCode(strtolower(str_replace('-', ' ', $code))));
    }

    public function testValidatorRejectsBadInputAndStripsControlChars(): void
    {
        $v = Validator::of(['name' => "Ann\x00\x07ie", 'email' => 'bad', 'n' => '999', 'role' => 'root']);
        $v->string('name', 1, 10)->email('email')->int('n', 1, 10)->enum('role', ['owner', 'agent']);
        $this->assertSame('Annie', $v->get('name'));
        $this->assertArrayHasKey('email', $v->errors());
        $this->assertArrayHasKey('n', $v->errors());
        $this->assertArrayHasKey('role', $v->errors());
        $this->expectException(HttpException::class);
        $v->check();
    }
}
