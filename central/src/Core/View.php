<?php

declare(strict_types=1);

namespace Signalpost\Core;

/**
 * Plain-PHP template renderer. Templates must output dynamic values through
 * $this->e() (HTML escaping); there is no "raw" helper for user content.
 */
final class View
{
    private array $shared = [];
    private ?string $content = null;

    public function __construct(private readonly App $app)
    {
    }

    public function share(string $key, mixed $value): void
    {
        $this->shared[$key] = $value;
    }

    public function render(string $template, array $vars = [], ?string $layout = 'layout_app'): string
    {
        $body = $this->renderFile($template, $vars);
        if ($layout === null) {
            return $body;
        }
        $this->content = $body;
        try {
            return $this->renderFile($layout, $vars);
        } finally {
            $this->content = null;
        }
    }

    public function partial(string $template, array $vars = []): string
    {
        return $this->renderFile($template, $vars);
    }

    public function content(): string
    {
        return (string) $this->content;
    }

    public function e(mixed $value): string
    {
        return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    /** Formats a UTC DATETIME string as ISO-8601 for <time datetime>. */
    public function iso(?string $sqlTime): string
    {
        return $sqlTime ? str_replace(' ', 'T', $sqlTime) . 'Z' : '';
    }

    public function time(?string $sqlTime): string
    {
        if (!$sqlTime) {
            return '<span class="muted">—</span>';
        }
        return '<time datetime="' . $this->e($this->iso($sqlTime)) . '" data-local>' . $this->e($sqlTime) . ' UTC</time>';
    }

    public function shared(string $key, mixed $default = null): mixed
    {
        return $this->shared[$key] ?? $default;
    }

    public function app(): App
    {
        return $this->app;
    }

    private function renderFile(string $template, array $vars): string
    {
        if (preg_match('/^[a-z0-9_\/]+$/', $template) !== 1) {
            throw new \InvalidArgumentException('Invalid template name.');
        }
        $file = SIGNALPOST_ROOT . '/templates/' . $template . '.php';
        $vars = $vars + $this->shared;
        $render = function () use ($file, $vars): string {
            extract($vars, EXTR_SKIP);
            ob_start();
            try {
                require $file;
                return (string) ob_get_clean();
            } catch (\Throwable $e) {
                ob_end_clean();
                throw $e;
            }
        };
        return \Closure::bind($render, $this, self::class)();
    }
}
