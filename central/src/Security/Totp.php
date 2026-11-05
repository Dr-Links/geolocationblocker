<?php

declare(strict_types=1);

namespace Signalpost\Security;

/** RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30-second steps). */
final class Totp
{
    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public static function generateSecret(): string
    {
        return self::base32Encode(random_bytes(20));
    }

    public static function base32Encode(string $bin): string
    {
        $bits = '';
        foreach (str_split($bin) as $c) {
            $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::ALPHABET[bindec(str_pad($chunk, 5, '0'))];
        }
        return $out;
    }

    public static function base32Decode(string $b32): string
    {
        $b32 = strtoupper(preg_replace('/[\s=]/', '', $b32) ?? '');
        $bits = '';
        foreach (str_split($b32) as $c) {
            $i = strpos(self::ALPHABET, $c);
            if ($i === false) {
                throw new \InvalidArgumentException('Invalid base32.');
            }
            $bits .= str_pad(decbin($i), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) {
                $out .= chr(bindec($byte));
            }
        }
        return $out;
    }

    public static function code(string $secretB32, int $step): string
    {
        $mac = hash_hmac('sha1', pack('J', $step), self::base32Decode($secretB32), true);
        $offset = ord($mac[19]) & 0x0f;
        $bin = ((ord($mac[$offset]) & 0x7f) << 24) | (ord($mac[$offset + 1]) << 16) | (ord($mac[$offset + 2]) << 8) | ord($mac[$offset + 3]);
        return str_pad((string) ($bin % 1000000), 6, '0', STR_PAD_LEFT);
    }

    /**
     * Verifies a code within ±1 step. Returns the matched step, or null.
     * Steps at or before $lastUsedStep are rejected (replay protection).
     */
    public static function verify(string $secretB32, string $code, int $now, ?int $lastUsedStep): ?int
    {
        $code = preg_replace('/\s/', '', $code) ?? '';
        if (preg_match('/^\d{6}$/', $code) !== 1) {
            return null;
        }
        $current = intdiv($now, 30);
        foreach ([$current, $current - 1, $current + 1] as $step) {
            if ($lastUsedStep !== null && $step <= $lastUsedStep) {
                continue;
            }
            if (hash_equals(self::code($secretB32, $step), $code)) {
                return $step;
            }
        }
        return null;
    }

    public static function uri(string $secretB32, string $account, string $issuer): string
    {
        return 'otpauth://totp/' . rawurlencode($issuer . ':' . $account)
            . '?secret=' . $secretB32 . '&issuer=' . rawurlencode($issuer) . '&algorithm=SHA1&digits=6&period=30';
    }
}
