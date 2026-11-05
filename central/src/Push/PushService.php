<?php

declare(strict_types=1);

namespace Signalpost\Push;

use Signalpost\Admin\PlatformSettings;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Security\Tokens;
use Signalpost\Security\UserAgent;

/**
 * Web Push notifications for operators using the installable dashboard app.
 *
 * - VAPID keys are generated on first use and kept in the database.
 * - Subscription endpoints must be HTTPS URLs on known browser push services
 *   (config push.allowed_host_suffixes), so a user cannot make the server send
 *   requests to arbitrary or internal addresses.
 * - Recipients are re-checked at send time: active user, active membership in
 *   an active workspace. Support grants never receive notifications.
 * - By default notifications contain no message text; each user may opt in to
 *   a short preview. Payloads are end-to-end encrypted for the device (RFC 8291).
 */
final class PushService
{
    public const DEFAULT_ALLOWED_HOST_SUFFIXES = [
        'fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com',
        'notify.windows.com', 'push.apple.com',
    ];

    public function __construct(private readonly App $app)
    {
    }

    private function transport(): PushTransport
    {
        return $this->app->get(CurlPushTransport::class);
    }

    /** @return array{public:string, private_pem:string} */
    public function vapidKeys(): array
    {
        $settings = $this->app->get(PlatformSettings::class);
        $stored = json_decode((string) $settings->getState('vapid_keys'), true);
        if (is_array($stored) && isset($stored['public'], $stored['private_pem'])) {
            return ['public' => WebPushCrypto::b64urlDecode($stored['public']), 'private_pem' => $stored['private_pem']];
        }
        $pair = WebPushCrypto::generateKeyPair();
        $settings->setState('vapid_keys', (string) json_encode(['public' => WebPushCrypto::b64urlEncode($pair['public']), 'private_pem' => $pair['private_pem']]));
        return $pair;
    }

    public function publicKey(): string
    {
        return WebPushCrypto::b64urlEncode($this->vapidKeys()['public']);
    }

