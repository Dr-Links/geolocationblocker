<?php

declare(strict_types=1);

namespace Signalpost\Auth;

use Signalpost\Admin\PlatformSettings;
use Signalpost\Audit\AuditLog;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Http\ClientIp;
use Signalpost\Http\Request;
use Signalpost\Security\Passwords;
use Signalpost\Security\RateLimiter;
use Signalpost\Security\Tokens;
use Signalpost\Tenancy\WorkspaceService;

final class AuthService
{
    public const TOKEN_RESET = 'password_reset';
    public const TOKEN_VERIFY = 'email_verify';

    public function __construct(private readonly App $app)
    {
    }

    /**
     * Creates the first platform owner. Refuses if any user already exists,
     * so it cannot be used to take over an installed platform.
     */
    public function createPlatformOwner(string $email, string $password, string $name, string $workspaceName): int
    {
        $db = $this->app->db();
        return $db->transaction(function () use ($db, $email, $password, $name, $workspaceName): int {
            // Lock-free check is acceptable: the unique email index and the
            // installer token make concurrent first-owner creation impractical.
            if ((int) $db->value('SELECT COUNT(*) FROM users') > 0) {
                throw HttpException::conflict('The platform owner already exists.');
            }
            $this->assertPassword($password, $email);
            $userId = $this->insertUser($email, $password, $name, 'active', true, true);
            $this->app->get(WorkspaceService::class)->create($userId, $workspaceName);
            $this->app->get(AuditLog::class)->platform($userId, 'platform.owner_created', 'user', $userId, ['via' => 'installer']);
            return $userId;
        });
    }

    public function register(string $email, string $password, string $name, string $workspaceName, Request $request): array
    {
        $settings = $this->app->get(PlatformSettings::class);
        if ($settings->get('registration_mode') !== 'open') {
            throw HttpException::forbidden('Registration is not open.');
        }
        $this->app->get(RateLimiter::class)->enforce('register:ip:' . $this->app->clientIp($request), 5, 3600);
        $this->assertPassword($password, $email);
        $db = $this->app->db();
        if ($db->value('SELECT id FROM users WHERE email = ?', [$email]) !== null) {
            // Do not reveal whether the address is registered: behave as success,
            // and tell the existing owner by email instead.
            $this->app->get(Mailer::class)->send($email, 'Signalpost registration attempt', "Someone tried to register a Signalpost account with this address. If it was you, sign in or reset your password at:\n" . $this->app->get(Mailer::class)->url('/forgot-password') . "\n");
            return ['user_id' => null, 'needs_verification' => true];
        }
        $verify = (bool) $settings->get('require_email_verification');
        $userId = $db->transaction(function () use ($email, $password, $name, $workspaceName, $verify): int {
            $id = $this->insertUser($email, $password, $name, $verify ? 'unverified' : 'active', !$verify, false);
            $this->app->get(WorkspaceService::class)->create($id, $workspaceName);
            return $id;
        });
        $this->app->get(AuditLog::class)->platform($userId, 'user.registered', 'user', $userId);
        if ($verify) {
            $this->sendVerification($userId, $email);
        }
        return ['user_id' => $userId, 'needs_verification' => $verify];
    }

    /** Creates an active, verified account during invitation acceptance. */
    public function createInvitedUser(string $email, string $password, string $name): int
    {
        $this->assertPassword($password, $email);
        $id = $this->insertUser($email, $password, $name, 'active', true, false);
        $this->app->get(AuditLog::class)->platform($id, 'user.registered', 'user', $id, ['via' => 'invitation']);
        return $id;
    }

