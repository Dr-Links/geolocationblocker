<?php

declare(strict_types=1);

namespace Signalpost\Licensing;

use Signalpost\Admin\PlatformSettings;
use Signalpost\Audit\AuditLog;
use Signalpost\Auth\Mailer;
use Signalpost\Auth\SessionManager;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Security\RateLimiter;
use Signalpost\Security\Tokens;

/**
 * Time-limited account access controlled by activation codes.
 *
 * - The platform owner generates codes for 1, 3, 6 or 12 months.
 * - A code is single-use: it either creates one account (sign-up) or renews
 *   one existing account. Redemption runs under a row lock, so concurrent
 *   attempts cannot use the same code twice.
 * - Only a SHA-256 hash and the last four characters of each code are stored;
 *   the full code is shown once, when it is generated.
 * - users.access_expires_at = NULL means no time limit (platform owner,
 *   members who inherit their workspace owner's access, legacy accounts).
 */
final class AccessService
{
    public const DURATIONS = [1, 3, 6, 12];
    private const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    public function __construct(private readonly App $app)
    {
    }

    // ---- Codes -------------------------------------------------------------------------

    public static function normalize(string $code): string
    {
        $clean = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $code) ?? '');
        if (str_starts_with($clean, 'AC')) {
            $clean = substr($clean, 2);
        }
        return $clean;
    }

    public static function format(string $raw): string
    {
        return 'AC-' . implode('-', str_split($raw, 4));
    }

    /** @return list<string> plaintext codes (shown once) */
    public function generate(int $adminId, int $months, int $quantity, string $note): array
    {
        if (!in_array($months, self::DURATIONS, true)) {
            throw HttpException::validation(['duration_months' => 'Choose 1, 3, 6 or 12 months.']);
        }
        if ($quantity < 1 || $quantity > 50) {
            throw HttpException::validation(['quantity' => 'Generate between 1 and 50 codes at a time.']);
        }
        $note = mb_substr(trim((string) preg_replace('/[\x00-\x1F\x7F]/u', '', $note)), 0, 255);
        $codes = [];
        $db = $this->app->db();
        $db->transaction(function () use ($db, $adminId, $months, $quantity, $note, &$codes): void {
            for ($i = 0; $i < $quantity; $i++) {
                $raw = '';
                for ($j = 0; $j < 16; $j++) {
                    $raw .= self::ALPHABET[random_int(0, strlen(self::ALPHABET) - 1)];
                }
                $db->insert('activation_codes', [
                    'code_hash' => Tokens::hash($raw),
                    'code_hint' => substr($raw, -4),
                    'duration_months' => $months,
                    'note' => $note,
                    'created_by_user_id' => $adminId,
                    'created_at' => $this->app->clock->sql(),
                ]);
                $codes[] = self::format($raw);
            }
        });
        $this->app->get(AuditLog::class)->platform($adminId, 'activation_code.created', 'activation_code', '', ['count' => $quantity, 'mode' => $months . ' months']);
        return $codes;
    }

    public function list(string $status = 'all', int $limit = 200): array
    {
        $where = match ($status) {
            'unused' => 'c.used_at IS NULL AND c.revoked_at IS NULL',
            'used' => 'c.used_at IS NOT NULL',
            'revoked' => 'c.revoked_at IS NOT NULL',
            default => '1=1',
        };
        return $this->app->db()->all(
            "SELECT c.id, c.code_hint, c.duration_months, c.note, c.created_at, c.revoked_at, c.used_at, c.used_for,
                    c.period_starts_at, c.period_ends_at, u.id AS user_id, u.email AS used_by, u.access_expires_at,
                    cb.email AS created_by
               FROM activation_codes c
               LEFT JOIN users u ON u.id = c.used_by_user_id
               LEFT JOIN users cb ON cb.id = c.created_by_user_id
              WHERE {$where} ORDER BY c.id DESC LIMIT " . max(1, min($limit, 1000))
        );
    }

    public function revoke(int $adminId, int $codeId): void
    {
        $n = $this->app->db()->exec(
            'UPDATE activation_codes SET revoked_at = ?, revoked_by_user_id = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
            [$this->app->clock->sql(), $adminId, $codeId]
        );
        if ($n !== 1) {
            throw HttpException::conflict('Only unused, active codes can be revoked.');
        }
        $this->app->get(AuditLog::class)->platform($adminId, 'activation_code.revoked', 'activation_code', $codeId);
    }

    /**
     * Redeems a code for a user inside the caller's transaction. Extends from the
     * later of now and the current expiry, so early renewal never loses days.
     * Throws a generic 422 for unknown, used or revoked codes.
     *
     * @return string new access_expires_at (SQL datetime)
     */
    public function redeem(int $userId, string $code, string $purpose, string $ip): string
    {
        $limiter = $this->app->get(RateLimiter::class);
        if ($limiter->count('activation:ip:' . $ip, 3600) >= 10) {
            throw new HttpException(429, 'rate_limited', 'Too many code attempts. Please try again later.');
        }
        $db = $this->app->db();
        $raw = self::normalize($code);
        $row = strlen($raw) === 16 ? $db->one(
            'SELECT * FROM activation_codes WHERE code_hash = ? FOR UPDATE',
            [Tokens::hash($raw)]
        ) : null;
        if ($row === null || $row['used_at'] !== null || $row['revoked_at'] !== null) {
            $limiter->hit('activation:ip:' . $ip, PHP_INT_MAX, 3600);
            throw HttpException::validation(['activation_code' => 'This activation code is not valid or has already been used.']);
        }
        $current = $db->value('SELECT access_expires_at FROM users WHERE id = ? FOR UPDATE', [$userId]);
        $now = $this->app->clock->now();
        $start = $current !== null && strtotime($current . ' UTC') > $now->getTimestamp()
            ? new \DateTimeImmutable($current, new \DateTimeZone('UTC')) : $now;
        $end = $start->modify('+' . (int) $row['duration_months'] . ' months')->format('Y-m-d H:i:s');
        $db->exec(
            'UPDATE activation_codes SET used_at = ?, used_by_user_id = ?, used_for = ?, period_starts_at = ?, period_ends_at = ? WHERE id = ? AND used_at IS NULL',
            [$now->format('Y-m-d H:i:s'), $userId, $purpose, $start->format('Y-m-d H:i:s'), $end, $row['id']]
        );
        $db->exec('UPDATE users SET access_expires_at = ?, access_reminder_sent_at = NULL, access_expiry_processed_at = NULL WHERE id = ?', [$end, $userId]);
        $this->app->get(AuditLog::class)->platform($userId, $purpose === 'signup' ? 'activation_code.redeemed' : 'user.access_renewed', 'activation_code', (int) $row['id'], [
            'target_user_id' => $userId, 'expires_at' => $end, 'mode' => (int) $row['duration_months'] . ' months',
        ]);
        return $end;
    }

    /** Read-only check that a code exists and is unused (no consumption). */
    public function isUsable(string $code): bool
    {
        $raw = self::normalize($code);
        return strlen($raw) === 16 && $this->app->db()->value(
            'SELECT id FROM activation_codes WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL',
            [Tokens::hash($raw)]
        ) !== null;
    }

    /** Renewal entry point (own transaction). */
    public function renew(int $userId, string $code, string $ip): string
    {
        return $this->app->db()->transaction(fn () => $this->redeem($userId, $code, 'renewal', $ip));
    }

    /** Platform-owner adjustment without a code (e.g. goodwill extension), audited. */
    public function extendByAdmin(int $adminId, int $userId, int $months): string
    {
        if (!in_array($months, self::DURATIONS, true)) {
            throw HttpException::validation(['months' => 'Choose 1, 3, 6 or 12 months.']);
        }
        $db = $this->app->db();
        $current = $db->value('SELECT access_expires_at FROM users WHERE id = ?', [$userId]);
        if ($db->value('SELECT id FROM users WHERE id = ?', [$userId]) === null) {
            throw HttpException::notFound();
        }
        $now = $this->app->clock->now();
        $start = $current !== null && strtotime($current . ' UTC') > $now->getTimestamp() ? new \DateTimeImmutable($current, new \DateTimeZone('UTC')) : $now;
        $end = $start->modify("+{$months} months")->format('Y-m-d H:i:s');
        $db->exec('UPDATE users SET access_expires_at = ?, access_reminder_sent_at = NULL, access_expiry_processed_at = NULL WHERE id = ?', [$end, $userId]);
        $this->app->get(AuditLog::class)->platform($adminId, 'user.access_extended', 'user', $userId, ['target_user_id' => $userId, 'expires_at' => $end]);
        return $end;
    }

    // ---- Status ------------------------------------------------------------------------

    /** True if this user's own time-limited access has run out. Platform owners never expire. */
    public function isExpired(array $user): bool
    {
        if (!empty($user['is_platform_admin'])) {
            return false;
        }
        $exp = $user['access_expires_at'] ?? null;
        return $exp !== null && strtotime($exp . ' UTC') <= $this->app->clock->timestamp();
    }

    public function isUserIdExpired(int $userId): bool
    {
        $row = $this->app->db()->one('SELECT is_platform_admin, access_expires_at FROM users WHERE id = ?', [$userId]);
        return $row !== null && $this->isExpired($row);
    }

    /** Whether a workspace is locked because its primary owner's access expired. */
    public function workspaceLocked(int $workspaceId): bool
    {
        $owner = $this->app->db()->one(
            'SELECT u.is_platform_admin, u.access_expires_at FROM workspaces w JOIN users u ON u.id = w.owner_user_id WHERE w.id = ?',
            [$workspaceId]
        );
        return $owner !== null && $this->isExpired($owner);
    }

    public function widgetsOffline(int $workspaceId): bool
    {
        return $this->app->get(PlatformSettings::class)->get('expired_owner_widgets') === 'offline' && $this->workspaceLocked($workspaceId);
    }

    // ---- Cron --------------------------------------------------------------------------

    /**
     * Signs out accounts whose access just expired (once per period) and sends
     * renewal reminders. Bounded per run.
     *
     * @return array{expired:int, reminded:int}
     */
    public function enforce(): array
    {
        $db = $this->app->db();
        $now = $this->app->clock->sql();
        $expired = 0;
        foreach ($db->all(
            'SELECT id FROM users WHERE is_platform_admin = 0 AND access_expires_at IS NOT NULL AND access_expires_at <= ? AND access_expiry_processed_at IS NULL LIMIT 500',
            [$now]
        ) as $u) {
            $this->app->get(SessionManager::class)->revokeAllForUser((int) $u['id']);
            $db->exec('UPDATE users SET access_expiry_processed_at = ? WHERE id = ?', [$now, $u['id']]);
            $this->app->get(AuditLog::class)->platform(null, 'user.access_expired', 'user', (int) $u['id'], ['target_user_id' => (int) $u['id']], 'system');
            $expired++;
        }

        $reminded = 0;
        $days = (int) $this->app->get(PlatformSettings::class)->get('access_reminder_days');
        if ($days > 0) {
            $mailer = $this->app->get(Mailer::class);
            foreach ($db->all(
                "SELECT id, email, access_expires_at FROM users WHERE is_platform_admin = 0 AND status = 'active'
                    AND access_expires_at > ? AND access_expires_at <= ? AND access_reminder_sent_at IS NULL LIMIT 200",
                [$now, $this->app->clock->sql($days * 86400)]
            ) as $u) {
                $name = (string) $this->app->config->get('app.name');
                $mailer->send($u['email'], "Your {$name} access ends soon", "Your {$name} access ends on {$u['access_expires_at']} UTC.\n\nTo keep using your account, ask the administrator for a new activation code and enter it under Account → Access (or on the renewal page after expiry):\n" . $mailer->url('/renew') . "\n\nYour conversations and settings are kept.\n");
                $db->exec('UPDATE users SET access_reminder_sent_at = ? WHERE id = ?', [$now, $u['id']]);
                $reminded++;
            }
        }
        return ['expired' => $expired, 'reminded' => $reminded];
    }
}
