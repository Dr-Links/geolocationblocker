<?php

declare(strict_types=1);

namespace Signalpost\Http;

use Signalpost\Core\HttpException;

final class Request
{
    /** Route parameters set by the router. */
    public array $params = [];
    /** Per-request attributes set by middleware (auth context, etc.). */
    public array $attributes = [];
    private ?array $jsonCache = null;

    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query = [],
        public readonly array $post = [],
        private readonly array $headers = [],
        public readonly array $cookies = [],
        public readonly string $body = '',
        public readonly string $remoteAddr = '127.0.0.1',
        public readonly bool $secure = false,
    ) {
    }

    public static function fromGlobals(): self
    {
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = (string) $v;
            } elseif (in_array($k, ['CONTENT_TYPE', 'CONTENT_LENGTH'], true)) {
                $headers[strtolower(str_replace('_', '-', $k))] = (string) $v;
            }
        }
        if (!isset($headers['authorization']) && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
            $headers['authorization'] = (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
        }
        $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        // Support installs in a sub-directory: strip the script directory prefix.
        $base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '')), '/');
        if ($base !== '' && str_starts_with($path, $base)) {
            $path = substr($path, strlen($base)) ?: '/';
        }
        $body = '';
        $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($len > 0) {
            // Read at most 1 byte more than the hard cap so oversize bodies are detectable.
            $body = (string) stream_get_contents(fopen('php://input', 'rb'), 1048577);
        }
        return new self(
            strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'),
            '/' . ltrim($path, '/'),
            $_GET,
            $_POST,
            $headers,
            $_COOKIE,
            $body,
            (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'),
            (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['SERVER_PORT'] ?? '') === '443'),
        );
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function headers(): array
    {
        return $this->headers;
    }

    public function cookie(string $name): ?string
    {
        $v = $this->cookies[$name] ?? null;
        return is_string($v) ? $v : null;
    }

    public function isJson(): bool
    {
        return str_contains((string) $this->header('content-type'), 'application/json');
    }

    public function wantsJson(): bool
    {
        return str_starts_with($this->path, '/api/') || $this->isJson()
            || str_contains((string) $this->header('accept'), 'application/json');
    }

    /** Decoded JSON body (object only). Throws 400 for malformed JSON. */
    public function json(): array
    {
        if ($this->jsonCache !== null) {
            return $this->jsonCache;
        }
        if ($this->body === '') {
            return $this->jsonCache = [];
        }
        try {
            $data = json_decode($this->body, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw HttpException::badRequest('Malformed JSON body.');
        }
        if (!is_array($data) || array_is_list($data) && $data !== []) {
            throw HttpException::badRequest('JSON body must be an object.');
        }
        return $this->jsonCache = $data;
    }

    /** Input from JSON body or form post. */
    public function input(string $key, mixed $default = null): mixed
    {
        $src = $this->isJson() ? $this->json() : $this->post;
        return $src[$key] ?? $default;
    }

    public function allInput(): array
    {
        return $this->isJson() ? $this->json() : $this->post;
    }

    public function param(string $name): string
    {
        return (string) ($this->params[$name] ?? '');
    }

    public function intParam(string $name): int
    {
        $v = $this->param($name);
        if (preg_match('/^[1-9][0-9]{0,18}$/', $v) !== 1) {
            throw HttpException::notFound();
        }
        return (int) $v;
    }

    public function queryString(string $key, string $default = ''): string
    {
        $v = $this->query[$key] ?? $default;
        return is_string($v) ? $v : $default;
    }

    public function queryInt(string $key, int $default = 0, int $min = 0, int $max = PHP_INT_MAX): int
    {
        $v = $this->query[$key] ?? null;
        if (!is_string($v) || preg_match('/^-?[0-9]{1,18}$/', $v) !== 1) {
            return $default;
        }
        return max($min, min($max, (int) $v));
    }

    public function withAttribute(string $key, mixed $value): self
    {
        $this->attributes[$key] = $value;
        return $this;
    }
}
