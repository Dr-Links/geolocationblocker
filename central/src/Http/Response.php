<?php

declare(strict_types=1);

namespace Signalpost\Http;

final class Response
{
    /** @var array<int,array{name:string,value:string,options:array}> */
    public array $cookies = [];
    /** When set, send() calls this to stream the body instead of echoing $body. */
    public ?\Closure $stream = null;

    public function __construct(
        public string $body = '',
        public int $status = 200,
        public array $headers = [],
    ) {
    }

    public static function json(mixed $data, int $status = 200): self
    {
        return new self(
            (string) json_encode(['ok' => $status < 400, 'data' => $data], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP),
            $status,
            ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'],
        );
    }

    public static function jsonError(int $status, string $code, string $message, array $details = []): self
    {
        $error = ['code' => $code, 'message' => $message];
        if ($details !== []) {
            $error['fields'] = $details;
        }
        return new self(
            (string) json_encode(['ok' => false, 'error' => $error], JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP),
            $status,
            ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'],
        );
    }

    public static function html(string $html, int $status = 200): self
    {
        return new self($html, $status, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-store']);
    }

    public static function redirect(string $location, int $status = 303): self
    {
        // Only same-site relative redirects are produced by the app.
        if (!str_starts_with($location, '/') || str_starts_with($location, '//')) {
            $location = '/';
        }
        return new self('', $status, ['Location' => $location, 'Cache-Control' => 'no-store']);
    }

    public function header(string $name, string $value): self
    {
        $this->headers[$name] = $value;
        return $this;
    }

    public function cookie(string $name, string $value, array $options = []): self
    {
        $this->cookies[] = ['name' => $name, 'value' => $value, 'options' => $options];
        return $this;
    }

    public function data(): mixed
    {
        $decoded = json_decode($this->body, true);
        return is_array($decoded) ? ($decoded['data'] ?? null) : null;
    }

    public function send(): void
    {
        if (!headers_sent()) {
            http_response_code($this->status);
            foreach ($this->headers as $k => $v) {
                header($k . ': ' . $v);
            }
            foreach ($this->cookies as $c) {
                setcookie($c['name'], $c['value'], $c['options']);
            }
        }
        if ($this->stream !== null) {
            ($this->stream)();
            return;
        }
        echo $this->body;
    }

    public static function download(\Closure $stream, string $filename, string $contentType = 'application/json; charset=utf-8'): self
    {
        $r = new self('', 200, [
            'Content-Type' => $contentType,
            'Content-Disposition' => 'attachment; filename="' . preg_replace('/[^A-Za-z0-9._-]/', '_', $filename) . '"',
            'Cache-Control' => 'no-store',
        ]);
        $r->stream = $stream;
        return $r;
    }
}
