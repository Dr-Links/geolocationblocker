<?php

declare(strict_types=1);

namespace Signalpost\Security;

/** Authenticated encryption (AES-256-GCM) for small secrets stored in the database. */
final class SecretBox
{
    public static function seal(string $appKey, string $purpose, string $plain): string
    {
        $key = hash_hmac('sha256', 'secretbox:' . $purpose, $appKey, true);
        $iv = random_bytes(12);
        $tag = '';
        $c = openssl_encrypt($plain, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, $purpose);
        return 'v1:' . base64_encode($iv . $tag . $c);
    }

    public static function open(string $appKey, string $purpose, string $sealed): ?string
    {
        if (!str_starts_with($sealed, 'v1:')) {
            return null;
        }
        $raw = base64_decode(substr($sealed, 3), true);
        if ($raw === false || strlen($raw) < 29) {
            return null;
        }
        $key = hash_hmac('sha256', 'secretbox:' . $purpose, $appKey, true);
        $plain = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', $key, OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16), $purpose);
        return $plain === false ? null : $plain;
    }
}
