<?php

declare(strict_types=1);

namespace Signalpost\Sites;

use Signalpost\Core\HttpException;

/**
 * Explicit schemas for per-website JSON settings. Nothing is stored unless
 * it passes validation here; unknown keys are dropped.
 */
final class SettingsSchema
{
    public const DEFAULT_EXCLUDED_PATHS = [
        '/wp-admin', '/wp-login.php', '/checkout', '/cart', '/my-account', '/account', '/login', '/register', '/password', '/payment',
    ];

    public const WIDGET = [
        'enabled' => ['bool', true],
        'brand_name' => ['string', '', 0, 40],
        'primary_color' => ['color', '#155254'],
        'position' => ['enum', 'right', ['right', 'left']],
        'offset_px' => ['int', 20, 0, 80],
        'launcher_label' => ['string', 'Chat with us', 1, 30],
        'greeting_title' => ['string', 'Hi there!', 1, 60],
        'welcome_message' => ['string', 'Ask us anything. We usually reply within a few minutes.', 0, 300],
        'prechat_name' => ['enum', 'off', ['off', 'optional', 'required']],
        'prechat_email' => ['enum', 'off', ['off', 'optional', 'required']],
        'prechat_phone' => ['enum', 'off', ['off', 'optional', 'required']],
        'prechat_notice' => ['string', '', 0, 300],
        // Paths where the widget is not loaded at all.
        'hidden_paths' => ['paths', []],
        'show_branding' => ['bool', true],
        // A visitor writing after a conversation was closed reopens it within this window; otherwise a new one starts.
        'reopen_window_hours' => ['int', 24, 0, 720],
        // What happens to existing conversations when a visitor is blocked.
        'block_conversation_action' => ['enum', 'read_only', ['read_only', 'close']],
    ];

    public const TRACKING = [
        // Optional analytics master switch. Essential chat works regardless.
        'analytics_enabled' => ['bool', false],
        // consent: analytics only after an explicit opt-in recorded for the visitor.
        // other: operator has determined another legal basis applies; visitors can still object (withdraw).
        'legal_basis' => ['enum', 'consent', ['consent', 'other']],
        'policy_version' => ['string', '1', 1, 32, '/^[A-Za-z0-9._\-]+$/'],
        // Where the consent signal comes from: the widget's own prompt, the WP Consent API, or a custom JS call.
        'consent_source' => ['enum', 'widget', ['widget', 'wp_consent_api', 'custom']],
        'excluded_paths' => ['paths', self::DEFAULT_EXCLUDED_PATHS],
        'record_page_titles' => ['bool', false],
        'record_referrer' => ['bool', false],
        'estimate_country' => ['bool', false],
        'collect_browser' => ['bool', false],
        'session_timeout_minutes' => ['int', 30, 5, 240],
    ];

    public const RETENTION = [
        'events_days' => ['int', 90, 1, 3650],
        'sessions_days' => ['int', 90, 1, 3650],
        'contacts_days' => ['int', 365, 1, 3650],
        'visitor_inactive_days' => ['int', 395, 1, 3650],
        // 0 keeps conversations until manually deleted.
        'conversations_days' => ['int', 730, 0, 3650],
        'consent_days' => ['int', 1095, 30, 3650],
    ];

    public static function defaults(array $schema): array
    {
        $out = [];
        foreach ($schema as $k => $def) {
            $out[$k] = $def[1];
        }
        return $out;
    }

    /**
     * Validates $input against $schema. Keys absent from $input keep $current values.
     *
     * @throws HttpException 422 with per-field errors
     */
    public static function validate(array $schema, array $input, array $current): array
    {
        $out = self::defaults($schema);
        foreach ($current as $k => $v) {
            if (isset($schema[$k])) {
                $out[$k] = $v;
            }
        }
        $errors = [];
        foreach ($schema as $key => $def) {
            if (!array_key_exists($key, $input)) {
                continue;
            }
            [$type] = $def;
            $v = $input[$key];
            switch ($type) {
                case 'bool':
                    $out[$key] = in_array($v, [true, 1, '1', 'on', 'true', 'yes'], true);
                    break;
                case 'int':
                    if (is_string($v) && preg_match('/^-?\d{1,6}$/', $v) === 1) {
                        $v = (int) $v;
                    }
                    if (!is_int($v) || $v < $def[2] || $v > $def[3]) {
                        $errors[$key] = "Must be between {$def[2]} and {$def[3]}.";
                    } else {
                        $out[$key] = $v;
                    }
                    break;
                case 'string':
                    if (!is_string($v)) {
                        $errors[$key] = 'Must be text.';
                        break;
                    }
                    $v = trim((string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $v));
                    $len = mb_strlen($v);
                    if (!mb_check_encoding($v, 'UTF-8') || $len < $def[2] || $len > $def[3]) {
                        $errors[$key] = "Must be {$def[2]}–{$def[3]} characters.";
                    } elseif (isset($def[4]) && preg_match($def[4], $v) !== 1) {
                        $errors[$key] = 'Invalid format.';
                    } else {
                        $out[$key] = $v;
                    }
                    break;
                case 'enum':
                    if (!is_string($v) || !in_array($v, $def[2], true)) {
                        $errors[$key] = 'Invalid value.';
                    } else {
                        $out[$key] = $v;
                    }
                    break;
                case 'color':
                    if (!is_string($v) || preg_match('/^#[0-9a-fA-F]{6}$/', $v) !== 1) {
                        $errors[$key] = 'Use a colour like #155254.';
                    } else {
                        $out[$key] = strtolower($v);
                    }
                    break;
                case 'paths':
                    $paths = self::parsePaths($v);
                    if ($paths === null) {
                        $errors[$key] = 'Enter up to 50 paths starting with "/", one per line.';
                    } else {
                        $out[$key] = $paths;
                    }
                    break;
            }
        }
        if ($errors !== []) {
            throw HttpException::validation($errors);
        }
        return $out;
    }

    /** Accepts an array or newline-separated text. Returns normalised path prefixes or null if invalid. */
    public static function parsePaths(mixed $v): ?array
    {
        if (is_string($v)) {
            $v = preg_split('/[\r\n,]+/', $v) ?: [];
        }
        if (!is_array($v)) {
            return null;
        }
        $out = [];
        foreach ($v as $p) {
            if (!is_string($p)) {
                return null;
            }
            $p = trim($p);
            if ($p === '') {
                continue;
            }
            if ($p[0] !== '/' || strlen($p) > 200 || preg_match('/[\s<>"\'\\\\?#]/', $p) === 1) {
                return null;
            }
            $out[] = rtrim($p, '/') ?: '/';
        }
        $out = array_values(array_unique($out));
        return count($out) > 50 ? null : $out;
    }

    /** True if $path equals or is below any prefix in $prefixes. */
    public static function pathMatches(string $path, array $prefixes): bool
    {
        $path = '/' . ltrim(strtolower($path), '/');
        foreach ($prefixes as $prefix) {
            $prefix = strtolower((string) $prefix);
            if ($prefix === '/' || $path === $prefix || str_starts_with($path, rtrim($prefix, '/') . '/')
                || (str_ends_with($prefix, '.php') && str_starts_with($path, $prefix))) {
                return true;
            }
        }
        return false;
    }
}
