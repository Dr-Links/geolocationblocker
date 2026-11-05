<?php

declare(strict_types=1);

namespace Signalpost\Auth;

use Signalpost\Audit\AuditLog;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Security\Passwords;
use Signalpost\Security\RateLimiter;
use Signalpost\Security\SecretBox;
use Signalpost\Security\Tokens;
use Signalpost\Security\Totp;

/**
 * Optional TOTP two-factor authentication with single-use recovery codes.
 * The TOTP secret is encrypted with the application key; recovery codes are
 * stored as SHA-256 hashes. Codes cannot be replayed (last step is recorded).
 */
final class TwoFactorService
{
    public const PENDING_TOKEN = '2fa_login';
    public const COOKIE = 'sp_2fa';

    public function __construct(private readonly App $app)
    {
    }

    public function isEnabled(int $userId): bool
    {
        return $this->app->db()->value('SELECT totp_enabled_at FROM users WHERE id = ?', [$userId]) !== null;
    }

    /** Starts (or restarts) setup and returns the plaintext secret for the authenticator app. */
    public function beginSetup(int $userId): string
    {
        if ($this->isEnabled($userId)) {
            throw HttpException::conflict('Two-factor authentication is already on.');
        }
        $secret = Totp::generateSecret();
        $this->app->db()->exec('UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?', [
            SecretBox::seal($this->app->config->appKey(), 'totp', $secret), $userId,
        ]);
        return $secret;
    }

    public function pendingSecret(int $userId): ?string
    {
        $row = $this->app->db()->one('SELECT totp_secret, totp_enabled_at FROM users WHERE id = ?', [$userId]);
        if ($row === null || $row['totp_secret'] === null || $row['totp_enabled_at'] !== null) {
            return null;
        }
        return SecretBox::open($this->app->config->appKey(), 'totp', $row['totp_secret']);
    }

    /** Confirms setup with a code from the app. Returns the recovery codes (shown once). */
    public function enable(int $userId, string $code): array
    {
        $secret = $this->pendingSecret($userId);
        if ($secret === null) {
            throw HttpException::badRequest('Start the setup again.');
        }
        $step = Totp::verify($secret, $code, $this->app->clock->timestamp(), null);
        if ($step === null) {
            throw HttpException::validation(['code' => 'That code is not valid. Check the time on your phone and try the current code.']);
        }
        $codes = [];
        $db = $this->app->db();
        $db->transaction(function () use ($db, $userId, $step, &$codes): void {
            $db->exec('UPDATE users SET totp_enabled_at = ?, totp_last_step = ? WHERE id = ?', [$this->app->clock->sql(), $step, $userId]);
            $codes = $this->regenerateRecoveryCodes($userId);
        });
        $this->app->get(AuditLog::class)->platform($userId, 'user.2fa_enabled', 'user', $userId);
        return $codes;
    }

    public function disable(int $userId, string $password, string $code): void
    {
        $hash = (string) $this->app->db()->value('SELECT password_hash FROM users WHERE id = ?', [$userId]);
        $errors = [];
        if (!Passwords::verify($password, $hash)) {
            $errors['password'] = 'Password is incorrect.';
        }
        if (!$this->verifyCode($userId, $code)) {
            $errors['code'] = 'That code is not valid.';
        }
        if ($errors !== []) {
            throw HttpException::validation($errors);
        }
        $this->clear($userId);
        $this->app->get(AuditLog::class)->platform($userId, 'user.2fa_disabled', 'user', $userId);
    }

    /** Platform-owner reset for a locked-out user. */
    public function reset(int $actorId, int $userId): void
    {
        if ($this->app->db()->value('SELECT id FROM users WHERE id = ?', [$userId]) === null) {
            throw HttpException::notFound();
        }
        $this->clear($userId);
        $this->app->get(SessionManager::class)->revokeAllForUser($userId);
        $this->app->get(AuditLog::class)->platform($actorId, 'user.2fa_reset', 'user', $userId, ['target_user_id' => $userId]);
    }

