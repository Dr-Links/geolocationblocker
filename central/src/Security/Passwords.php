<?php

declare(strict_types=1);

namespace Signalpost\Security;

final class Passwords
{
    public static function hash(string $password): string
    {
        $algo = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT;
        return password_hash($password, $algo);
    }

    public static function verify(string $password, string $hash): bool
    {
        return password_verify($password, $hash);
    }

    public static function needsRehash(string $hash): bool
    {
        $algo = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT;
        return password_needs_rehash($hash, $algo);
    }

    /** @return string|null error message, or null if acceptable */
    public static function validate(string $password, int $minLength, string $email = ''): ?string
    {
        if (mb_strlen($password) < $minLength) {
            return "Password must be at least {$minLength} characters.";
        }
        if (strlen($password) > 1024) {
            return 'Password is too long.';
        }
        if ($email !== '' && stripos($password, strtok($email, '@') ?: "\0") !== false && mb_strlen($password) < 16) {
            return 'Password must not contain your email name.';
        }
        $common = ['password123', '1234567890', 'qwertyuiop', 'letmein123', 'password1234', 'administrator'];
        if (in_array(strtolower($password), $common, true)) {
            return 'Password is too common.';
        }
        return null;
    }

    /** Hash used to keep verification time constant when the user does not exist. */
    public static function dummyHash(): string
    {
        static $hash = null;
        return $hash ??= self::hash(bin2hex(random_bytes(16)));
    }
}