    /**
     * Verifies credentials with throttling. Returns the user ID.
     * Error messages never reveal whether the email exists.
     */
    public function login(string $email, string $password, Request $request): int
    {
        $limiter = $this->app->get(RateLimiter::class);
        $ip = $this->app->clientIp($request);
        $window = $this->app->config->int('security.login_window_minutes') * 60;
        $max = $this->app->config->int('security.login_max_attempts');
        $emailBucket = 'login:email:' . strtolower($email);
        $ipBucket = 'login:ip:' . $ip;

        if ($limiter->count($emailBucket, $window) >= $max || $limiter->count($ipBucket, $window) >= $max * 6) {
            $this->securityEvent('login_throttled', null, $ip);
            throw new HttpException(429, 'rate_limited', 'Too many sign-in attempts. Please wait a few minutes and try again.');
        }

        $user = $this->app->db()->one('SELECT id, email, password_hash, status FROM users WHERE email = ?', [strtolower($email)]);
        $ok = Passwords::verify($password, $user['password_hash'] ?? Passwords::dummyHash());
        if (!$ok || $user === null) {
            $limiter->hit($emailBucket, PHP_INT_MAX, $window);
            $limiter->hit($ipBucket, PHP_INT_MAX, $window);
            $this->securityEvent('login_failed', $user ? (int) $user['id'] : null, $ip);
            throw new HttpException(401, 'invalid_credentials', 'Invalid email or password.');
        }
        if ($user['status'] === 'suspended') {
            $this->securityEvent('login_suspended', (int) $user['id'], $ip);
            throw HttpException::forbidden('This account is suspended. Contact the platform administrator.');
        }
        if ($user['status'] === 'unverified') {
            throw new HttpException(403, 'email_unverified', 'Please verify your email address first. Check your inbox or request a new link.');
        }
        $limiter->clear($emailBucket);
        if (Passwords::needsRehash($user['password_hash'])) {
            $this->app->db()->exec('UPDATE users SET password_hash = ? WHERE id = ?', [Passwords::hash($password), $user['id']]);
        }
        $this->app->db()->exec('UPDATE users SET last_login_at = ? WHERE id = ?', [$this->app->clock->sql(), $user['id']]);
        return (int) $user['id'];
    }

    /** Always succeeds from the caller's perspective (no account enumeration). */
    public function requestPasswordReset(string $email, Request $request): void
    {
        $limiter = $this->app->get(RateLimiter::class);
        if (!$limiter->hit('reset:ip:' . $this->app->clientIp($request), 10, 3600) || !$limiter->hit('reset:email:' . $email, 3, 3600)) {
            return;
        }
        $user = $this->app->db()->one("SELECT id, email FROM users WHERE email = ? AND status <> 'suspended'", [$email]);
        if ($user === null) {
            return;
        }
        $token = $this->issueToken((int) $user['id'], self::TOKEN_RESET, 3600);
        $mailer = $this->app->get(Mailer::class);
        $mailer->send($user['email'], 'Reset your Signalpost password', "A password reset was requested for your Signalpost account.\n\nReset it within one hour:\n" . $mailer->url('/reset-password?token=' . rawurlencode($token)) . "\n\nIf you did not request this, ignore this email.\n");
    }

    public function resetPassword(string $token, string $password): int
    {
        $db = $this->app->db();
        return $db->transaction(function () use ($db, $token, $password): int {
            $userId = $this->consumeToken($token, self::TOKEN_RESET);
            if ($userId === null) {
                throw HttpException::badRequest('This reset link is invalid or has expired.');
            }
            $email = (string) $db->value('SELECT email FROM users WHERE id = ?', [$userId]);
            $this->assertPassword($password, $email);
            $now = $this->app->clock->sql();
            // Reset proves control of the mailbox, so it also verifies the email.
            $db->exec(
                "UPDATE users SET password_hash = ?, updated_at = ?, email_verified_at = COALESCE(email_verified_at, ?),
                        status = IF(status = 'unverified', 'active', status) WHERE id = ?",
                [Passwords::hash($password), $now, $now, $userId]
            );
            $db->exec('UPDATE user_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', [$now, $userId, self::TOKEN_RESET]);
            $this->app->get(SessionManager::class)->revokeAllForUser($userId);
            $this->app->get(AuditLog::class)->platform($userId, 'user.password_reset', 'user', $userId);
            return $userId;
        });
    }

    public function verifyEmail(string $token): bool
    {
        $userId = $this->consumeToken($token, self::TOKEN_VERIFY);
        if ($userId === null) {
            return false;
        }
        $now = $this->app->clock->sql();
        $this->app->db()->exec(
            "UPDATE users SET email_verified_at = ?, status = IF(status = 'unverified', 'active', status), updated_at = ? WHERE id = ?",
            [$now, $now, $userId]
        );
        return true;
    }

