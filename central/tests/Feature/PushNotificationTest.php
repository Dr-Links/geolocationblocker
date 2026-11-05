<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Push\CurlPushTransport;
use Signalpost\Push\PushService;
use Signalpost\Push\PushTransport;
use Signalpost\Push\WebPushCrypto as C;
use Signalpost\Tests\TestCase;
use Signalpost\Tests\WidgetFixtures;

/** Records push requests instead of sending them. */
final class RecordingPushTransport implements PushTransport
{
    public array $requests = [];
    public int $status = 201;

    public function post(string $url, array $headers, string $body): int
    {
        $this->requests[] = ['url' => $url, 'headers' => $headers, 'body' => $body];
        return $this->status;
    }
}

final class PushNotificationTest extends TestCase
{
    use WidgetFixtures;

    private RecordingPushTransport $push;
    private int $owner;
    private int $ws;
    private array $site;

    protected function setUp(): void
    {
        parent::setUp();
        $this->push = new RecordingPushTransport();
        $this->app->set(CurlPushTransport::class, $this->push);
        $this->owner = $this->makeUser('owner@example.com');
        $this->ws = $this->makeWorkspace($this->owner, 'Acme');
        $this->site = $this->connectedSite($this->ws, $this->owner);
    }

    /** Simulates a browser device: returns [subscription JSON, device private key PEM, auth secret]. */
    private function device(string $host = 'fcm.googleapis.com'): array
    {
        $pair = C::generateKeyPair();
        $auth = random_bytes(16);
        $sub = ['endpoint' => "https://{$host}/fcm/send/" . bin2hex(random_bytes(8)), 'keys' => ['p256dh' => C::b64urlEncode($pair['public']), 'auth' => C::b64urlEncode($auth)]];
        return [$sub, $pair['private_pem'], $auth];
    }

    private function subscribe(string $email, ?array $device = null): array
    {
        $device ??= $this->device();
        $b = $this->loginAs($email);
        $res = $b->api('POST', '/api/v1/push/subscriptions', $device[0]);
        $this->assertSame(201, $res->status, $res->body);
        return $device;
    }

    private function decryptFor(array $device, array $request): array
    {
        return json_decode(C::decrypt($request['body'], $device[1], $device[2]), true);
    }

