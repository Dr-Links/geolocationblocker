<?php

declare(strict_types=1);

namespace Signalpost\Security;

/**
 * Coarse user-agent classification: browser family and OS family only.
 * No versions, device models or other high-entropy values are retained,
 * so the output cannot meaningfully fingerprint a visitor.
 */
final class UserAgent
{
    /** @return array{browser:string,os:string} */
    public static function parse(?string $ua): array
    {
        $ua = (string) $ua;
        $browser = match (true) {
            $ua === '' => 'Unknown',
            (bool) preg_match('/bot|crawl|spider|slurp/i', $ua) => 'Bot',
            str_contains($ua, 'Edg/') => 'Edge',
            str_contains($ua, 'OPR/') || str_contains($ua, 'Opera') => 'Opera',
            str_contains($ua, 'SamsungBrowser') => 'Samsung Internet',
            str_contains($ua, 'Firefox/') || str_contains($ua, 'FxiOS') => 'Firefox',
            str_contains($ua, 'Chrome/') || str_contains($ua, 'CriOS') => 'Chrome',
            str_contains($ua, 'Safari/') => 'Safari',
            default => 'Other',
        };
        $os = match (true) {
            $ua === '' => 'Unknown',
            str_contains($ua, 'Windows') => 'Windows',
            str_contains($ua, 'Android') => 'Android',
            (bool) preg_match('/iPhone|iPad|iPod/', $ua) => 'iOS',
            str_contains($ua, 'Mac OS X') || str_contains($ua, 'Macintosh') => 'macOS',
            str_contains($ua, 'CrOS') => 'ChromeOS',
            str_contains($ua, 'Linux') => 'Linux',
            default => 'Other',
        };
        return ['browser' => $browser, 'os' => $os];
    }

    public static function summary(?string $ua): string
    {
        $p = self::parse($ua);
        return $p['browser'] . ' on ' . $p['os'];
    }
}
