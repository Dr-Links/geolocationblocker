<?php

declare(strict_types=1);

namespace Signalpost\Sites;

use Signalpost\Audit\AuditLog;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Security\Tokens;

/**
 * Site integration credentials: "spk_<prefix>.<secret>".
 *
 * The prefix is a non-secret lookup key. Only SHA-256(secret) is stored, so
 * a database leak does not reveal usable credentials. Plaintext is returned
 * exactly once, to the plugin, over HTTPS.
 */
final class CredentialService
{
    /** Old credential stays valid this long after rotation, in case the response is lost. */
    public const ROTATION_GRACE = 600;

    public function __construct(private readonly App $app)
    {
    }

    /**
     * Exchanges a pairing code for a credential. The plugin's site URL must
     * match the website's registered canonical origin.
     *
     * @return array{credential:string,website:array}
     */
    public function pair(string $code, string $siteUrl, ?string $pluginVersion, ?string $platformVersion): array
    {
        $db = $this->app->db();
        $code = Tokens::normalizePairingCode($code);
        if (strlen($code) !== 19) {
            throw HttpException::badRequest('The pairing code is invalid or has expired.');
        }
        return $db->transaction(function () use ($db, $code, $siteUrl, $pluginVersion, $platformVersion) {
            $now = $this->app->clock->sql();
            $row = $db->one(
                "SELECT p.id, p.website_id, w.canonical_origin, w.workspace_id, w.public_key, w.name, ws.status AS ws_status
                   FROM pairing_codes p JOIN websites w ON w.id = p.website_id JOIN workspaces ws ON ws.id = w.workspace_id
                  WHERE p.code_hash = ? AND p.used_at IS NULL AND p.expires_at > ? FOR UPDATE",
                [Tokens::hash($code), $now]
            );
            if ($row === null || $row['ws_status'] !== 'active') {
                throw HttpException::badRequest('The pairing code is invalid or has expired.');
            }
            $allowInsecure = $this->app->get(WebsiteService::class)->allowInsecureOrigins();
            $origin = Origin::ofUrl($siteUrl, $allowInsecure);
            if ($origin === null || !hash_equals($row['canonical_origin'], $origin)) {
                // Do not burn the code: the admin may fix the URL and retry.
                throw new HttpException(400, 'origin_mismatch', 'This site address (' . ($origin ?? 'invalid') . ') does not match the website registered in Signalpost. Update the website address in the dashboard or connect from the matching site.');
            }
            $db->exec('UPDATE pairing_codes SET used_at = ? WHERE id = ?', [$now, $row['id']]);
            // Re-pairing replaces any previous credentials immediately.
            $this->revokeAll((int) $row['website_id']);
            $credential = $this->issue((int) $row['website_id']);
            $db->exec(
                "UPDATE websites SET status = 'connected', last_connected_at = ?, rotation_requested_at = NULL, plugin_version = ?, platform_version = ?, updated_at = ? WHERE id = ?",
                [$now, $this->version($pluginVersion), $this->version($platformVersion), $now, $row['website_id']]
            );
            $this->app->get(AuditLog::class)->workspace((int) $row['workspace_id'], null, 'website.paired', 'website', (int) $row['website_id'], ['key_prefix' => $credential['prefix']], 'integration');
            return [
                'credential' => $credential['credential'],
                'website' => ['public_key' => $row['public_key'], 'name' => $row['name'], 'origin' => $row['canonical_origin']],
            ];
        });
    }

    /** Returns the website row (with workspace status) for a valid credential, or null. */
    public function authenticate(string $credential): ?array
    {
        if (preg_match('/^spk_([0-9a-f]{12})\.([A-Za-z0-9_\-]{43})$/', $credential, $m) !== 1) {
            return null;
        }
        $db = $this->app->db();
        $now = $this->app->clock->sql();
        $row = $db->one(
            "SELECT c.id AS credential_id, c.secret_hash, c.revoked_at, c.last_used_at, w.*, ws.status AS workspace_status
               FROM site_credentials c JOIN websites w ON w.id = c.website_id JOIN workspaces ws ON ws.id = w.workspace_id
              WHERE c.key_prefix = ?",
            [$m[1]]
        );
        // Constant-time comparison; also run it on miss to reduce timing signal.
        $ok = hash_equals($row['secret_hash'] ?? str_repeat('0', 64), Tokens::hash($m[2]));
        if ($row === null || !$ok) {
            return null;
        }
        if ($row['revoked_at'] !== null && $row['revoked_at'] <= $now) {
            return null;
        }
        if ($row['workspace_status'] !== 'active' || $row['status'] === 'disabled') {
            return null;
        }
        if ($row['last_used_at'] === null || strtotime($row['last_used_at'] . ' UTC') < $this->app->clock->timestamp() - 60) {
            $db->exec('UPDATE site_credentials SET last_used_at = ? WHERE id = ?', [$now, $row['credential_id']]);
            $db->exec("UPDATE websites SET last_connected_at = ?, status = IF(status = 'pending', 'connected', status) WHERE id = ?", [$now, $row['id']]);
        }
        unset($row['secret_hash']);
        return $row;
    }

    /** Issues a new credential and schedules the presented one to expire after a grace period. */
    public function rotate(array $website): string
    {
        $db = $this->app->db();
        return $db->transaction(function () use ($db, $website) {
            $graceEnd = $this->app->clock->sql(self::ROTATION_GRACE);
            $db->exec('UPDATE site_credentials SET revoked_at = ? WHERE website_id = ? AND (revoked_at IS NULL OR revoked_at > ?)', [$graceEnd, $website['id'], $graceEnd]);
            $new = $this->issue((int) $website['id']);
            $db->exec('UPDATE websites SET rotation_requested_at = NULL WHERE id = ?', [$website['id']]);
            $this->app->get(AuditLog::class)->workspace((int) $website['workspace_id'], null, 'website.credentials_rotated', 'website', (int) $website['id'], ['key_prefix' => $new['prefix']], 'integration');
            return $new['credential'];
        });
    }

    public function revokeAll(int $websiteId): void
    {
        $now = $this->app->clock->sql();
        $this->app->db()->exec('UPDATE site_credentials SET revoked_at = ? WHERE website_id = ? AND (revoked_at IS NULL OR revoked_at > ?)', [$now, $websiteId, $now]);
    }

    /** @return array{credential:string,prefix:string} */
    private function issue(int $websiteId): array
    {
        $prefix = Tokens::hex(6);
        $secret = Tokens::random(32);
        $this->app->db()->insert('site_credentials', [
            'website_id' => $websiteId,
            'key_prefix' => $prefix,
            'secret_hash' => Tokens::hash($secret),
            'created_at' => $this->app->clock->sql(),
        ]);
        return ['credential' => 'spk_' . $prefix . '.' . $secret, 'prefix' => $prefix];
    }

    private function version(?string $v): ?string
    {
        return $v !== null && preg_match('/^[0-9A-Za-z.\-+]{1,20}$/', $v) === 1 ? $v : null;
    }
}