    public function endpointAllowed(string $endpoint): bool
    {
        $parts = parse_url($endpoint);
        if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || !isset($parts['host']) || isset($parts['user']) || strlen($endpoint) > 1024) {
            return false;
        }
        $host = strtolower($parts['host']);
        $suffixes = (array) $this->app->config->get('push.allowed_host_suffixes', self::DEFAULT_ALLOWED_HOST_SUFFIXES);
        foreach ($suffixes as $suffix) {
            $suffix = strtolower((string) $suffix);
            if ($host === $suffix || str_ends_with($host, '.' . $suffix)) {
                return true;
            }
        }
        return false;
    }

    public function subscribe(int $userId, mixed $endpoint, mixed $p256dh, mixed $auth, ?string $userAgent): void
    {
        if (!is_string($endpoint) || !$this->endpointAllowed($endpoint)) {
            throw HttpException::validation(['endpoint' => 'Unsupported push service.']);
        }
        try {
            $key = is_string($p256dh) ? WebPushCrypto::b64urlDecode($p256dh) : '';
            $secret = is_string($auth) ? WebPushCrypto::b64urlDecode($auth) : '';
        } catch (\InvalidArgumentException) {
            throw HttpException::validation(['keys' => 'Invalid subscription keys.']);
        }
        if (!WebPushCrypto::isValidPublicKey($key) || strlen($secret) !== 16) {
            throw HttpException::validation(['keys' => 'Invalid subscription keys.']);
        }
        $db = $this->app->db();
        if ((int) $db->value('SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?', [$userId]) >= 10) {
            $db->exec('DELETE FROM push_subscriptions WHERE user_id = ? ORDER BY id LIMIT 1', [$userId]);
        }
        // An endpoint belongs to one device; re-subscribing moves it to the current user.
        $db->exec(
            'INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth, device_summary, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth),
                                     device_summary = VALUES(device_summary), failure_count = 0',
            [$userId, $endpoint, Tokens::hash($endpoint), WebPushCrypto::b64urlEncode($key), WebPushCrypto::b64urlEncode($secret),
             UserAgent::summary($userAgent), $this->app->clock->sql()]
        );
    }

    public function unsubscribe(int $userId, mixed $endpoint): void
    {
        if (is_string($endpoint)) {
            $this->app->db()->exec('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?', [$userId, Tokens::hash($endpoint)]);
        }
    }

    public function subscriptions(int $userId): array
    {
        return $this->app->db()->all('SELECT id, device_summary, created_at, last_success_at FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC', [$userId]);
    }

    /**
     * Notifies the workspace's active owners and agents about a new visitor message.
     * Rate-limited to one notification per user and conversation per 30 seconds.
     */
    public function notifyNewVisitorMessage(array $conversation, array $message): int
    {
        $db = $this->app->db();
        $recipients = $db->all(
            "SELECT DISTINCT u.id, u.push_show_preview FROM workspace_members m
               JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id
              WHERE m.workspace_id = ? AND m.status = 'active' AND u.status = 'active' AND w.status = 'active'
                AND m.role IN ('owner','agent')
                AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)",
            [$conversation['workspace_id']]
        );
        if ($recipients === []) {
            return 0;
        }
        $site = (string) $db->value('SELECT name FROM websites WHERE id = ?', [$conversation['website_id']]);
        $limiter = $this->app->get(\Signalpost\Security\RateLimiter::class);
        $sent = 0;
        foreach ($recipients as $r) {
            if (!$limiter->hit('push:' . $r['id'] . ':' . $conversation['id'], 1, 30)) {
                continue;
            }
            $body = (int) $r['push_show_preview'] === 1
                ? mb_substr((string) $message['body'], 0, 120)
                : 'A visitor sent a new message.';
            $payload = [
                'title' => 'New message · ' . mb_substr($site, 0, 60),
                'body' => $body,
                'url' => '/w/' . (int) $conversation['workspace_id'] . '/inbox?c=' . (int) $conversation['id'],
                'tag' => 'conv-' . (int) $conversation['id'],
            ];
            $sent += $this->sendToUser((int) $r['id'], $payload);
        }
        return $sent;
    }

    /** @return int number of successful deliveries */
    public function sendToUser(int $userId, array $payload): int
    {
        $db = $this->app->db();
        $keys = $this->vapidKeys();
        $json = (string) json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $subject = (string) $this->app->config->get('push.subject', '') ?: 'mailto:' . $this->app->config->get('mail.from');
        $ok = 0;
        foreach ($db->all('SELECT * FROM push_subscriptions WHERE user_id = ?', [$userId]) as $sub) {
            if (!$this->endpointAllowed($sub['endpoint'])) {
                $db->exec('DELETE FROM push_subscriptions WHERE id = ?', [$sub['id']]);
                continue;
            }
            try {
                $body = WebPushCrypto::encrypt($json, WebPushCrypto::b64urlDecode($sub['p256dh']), WebPushCrypto::b64urlDecode($sub['auth']));
                $parts = parse_url($sub['endpoint']);
                $audience = $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
                $jwt = WebPushCrypto::vapidJwt($audience, $subject, $this->app->clock->timestamp() + 12 * 3600, $keys['private_pem']);
                $status = $this->transport()->post($sub['endpoint'], [
                    'Content-Type' => 'application/octet-stream',
                    'Content-Encoding' => 'aes128gcm',
                    'TTL' => '86400',
                    'Urgency' => 'high',
                    'Topic' => substr(preg_replace('/[^A-Za-z0-9_-]/', '', (string) ($payload['tag'] ?? 'signalpost')), 0, 32),
                    'Authorization' => 'vapid t=' . $jwt . ', k=' . WebPushCrypto::b64urlEncode($keys['public']),
                ], $body);
            } catch (\Throwable $e) {
                $this->app->logger()->warning('Push encryption/send failed', ['type' => $e::class]);
                $status = 0;
            }
            if ($status >= 200 && $status < 300) {
                $db->exec('UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?', [$this->app->clock->sql(), $sub['id']]);
                $ok++;
            } elseif (in_array($status, [404, 410], true)) {
                $db->exec('DELETE FROM push_subscriptions WHERE id = ?', [$sub['id']]); // Expired on the device.
            } else {
                $db->exec('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?', [$sub['id']]);
                $db->exec('DELETE FROM push_subscriptions WHERE id = ? AND failure_count >= 10', [$sub['id']]);
                $this->app->logger()->warning('Push delivery failed', ['status' => $status]);
            }
        }
        return $ok;
    }
}
