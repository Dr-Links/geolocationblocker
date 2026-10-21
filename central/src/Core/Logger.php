<?php

declare(strict_types=1);

namespace Signalpost\Core;

/**
 * JSON-lines file logger with secret redaction.
 *
 * Context keys that look sensitive are replaced, and string values are
 * scrubbed for credential-shaped substrings, so callers cannot accidentally
 * log passwords, tokens, site secrets or message bodies.
 */
final class Logger
{
    private const SENSITIVE_KEY = '/pass|secret|token|authorization|cookie|body|credential|api[_-]?key|^key$|email|phone|^name$|csrf|code/i';

    public function __construct(private readonly string $dir, private readonly Clock $clock)
    {
    }

    public function error(string $message, array $context = []): void
    {
        $this->write('error', $message, $context);
    }

    public function warning(string $message, array $context = []): void
    {
        $this->write('warning', $message, $context);
    }

    public function info(string $message, array $context = []): void
    {
        $this->write('info', $message, $context);
    }

    public static function redact(mixed $value, ?string $key = null): mixed
    {
        if ($key !== null && preg_match(self::SENSITIVE_KEY, $key) === 1) {
            return '[redacted]';
        }
        if (is_array($value)) {
            $out = [];
            foreach ($value as $k => $v) {
                $out[$k] = self::redact($v, is_string($k) ? $k : null);
            }
            return $out;
        }
        if (is_string($value)) {
            return self::scrub($value);
        }
        return $value;
    }

    public static function scrub(string $text): string
    {
        $patterns = [
            '/spk_[A-Za-z0-9]+\.[A-Za-z0-9_\-]+/' => 'spk_[redacted]',
            '/\b(Bearer|Visitor)\s+[A-Za-z0-9._\-]+/i' => '$1 [redacted]',
            '/\b[0-9a-f]{40,}\b/i' => '[redacted-hex]',
            '/(password|secret|token)=([^&\s]+)/i' => '$1=[redacted]',
        ];
        return (string) preg_replace(array_keys($patterns), array_values($patterns), $text);
    }

    /** @return array<int,array> most recent entries first */
    public function recent(int $limit = 50, string $minLevel = 'warning'): array
    {
        $files = glob($this->dir . '/app-*.log') ?: [];
        rsort($files);
        $out = [];
        foreach (array_slice($files, 0, 7) as $file) {
            $lines = @file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
            foreach (array_reverse($lines) as $line) {
                $entry = json_decode($line, true);
                if (!is_array($entry)) {
                    continue;
                }
                if ($minLevel === 'warning' && ($entry['level'] ?? '') === 'info') {
                    continue;
                }
                $out[] = $entry;
                if (count($out) >= $limit) {
                    return $out;
                }
            }
        }
        return $out;
    }

    private function write(string $level, string $message, array $context): void
    {
        if (!is_dir($this->dir)) {
            @mkdir($this->dir, 0750, true);
        }
        $entry = [
            'ts' => $this->clock->now()->format('Y-m-d\TH:i:s\Z'),
            'level' => $level,
            'message' => self::scrub($message),
            'context' => self::redact($context),
        ];
        $file = $this->dir . '/app-' . $this->clock->now()->format('Y-m-d') . '.log';
        @file_put_contents($file, json_encode($entry, JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
    }
}