    public function resendVerification(string $email, Request $request): void
    {
        if (!$this->app->get(RateLimiter::class)->hit('verify:ip:' . $this->app->clientIp($request), 5, 3600)) {
            return;
        }
        $user = $this->app->db()->one("SELECT id, email FROM users WHERE email = ? AND status = 'unverified'", [$email]);
        if ($user !== null) {
            $this->sendVerification((int) $user['id'], $user['email']);
        }
    }

    public function changePassword(int $userId, string $current, string $new, int $keepSessionId): void
    {
        $user = $this->app->db()->one('SELECT email, password_hash FROM users WHERE id = ?', [$userId]);
        if ($user === null || !Passwords::verify($current, $user['password_hash'])) {
            throw HttpException::validation(['current_password' => 'Current password is incorrect.']);
        }
        $this->assertPassword($new, $user['email'], 'new_password');
        $this->app->db()->exec('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [Passwords::hash($new), $this->app->clock->sql(), $userId]);
        $this->app->get(SessionManager::class)->revokeAllForUser($userId, $keepSessionId);
        $this->app->get(AuditLog::class)->platform($userId, 'user.password_changed', 'user', $userId);
    }

    public function issueToken(int $userId, string $purpose, int $ttlSeconds): string
    {
        $token = Tokens::random(32);
        $this->app->db()->insert('user_tokens', [
            'user_id' => $userId,
            'purpose' => $purpose,
            'token_hash' => Tokens::hash($token),
            'created_at' => $this->app->clock->sql(),
            'expires_at' => $this->app->clock->sql($ttlSeconds),
        ]);
        return $token;
    }

    /** Atomically marks a token used. Returns the user ID or null. */
    public function consumeToken(string $token, string $purpose): ?int
    {
        if ($token === '' || strlen($token) > 128) {
            return null;
        }
        $db = $this->app->db();
        $hash = Tokens::hash($token);
        $now = $this->app->clock->sql();
        $affected = $db->exec(
            'UPDATE user_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?',
            [$now, $hash, $purpose, $now]
        );
        if ($affected !== 1) {
            return null;
        }
        return (int) $db->value('SELECT user_id FROM user_tokens WHERE token_hash = ?', [$hash]);
    }

    public function securityEvent(string $type, ?int $userId, string $ip, ?int $workspaceId = null, ?int $websiteId = null): void
    {
        $this->app->db()->insert('security_events', [
            'event_type' => $type,
            'user_id' => $userId,
            'workspace_id' => $workspaceId,
            'website_id' => $websiteId,
            'ip_masked' => ClientIp::mask($ip),
            'ip_hash' => Tokens::keyedHash($this->app->config->appKey(), 'ip', $ip),
            'created_at' => $this->app->clock->sql(),
        ]);
    }

    private function sendVerification(int $userId, string $email): void
    {
        $token = $this->issueToken($userId, self::TOKEN_VERIFY, 86400 * 2);
        $mailer = $this->app->get(Mailer::class);
        $mailer->send($email, 'Verify your Signalpost email', "Confirm your email address to activate your Signalpost account:\n" . $mailer->url('/verify-email?token=' . rawurlencode($token)) . "\n\nThe link expires in 48 hours.\n");
    }

    private function insertUser(string $email, string $password, string $name, string $status, bool $verified, bool $admin): int
    {
        $now = $this->app->clock->sql();
        try {
            return $this->app->db()->insert('users', [
                'email' => strtolower($email),
                'password_hash' => Passwords::hash($password),
                'display_name' => $name,
                'status' => $status,
                'is_platform_admin' => $admin ? 1 : 0,
                'email_verified_at' => $verified ? $now : null,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        } catch (\PDOException $e) {
            if ($this->app->db()->isDuplicateKey($e)) {
                throw HttpException::validation(['email' => 'This email address cannot be used.']);
            }
            throw $e;
        }
    }

    private function assertPassword(string $password, string $email, string $field = 'password'): void
    {
        $error = Passwords::validate($password, $this->app->config->int('security.password_min_length'), $email);
        if ($error !== null) {
            throw HttpException::validation([$field => $error]);
        }
    }
}