    public function testEncryptionMatchesRfc8291Example(): void
    {
        $d = [C::class, 'b64urlDecode'];
        $asPub = $d('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
        $uaPub = $d('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
        $body = C::encrypt(
            'When I grow up, I want to be a watermelon',
            $uaPub,
            $d('BTBZMqHH6r4Tts7J_aSIgg'),
            C::privateKeyFromRaw($d('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), $asPub),
            $d('DGv6ra1nlYgDCS1FRnbzlw')
        );
        $this->assertSame(
            'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
            C::b64urlEncode($body)
        );
    }

    public function testVapidJwtVerifiesWithPublicKey(): void
    {
        $keys = $this->app->get(PushService::class)->vapidKeys();
        $jwt = C::vapidJwt('https://fcm.googleapis.com', 'mailto:ops@example.com', 2000000000, $keys['private_pem']);
        [$h, $c, $sig] = explode('.', $jwt);
        $raw = C::b64urlDecode($sig);
        $this->assertSame(64, strlen($raw));
        $this->assertSame(1, openssl_verify($h . '.' . $c, C::rawToDer($raw), C::publicKeyPem($keys['public']), OPENSSL_ALGO_SHA256));
        $claims = json_decode(C::b64urlDecode($c), true);
        $this->assertSame(['aud' => 'https://fcm.googleapis.com', 'exp' => 2000000000, 'sub' => 'mailto:ops@example.com'], $claims);
        // Keys are stable across requests (stored once).
        $this->assertSame($keys['public'], $this->makeApp()->get(PushService::class)->vapidKeys()['public']);
    }

    public function testSubscriptionValidationPreventsSsrfAndBadKeys(): void
    {
        $b = $this->loginAs('owner@example.com');
        [$good] = $this->device();
        foreach (['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evil.example.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://user@fcm.googleapis.com/x', 'file:///etc/passwd'] as $bad) {
            $res = $b->api('POST', '/api/v1/push/subscriptions', ['endpoint' => $bad] + $good);
            $this->assertSame(422, $res->status, $bad);
        }
        $this->assertSame(422, $b->api('POST', '/api/v1/push/subscriptions', ['endpoint' => $good['endpoint'], 'keys' => ['p256dh' => C::b64urlEncode("\x04" . str_repeat("\x01", 64)), 'auth' => $good['keys']['auth']]])->status, 'point not on curve');
        $this->assertSame(422, $b->api('POST', '/api/v1/push/subscriptions', ['endpoint' => $good['endpoint'], 'keys' => ['p256dh' => $good['keys']['p256dh'], 'auth' => 'short']])->status);
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM push_subscriptions'));
        $this->assertSame(201, $b->api('POST', '/api/v1/push/subscriptions', $good)->status);
        $this->assertSame(401, $this->request('POST', '/api/v1/push/subscriptions', ['json' => $good])->status);
        $this->assertSame(419, $b->request('POST', '/api/v1/push/subscriptions', ['json' => $good])->status);
        foreach (['web.push.apple.com', 'updates.push.services.mozilla.com', 'wns2-par02p.notify.windows.com'] as $host) {
            $this->assertSame(201, $b->api('POST', '/api/v1/push/subscriptions', $this->device($host)[0])->status, $host);
        }
    }

    public function testNewVisitorMessageNotifiesOnlyEligibleMembersWithoutMessageText(): void
    {
        $ownerDevice = $this->subscribe('owner@example.com');
        $agent = $this->makeUser('agent@example.com');
        $this->addMember($this->ws, $agent);
        $agentDevice = $this->subscribe('agent@example.com');
        $revoked = $this->makeUser('revoked@example.com');
        $this->addMember($this->ws, $revoked);
        $this->subscribe('revoked@example.com');
        $this->app->db()->exec("UPDATE workspace_members SET status = 'revoked' WHERE user_id = ?", [$revoked]);
        $suspended = $this->makeUser('suspended@example.com');
        $this->addMember($this->ws, $suspended);
        $this->subscribe('suspended@example.com');
        $this->app->db()->exec("UPDATE users SET status = 'suspended' WHERE id = ?", [$suspended]);
        $other = $this->makeUser('other@example.com');
        $this->makeWorkspace($other, 'Other');
        $this->subscribe('other@example.com');
        $this->makeUser('root@example.com', true);
        $this->loginAs('owner@example.com')->submit("/w/{$this->ws}/support-grants", ['hours' => 1, 'reason' => 'x']);
        $this->subscribe('root@example.com');

        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'CONFIDENTIAL order question');

        $this->assertCount(2, $this->push->requests, 'owner and agent only');
        $byEndpoint = array_column($this->push->requests, null, 'url');
        $msg = $this->decryptFor($ownerDevice, $byEndpoint[$ownerDevice[0]['endpoint']]);
        $this->assertSame('New message · Shop', $msg['title']);
        $this->assertSame('A visitor sent a new message.', $msg['body']);
        $conv = (int) $this->app->db()->value('SELECT id FROM conversations');
        $this->assertSame("/w/{$this->ws}/inbox?c={$conv}", $msg['url']);
        $this->assertStringNotContainsString('CONFIDENTIAL', implode('', array_column($this->push->requests, 'body')), 'payload is encrypted');
        $this->assertStringNotContainsString('CONFIDENTIAL', $this->decryptFor($ownerDevice, $byEndpoint[$ownerDevice[0]['endpoint']])['body'] . $msg['title'], 'no message text by default');
        $this->assertSame('New message · Shop', $this->decryptFor($agentDevice, $byEndpoint[$agentDevice[0]['endpoint']])['title']);
        $req = $byEndpoint[$ownerDevice[0]['endpoint']];
        $this->assertSame('aes128gcm', $req['headers']['Content-Encoding']);
        $this->assertMatchesRegularExpression('/^vapid t=[^.]+\.[^.]+\.[^,]+, k=[A-Za-z0-9_-]{87}$/', $req['headers']['Authorization']);
    }

    public function testPreviewOptInAndOperatorRepliesDoNotNotify(): void
    {
        $device = $this->subscribe('owner@example.com');
        $b = $this->loginAs('owner@example.com');
        $b->submit('/account/notifications', ['push_show_preview' => '1']);
        [$token] = $this->newVisitor($this->site);
        $this->visitorSend($this->site, $token, 'Where is my parcel?');
        $this->assertSame('Where is my parcel?', $this->decryptFor($device, $this->push->requests[0])['body']);

        $conv = (int) $this->app->db()->value('SELECT id FROM conversations');
        $b->api('POST', "/api/v1/dashboard/w/{$this->ws}/conversations/{$conv}/messages", ['client_message_id' => 'reply-0001', 'body' => 'On its way']);
        $this->assertCount(1, $this->push->requests, 'operator replies never trigger pushes');
        // Second visitor message within 30 s for the same conversation is coalesced.
        $this->visitorSend($this->site, $token, 'Hello?');
        $this->assertCount(1, $this->push->requests);
        $this->app->clock->advance(31);
        $this->visitorSend($this->site, $token, 'Anyone?');
        $this->assertCount(2, $this->push->requests);
    }

    public function testExpiredSubscriptionsAreRemovedAndFailuresDoNotBreakChat(): void
    {
        $this->subscribe('owner@example.com');
        $this->push->status = 410;
        [$token] = $this->newVisitor($this->site);
        $this->assertSame(201, $this->visitorSend($this->site, $token, 'hi')->status);
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM push_subscriptions'));

        $this->subscribe('owner@example.com');
        $this->push->status = 500;
        $this->app->clock->advance(31);
        $this->assertSame(201, $this->visitorSend($this->site, $token, 'again')->status);
        $this->assertSame(1, (int) $this->app->db()->value('SELECT failure_count FROM push_subscriptions'));
    }

    public function testUserCanOnlyRemoveOwnDevices(): void
    {
        $this->subscribe('owner@example.com');
        $id = (int) $this->app->db()->value('SELECT id FROM push_subscriptions');
        $this->makeUser('mallory@example.com');
        $this->assertSame(404, $this->loginAs('mallory@example.com')->submit("/account/devices/{$id}/remove")->status);
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM push_subscriptions'));
        $this->assertSame(303, $this->loginAs('owner@example.com')->submit("/account/devices/{$id}/remove")->status);
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM push_subscriptions'));
    }

    public function testManifestUsesConfiguredNameAndExistingIcons(): void
    {
        $app = $this->makeApp(['app' => ['name' => 'All Live Chats']]);
        $res = (new \Signalpost\Tests\Browser($app))->get('/manifest.webmanifest');
        $this->assertSame(200, $res->status);
        $this->assertStringStartsWith('application/manifest+json', $res->headers['Content-Type']);
        $m = json_decode($res->body, true);
        $this->assertSame('All Live Chats', $m['name']);
        $this->assertSame('AllLiveChats', $m['short_name'], 'fits under a home-screen icon without being cut off');
        $this->assertSame('standalone', $m['display']);
        $this->assertContains('maskable', array_column($m['icons'], 'purpose'));
        foreach ($m['icons'] as $icon) {
            $file = SIGNALPOST_ROOT . '/public' . $icon['src'];
            $this->assertFileExists($file);
            [$w, $h] = getimagesize($file);
            $this->assertSame($icon['sizes'], "{$w}x{$h}");
        }
        $page = (new \Signalpost\Tests\Browser($app))->get('/login')->body;
        $this->assertStringContainsString('<link rel="manifest" href="/manifest.webmanifest">', $page);
        $this->assertStringContainsString('All Live Chats', $page);
    }

    public function testCurlTransportDeliversToRealHttpServer(): void
    {
        $dir = sys_get_temp_dir() . '/sp-push-' . bin2hex(random_bytes(4));
        mkdir($dir);
        file_put_contents($dir . '/index.php', '<?php file_put_contents(__DIR__ . "/got.json", json_encode(["auth" => $_SERVER["HTTP_AUTHORIZATION"] ?? "", "enc" => $_SERVER["HTTP_CONTENT_ENCODING"] ?? "", "len" => strlen(file_get_contents("php://input"))])); http_response_code(201);');
        $port = random_int(20000, 40000);
        $proc = proc_open(['php', '-S', "127.0.0.1:{$port}", '-t', $dir], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        try {
            usleep(400000);
            $status = (new CurlPushTransport($this->app))->post("http://127.0.0.1:{$port}/", ['Content-Encoding' => 'aes128gcm', 'Authorization' => 'vapid t=x, k=y'], str_repeat('z', 150));
            $this->assertSame(201, $status);
            $got = json_decode((string) file_get_contents($dir . '/got.json'), true);
            $this->assertSame(['auth' => 'vapid t=x, k=y', 'enc' => 'aes128gcm', 'len' => 150], $got);
        } finally {
            proc_terminate($proc);
            array_map('unlink', glob($dir . '/*'));
            rmdir($dir);
        }
    }
}
