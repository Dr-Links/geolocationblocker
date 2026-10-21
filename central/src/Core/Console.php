<?php

declare(strict_types=1);

namespace Signalpost\Core;

/**
 * Command-line entry point (cPanel Terminal / SSH / cron).
 */
final class Console
{
    public function __construct(private readonly App $app)
    {
    }

    public function run(array $args): int
    {
        $command = $args[0] ?? 'help';
        $opts = $this->parseOptions(array_slice($args, 1));
        try {
            return match ($command) {
                'key:generate' => $this->keyGenerate(),
                'migrate' => $this->migrate(),
                'migrate:status' => $this->migrateStatus(),
                default => $this->help(),
            };
        } catch (\Throwable $e) {
            fwrite(STDERR, 'Error: ' . Logger::scrub($e->getMessage()) . "\n");
            return 1;
        }
    }

    private function help(): int
    {
        echo <<<TXT
Signalpost console

  key:generate                 Print a new random application key for config.php
  migrate                      Apply pending database migrations
  migrate:status               List applied and pending migrations

TXT;
        return 0;
    }

    private function keyGenerate(): int
    {
        echo bin2hex(random_bytes(32)) . "\n";
        return 0;
    }

    private function migrate(): int
    {
        $done = $this->app->migrator()->migrate();
        echo $done === [] ? "Nothing to migrate.\n" : 'Applied: ' . implode(', ', $done) . "\n";
        return 0;
    }

    private function migrateStatus(): int
    {
        $m = $this->app->migrator();
        foreach ($m->applied() as $v) {
            echo "[applied] {$v}\n";
        }
        foreach ($m->pending() as $v) {
            echo "[pending] {$v}\n";
        }
        return 0;
    }

    /** @return array<string,string|bool> */
    private function parseOptions(array $args): array
    {
        $out = [];
        foreach ($args as $a) {
            if (preg_match('/^--([a-z\-]+)(?:=(.*))?$/', $a, $m) === 1) {
                $out[$m[1]] = $m[2] ?? true;
            }
        }
        return $out;
    }
}
