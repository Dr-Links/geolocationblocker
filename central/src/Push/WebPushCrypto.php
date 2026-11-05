<?php

declare(strict_types=1);

namespace Signalpost\Push;

/**
 * Web Push message encryption (RFC 8291, "aes128gcm" content coding, RFC 8188)
 * and VAPID authentication (RFC 8292), implemented with PHP's OpenSSL
 * extension only — no Composer packages or external services.
 */
final class WebPushCrypto
{
    /** DER prefix of a SubjectPublicKeyInfo for an uncompressed P-256 point. */
    private const P256_SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';
    private const RECORD_SIZE = 4096;

    public static function b64urlEncode(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    public static function b64urlDecode(string $s): string
    {
        $out = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
        if ($out === false) {
            throw new \InvalidArgumentException('Invalid base64url.');
        }
        return $out;
    }

    /** @return array{private_pem:string, public:string} public = 65-byte uncompressed point */
    public static function generateKeyPair(): array
    {
        $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
        if ($key === false) {
            throw new \RuntimeException('Could not generate an EC key pair (OpenSSL).');
        }
        openssl_pkey_export($key, $pem);
        return ['private_pem' => $pem, 'public' => self::publicPoint($key)];
    }

    /** Builds a private key from a raw 32-byte scalar (used for RFC test vectors). */
    public static function privateKeyFromRaw(string $d, string $publicPoint): string
    {
        // RFC 5915 ECPrivateKey with named curve and public key, DER-encoded.
        $der = "\x30\x77\x02\x01\x01\x04\x20" . str_pad($d, 32, "\0", STR_PAD_LEFT)
            . "\xa0\x0a\x06\x08\x2a\x86\x48\xce\x3d\x03\x01\x07"
            . "\xa1\x44\x03\x42\x00" . $publicPoint;
        return "-----BEGIN EC PRIVATE KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END EC PRIVATE KEY-----\n";
    }

    public static function publicKeyPem(string $point): string
    {
        if (strlen($point) !== 65 || $point[0] !== "\x04") {
            throw new \InvalidArgumentException('Expected an uncompressed P-256 public key.');
        }
        $der = hex2bin(self::P256_SPKI_PREFIX) . $point;
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    /** @param \OpenSSLAsymmetricKey|string $key */
    public static function publicPoint($key): string
    {
        $k = is_string($key) ? openssl_pkey_get_private($key) : $key;
        $d = openssl_pkey_get_details($k);
        if (!isset($d['ec']['x'], $d['ec']['y'])) {
            throw new \RuntimeException('Not an EC key.');
        }
        return "\x04" . str_pad($d['ec']['x'], 32, "\0", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\0", STR_PAD_LEFT);
    }

    /** True if $point is a valid point on P-256 (OpenSSL rejects anything else). */
    public static function isValidPublicKey(string $point): bool
    {
        if (strlen($point) !== 65 || $point[0] !== "\x04") {
            return false;
        }
        return openssl_pkey_get_public(self::publicKeyPem($point)) !== false;
    }

    /**
     * Encrypts $plaintext for a subscription.
     *
     * @param string      $uaPublic  subscription "p256dh" key (65 bytes)
     * @param string      $authSecret subscription "auth" secret (16 bytes)
     * @param string|null $asPrivatePem fixed sender key (tests only)
     * @param string|null $salt fixed 16-byte salt (tests only)
     * @return string request body (header + ciphertext)
     */
    public static function encrypt(string $plaintext, string $uaPublic, string $authSecret, ?string $asPrivatePem = null, ?string $salt = null): string
    {
        if (strlen($authSecret) !== 16) {
            throw new \InvalidArgumentException('Invalid auth secret.');
        }
        if (strlen($plaintext) > self::RECORD_SIZE - 17 - 86) {
            throw new \InvalidArgumentException('Push payload too large.');
        }
        $asPrivatePem ??= self::generateKeyPair()['private_pem'];
        $salt ??= random_bytes(16);
        $asPrivate = openssl_pkey_get_private($asPrivatePem);
        $asPublic = self::publicPoint($asPrivate);
        $uaKey = openssl_pkey_get_public(self::publicKeyPem($uaPublic));
        if ($uaKey === false) {
            throw new \InvalidArgumentException('Invalid subscription public key.');
        }
        $ecdh = openssl_pkey_derive($uaKey, $asPrivate, 32);
        if ($ecdh === false) {
            throw new \RuntimeException('ECDH failed.');
        }
        // RFC 8291 section 3.4
        $prkKey = hash_hmac('sha256', $ecdh, $authSecret, true);
        $ikm = hash_hmac('sha256', "WebPush: info\0" . $uaPublic . $asPublic . "\x01", $prkKey, true);
        // RFC 8188 section 2.2
        $prk = hash_hmac('sha256', $ikm, $salt, true);
        $cek = substr(hash_hmac('sha256', "Content-Encoding: aes128gcm\0\x01", $prk, true), 0, 16);
        $nonce = substr(hash_hmac('sha256', "Content-Encoding: nonce\0\x01", $prk, true), 0, 12);
        $tag = '';
        $cipher = openssl_encrypt($plaintext . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
        if ($cipher === false) {
            throw new \RuntimeException('Encryption failed.');
        }
        return $salt . pack('N', self::RECORD_SIZE) . chr(65) . $asPublic . $cipher . $tag;
    }

    /** Decrypts a message as the user agent would (used to verify round trips in tests). */
    public static function decrypt(string $body, string $uaPrivatePem, string $authSecret): string
    {
        $salt = substr($body, 0, 16);
        $idlen = ord($body[20]);
        $asPublic = substr($body, 21, $idlen);
        $payload = substr($body, 21 + $idlen);
        $uaPrivate = openssl_pkey_get_private($uaPrivatePem);
        $uaPublic = self::publicPoint($uaPrivate);
        $ecdh = openssl_pkey_derive(openssl_pkey_get_public(self::publicKeyPem($asPublic)), $uaPrivate, 32);
        $prkKey = hash_hmac('sha256', $ecdh, $authSecret, true);
        $ikm = hash_hmac('sha256', "WebPush: info\0" . $uaPublic . $asPublic . "\x01", $prkKey, true);
        $prk = hash_hmac('sha256', $ikm, $salt, true);
        $cek = substr(hash_hmac('sha256', "Content-Encoding: aes128gcm\0\x01", $prk, true), 0, 16);
        $nonce = substr(hash_hmac('sha256', "Content-Encoding: nonce\0\x01", $prk, true), 0, 12);
        $plain = openssl_decrypt(substr($payload, 0, -16), 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, substr($payload, -16));
        if ($plain === false) {
            throw new \RuntimeException('Decryption failed.');
        }
        return rtrim($plain, "\0") === '' ? '' : substr(rtrim($plain, "\0"), 0, -1);
    }

    /** RFC 8292 VAPID JWT (ES256). */
    public static function vapidJwt(string $audience, string $subject, int $expires, string $privatePem): string
    {
        $header = self::b64urlEncode('{"typ":"JWT","alg":"ES256"}');
        $claims = self::b64urlEncode((string) json_encode(['aud' => $audience, 'exp' => $expires, 'sub' => $subject], JSON_UNESCAPED_SLASHES));
        $signingInput = $header . '.' . $claims;
        if (!openssl_sign($signingInput, $der, $privatePem, OPENSSL_ALGO_SHA256)) {
            throw new \RuntimeException('VAPID signing failed.');
        }
        return $signingInput . '.' . self::b64urlEncode(self::derToRaw($der));
    }

    /** Converts an ASN.1 DER ECDSA signature into the 64-byte r||s form JWS requires. */
    public static function derToRaw(string $der): string
    {
        $pos = 2;
        if (ord($der[1]) & 0x80) {
            $pos += ord($der[1]) & 0x7f;
        }
        $parts = [];
        for ($i = 0; $i < 2; $i++) {
            $len = ord($der[$pos + 1]);
            $int = substr($der, $pos + 2, $len);
            $parts[] = str_pad(ltrim($int, "\0"), 32, "\0", STR_PAD_LEFT);
            $pos += 2 + $len;
        }
        return $parts[0] . $parts[1];
    }

    /** Converts a 64-byte r||s signature back to DER (used to verify JWTs in tests). */
    public static function rawToDer(string $raw): string
    {
        $enc = static function (string $i): string {
            $i = ltrim($i, "\0");
            if ($i === '' || ord($i[0]) & 0x80) {
                $i = "\0" . $i;
            }
            return "\x02" . chr(strlen($i)) . $i;
        };
        $seq = $enc(substr($raw, 0, 32)) . $enc(substr($raw, 32, 32));
        return "\x30" . chr(strlen($seq)) . $seq;
    }
}