    /** Verifies a TOTP code (no replay) or a single-use recovery code. */
    public function verifyCode(int $userId, string $code): bool
    {
        $db = $this->app->db();
        $row = $db->one('SELECT totp_secret, totp_enabled_at, totp_last_step FROM users WHERE id = ?', [$userId]);
        if ($row === null || $row['totp_enabled_at'] === null) {
            return false;
        }
        $code = trim($code);
        if (preg_match('/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/', $code) === 1) {
            $hash = Tokens::hash(strtolower(str_replace('-', '', $code)));
            return $db->exec('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
                [$this->app->clock->sql(), $userId, $hash]) === 1;
        }
        $secret = SecretBox::open($this->app->config->appKey(), 'totp', (string) $row['totp_secret']);
        if ($secret === null) {
            return false;
        }
        $last = $row['totp_last_step'] === null ? null : (int) $row['totp_last_step'];
        $step = Totp::verify($secret, $code, $this->app->clock->timestamp(), $last);
        if ($step === null) {
            return false;
        }
        // Conditional update makes concurrent reuse of the same code fail.
        return $db->exec('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [$step, $userId, $step]) === 1;
    }

    /** @return list<string> */
    public function regenerateRecoveryCodes(int $userId): array
    {
        $db = $this->app->db();
        $db->exec('DELETE FROM user_recovery_codes WHERE user_id = ?', [$userId]);
        $codes = [];
        for ($i = 0; $i < 10; $i++) {
            $raw = substr(strtolower(Totp::base32Encode(random_bytes(7))), 0, 10);
            $codes[] = substr($raw, 0, 5) . '-' . substr($raw, 5);
            $db->insert('user_recovery_codes', ['user_id' => $userId, 'code_hash' => Tokens::hash($raw)]);
        }
        return $codes;
    }

    public function remainingRecoveryCodes(int $userId): int
    {
        return (int) $this->app->db()->value('SELECT COUNT(*) FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', [$userId]);
    }

    // ---- Login step ------------------------------------------------------------------

    /** Issues a short-lived token proving the password step succeeded. */
    public function startLogin(int $userId): string
    {
        return $this->app->get(AuthService::class)->issueToken($userId, self::PENDING_TOKEN, 300);
    }

    /** Returns the user ID for a valid pending-login token without consuming it. */
    public function pendingUser(?string $token): ?int
    {
        if ($token === null || $token === '' || strlen($token) > 128) {
            return null;
        }
        $id = $this->app->db()->value(
            'SELECT user_id FROM user_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?',
            [Tokens::hash($token), self::PENDING_TOKEN, $this->app->clock->sql()]
        );
        return $id === null ? null : (int) $id;
    }

    /** Completes the second step. Returns the user ID. */
    public function completeLogin(string $token, string $code, string $ip): int
    {
        $userId = $this->pendingUser($token);
        if ($userId === null) {
            throw HttpException::badRequest('Your sign-in expired. Please sign in again.');
        }
        $limiter = $this->app->get(RateLimiter::class);
        if (!$limiter->hit('2fa:user:' . $userId, 5, 900)) {
            $this->app->get(AuthService::class)->securityEvent('2fa_throttled', $userId, $ip);
            throw new HttpException(429, 'rate_limited', 'Too many attempts. Please wait 15 minutes.');
        }
        if (!$this->verifyCode($userId, $code)) {
            $this->app->get(AuthService::class)->securityEvent('2fa_failed', $userId, $ip);
            throw HttpException::validation(['code' => 'That code is not valid.']);
        }
        $this->app->get(AuthService::class)->consumeToken($token, self::PENDING_TOKEN);
        $limiter->clear('2fa:user:' . $userId);
        return $userId;
    }

    private function clear(int $userId): void
    {
        $this->app->db()->exec('UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?', [$userId]);
        $this->app->db()->exec('DELETE FROM user_recovery_codes WHERE user_id = ?', [$userId]);
    }
}
