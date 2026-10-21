<?php

declare(strict_types=1);

namespace Signalpost\Admin;

use Signalpost\Core\App;

/**
 * Platform-wide settings stored in the database, validated against an
 * explicit schema. Only the platform owner can change them.
 */
final class PlatformSettings
{
    public const SCHEMA = [
        // closed: nobody may self-register; invite_only: only via workspace invitations; open: anyone.
        'registration_mode' => ['type' => 'enum', 'values' => ['closed', 'invite_only', 'open'], 'default' => 'invite_only'],
        'require_email_verification' => ['type' => 'bool', 'default' => true],
        'max_workspaces_per_user' => ['type' => 'int', 'min' => 1, 'max' => 100, 'default' => 3],
        'max_websites_per_workspace' => ['type' => 'int', 'min' => 1, 'max' => 500, 'default' => 10],
        'max_members_per_workspace' => ['type' => 'int', 'min' => 1, 'max' => 500, 'default' => 20],
        'support_grant_max_hours' => ['type' => 'int', 'min' => 1, 'max' => 168, 'default' => 24],
    ];

    private ?array $cache = null;

    public function __construct(private readonly App $app)
    {
    }

    public function all(): array
    {
        if ($this->cache === null) {
            $values = [];
            foreach (self::SCHEMA as $k => $def) {
                $values[$k] = $def['default'];
            }
            foreach ($this->app->db()->all('SELECT name, value FROM platform_settings') as $row) {
                if (isset(self::SCHEMA[$row['name']])) {
                    $decoded = json_decode($row['value'], true);
                    if ($this->valid($row['name'], $decoded)) {
                        $values[$row['name']] = $decoded;
                    }
                }
            }
            $this->cache = $values;
        }
        return $this->cache;
    }

    public function get(string $name): mixed
    {
        return $this->all()[$name];
    }

    /** Internal (non-schema) key-value state, e.g. last cron run. */
    public function getState(string $name): ?string
    {
        $v = $this->app->db()->value('SELECT value FROM platform_settings WHERE name = ?', ['state.' . $name]);
        return $v === null ? null : (string) $v;
    }

    public function setState(string $name, string $value): void
    {
        $this->app->db()->exec(
            'INSERT INTO platform_settings (name, value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
            ['state.' . $name, $value, $this->app->clock->sql()]
        );
    }

    /** @return string[] changed keys */
    public function update(array $input): array
    {
        $changed = [];
        $current = $this->all();
        foreach (self::SCHEMA as $k => $def) {
            if (!array_key_exists($k, $input)) {
                continue;
            }
            $v = $this->coerce($k, $input[$k]);
            if (!$this->valid($k, $v)) {
                throw \Signalpost\Core\HttpException::validation([$k => 'Invalid value.']);
            }
            if ($v !== $current[$k]) {
                $this->app->db()->exec(
                    'INSERT INTO platform_settings (name, value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)',
                    [$k, json_encode($v), $this->app->clock->sql()]
                );
                $changed[] = $k;
            }
        }
        $this->cache = null;
        return $changed;
    }

    private function coerce(string $k, mixed $v): mixed
    {
        return match (self::SCHEMA[$k]['type']) {
            'bool' => in_array($v, [true, 1, '1', 'on', 'true'], true),
            'int' => is_string($v) && ctype_digit($v) ? (int) $v : $v,
            default => $v,
        };
    }

    private function valid(string $k, mixed $v): bool
    {
        $def = self::SCHEMA[$k];
        return match ($def['type']) {
            'enum' => is_string($v) && in_array($v, $def['values'], true),
            'bool' => is_bool($v),
            'int' => is_int($v) && $v >= $def['min'] && $v <= $def['max'],
            default => false,
        };
    }
}
