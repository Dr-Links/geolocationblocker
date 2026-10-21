<?php

declare(strict_types=1);

namespace Signalpost\Security;

/** Random token generation and one-way token hashing. */
final class Tokens
{
    /** URL-safe random token with $bytes of entropy. */
    public static function random(int $bytes = 32): string
    {
        return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
    }

    public static function hex(int $bytes = 16): string
    {
        return bin2hex(random_bytes($bytes));
    }

    /** SHA-256 hash for high-entropy tokens (sessions, credentials, reset links). */
    public static function hash(string $token): string
    {
        return hash('sha256', $token);
    }

    /** Keyed hash (HMAC-SHA256) used where the hash must not be recomputable without the app key. */
    public static function keyedHash(string $key, string $purpose, string $token): string
    {
        return hash_hmac('sha256', $purpose . "\0" . $token, $key);
    }

    /** Pairing codes: human-typable, 4x4 groups from an unambiguous alphabet (~80 bits). */
    public static function pairingCode(): string
    {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        $out = '';
        for ($i = 0; $i < 16; $i++) {
            $out .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            if ($i % 4 === 3 && $i < 15) {
                $out .= '-';
            }
        }
        return $out;
    }

    public static function normalizePairingCode(string $code): string
    {
        $clean = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $code) ?? '');
        return implode('-', str_split($clean, 4));
    }
}
