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
