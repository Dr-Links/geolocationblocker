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
                'create-owner' => $this->createOwner($opts),
                'cron:run' => $this->cronRun(),
                'cleanup' => $this->cleanup($opts),
                'geo:import' => $this->geoImport($args[1] ?? ''),
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
  cron:run                     Run scheduled maintenance (retention cleanup). Use from cPanel cron.
  cleanup [--dry-run] [--workspace=ID]
                               Run retention cleanup now; --dry-run only counts
  geo:import FILE.csv          Import an IP-to-country CSV (start_ip,end_ip,country_code)
  create-owner --email=E --name=N --workspace=W
                               Create the first platform owner (prompts for the password;
                               or set SIGNALPOST_OWNER_PASSWORD for non-interactive use)

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

    private function createOwner(array $opts): int
    {
        foreach (['email', 'name', 'workspace'] as $k) {
            if (!is_string($opts[$k] ?? null) || $opts[$k] === '') {
                fwrite(STDERR, "Missing --{$k}=...\n");
                return 1;
            }
        }
        $email = strtolower(trim($opts['email']));
        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            fwrite(STDERR, "Invalid email.\n");
            return 1;
        }
        $this->app->migrator()->migrate();
        $password = getenv('SIGNALPOST_OWNER_PASSWORD') ?: '';
        if ($password === '') {
            $password = $this->promptHidden('Owner password: ');
            if ($password !== $this->promptHidden('Repeat password: ')) {
                fwrite(STDERR, "Passwords do not match.\n");
                return 1;
            }
        }
        try {
            $id = $this->app->get(\Signalpost\Auth\AuthService::class)->createPlatformOwner($email, $password, mb_substr($opts['name'], 0, 100), mb_substr($opts['workspace'], 0, 100));
        } catch (HttpException $e) {
            fwrite(STDERR, $e->getMessage() . ' ' . implode(' ', $e->details) . "\n");
            return 1;
        }
        @unlink($this->app->config->get('paths.storage') . '/setup-token.txt');
        echo "Platform owner created (user #{$id}). You can sign in now.\n";
        return 0;
    }

    private function cronRun(): int
    {
        $lock = fopen($this->app->config->get('paths.storage') . '/cache/cron.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
            echo "Another cron run is in progress.\n";
            return 0;
        }
        $report = $this->app->get(\Signalpost\Privacy\RetentionService::class)->run(false);
        $this->app->get(\Signalpost\Admin\PlatformSettings::class)->setState('last_cron_run', $this->app->clock->sql());
        $this->app->logger()->info('cron run', ['totals' => $report['totals'], 'complete' => $report['complete']]);
        echo 'Cleanup: ' . json_encode($report['totals']) . ($report['complete'] ? '' : ' (more remains; next run continues)') . "\n";
        flock($lock, LOCK_UN);
        return 0;
    }

    private function cleanup(array $opts): int
    {
        $dry = isset($opts['dry-run']);
        $ws = isset($opts['workspace']) && is_string($opts['workspace']) && ctype_digit($opts['workspace']) ? (int) $opts['workspace'] : null;
        $report = $this->app->get(\Signalpost\Privacy\RetentionService::class)->run($dry, $ws);
        echo ($dry ? "Dry run (nothing deleted). Eligible:\n" : "Deleted:\n");
        foreach ($report['totals'] as $k => $n) {
            echo sprintf("  %-24s %d\n", $k, $n);
        }
        if (!$report['complete']) {
            echo "More eligible data remains; run again.\n";
        }
        return 0;
    }

    private function geoImport(string $file): int
    {
        if ($file === '' || !is_file($file)) {
            fwrite(STDERR, "Usage: geo:import FILE.csv\n");
            return 1;
        }
        $n = $this->app->get(\Signalpost\Visitors\GeoService::class)->import($file);
        echo "Imported {$n} ranges. Set 'geo' => ['provider' => 'table'] in config.php to use them.\n";
        return 0;
    }

    private function promptHidden(string $prompt): string
    {
        echo $prompt;
        $tty = function_exists('posix_isatty') && posix_isatty(STDIN);
        if ($tty) {
            shell_exec('stty -echo');
        }
        $line = rtrim((string) fgets(STDIN), "\r\n");
        if ($tty) {
            shell_exec('stty echo');
            echo "\n";
        }
        return $line;
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
