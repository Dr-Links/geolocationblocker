<?php

declare(strict_types=1);

namespace Signalpost\Http;

/**
 * Determines the client IP. Forwarding headers are honoured only when the
 * direct peer is an explicitly configured trusted proxy; otherwise the
 * socket address is used and client-supplied headers are ignored.
 */
final class ClientIp
{
    /** @param string[] $trustedProxies IPs or CIDRs */
    public static function resolve(Request $request, array $trustedProxies): string
    {
        $peer = $request->remoteAddr;
        if ($trustedProxies === [] || !self::inAny($peer, $trustedProxies)) {
            return $peer;
        }
        $xff = (string) $request->header('x-forwarded-for');
        if ($xff === '') {
            return $peer;
        }
        // Walk right-to-left, skipping trusted proxies; the first untrusted hop is the client.
        $hops = array_reverse(array_map('trim', explode(',', $xff)));
        foreach ($hops as $hop) {
            if (filter_var($hop, FILTER_VALIDATE_IP) === false) {
                return $peer;
            }
            if (!self::inAny($hop, $trustedProxies)) {
                return $hop;
            }
        }
        return $peer;
    }

    public static function isTrustedPeer(Request $request, array $trustedProxies): bool
    {
        return $trustedProxies !== [] && self::inAny($request->remoteAddr, $trustedProxies);
    }

    public static function inAny(string $ip, array $ranges): bool
    {
        foreach ($ranges as $range) {
            if (self::inRange($ip, (string) $range)) {
                return true;
            }
        }
        return false;
    }

    public static function inRange(string $ip, string $range): bool
    {
        $ipBin = @inet_pton($ip);
        if ($ipBin === false) {
            return false;
        }
        if (!str_contains($range, '/')) {
            $r = @inet_pton($range);
            return $r !== false && $r === $ipBin;
        }
        [$net, $bits] = explode('/', $range, 2);
        $netBin = @inet_pton($net);
        if ($netBin === false || strlen($netBin) !== strlen($ipBin) || !ctype_digit($bits)) {
            return false;
        }
        $bits = (int) $bits;
        $bytes = intdiv($bits, 8);
        if (substr($ipBin, 0, $bytes) !== substr($netBin, 0, $bytes)) {
            return false;
        }
        $rem = $bits % 8;
        if ($rem === 0) {
            return true;
        }
        $mask = chr((0xFF << (8 - $rem)) & 0xFF);
        return (($ipBin[$bytes] & $mask) === ($netBin[$bytes] & $mask));
    }

    /** Masks an IP for routine display: IPv4 /24, IPv6 /48. */
    public static function mask(string $ip): string
    {
        $bin = @inet_pton($ip);
        if ($bin === false) {
            return 'unknown';
        }
        if (strlen($bin) === 4) {
            return inet_ntop(substr($bin, 0, 3) . "\0") . '/24';
        }
        return inet_ntop(substr($bin, 0, 6) . str_repeat("\0", 10)) . '/48';
    }
}
