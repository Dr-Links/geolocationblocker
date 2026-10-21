<?php

declare(strict_types=1);

namespace Signalpost\Core;

/**
 * Versioned schema migrations.
 *
 * Each file in migrations/ is named NNNN_description.php and returns a list
 * of SQL statements. Applied versions are recorded in schema_migrations.
 * MySQL DDL commits implicitly, so each migration should be written to be
 * safe to re-run up to its first failing statement (CREATE TABLE IF NOT EXISTS).
 */
final class Migrator
{
    public function __construct(private readonly Database $db, private readonly string $dir)
    {
    }

    public function ensureTable(): void
    {
        $this->db->exec('CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(64) NOT NULL PRIMARY KEY,
            applied_at DATETIME NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    }

    /** @return array<string,string> version => file path, sorted. */
    public function available(): array
    {
        $files = glob($this->dir . '/[0-9][0-9][0-9][0-9]_*.php') ?: [];
        sort($files, SORT_STRING);
        $out = [];
        foreach ($files as $f) {
            $out[basename($f, '.php')] = $f;
        }
        return $out;
    }

    /** @return string[] */
    public function applied(): array
    {
        $this->ensureTable();
        return array_column($this->db->all('SELECT version FROM schema_migrations ORDER BY version'), 'version');
    }

    /** @return string[] */
    public function pending(): array
    {
        return array_values(array_diff(array_keys($this->available()), $this->applied()));
    }

    /** @return string[] versions applied */
    public function migrate(): array
    {
        $done = [];
        $available = $this->available();
        foreach ($this->pending() as $version) {
            $statements = require $available[$version];
            if (!is_array($statements)) {
                throw new \RuntimeException("Migration {$version} must return an array of SQL statements.");
            }
            foreach ($statements as $sql) {
                $this->db->pdo()->exec($sql);
            }
            $this->db->run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, UTC_TIMESTAMP())', [$version]);
            $done[] = $version;
        }
        return $done;
    }
}
