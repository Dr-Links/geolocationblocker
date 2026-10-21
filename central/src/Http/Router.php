<?php

declare(strict_types=1);

namespace Signalpost\Http;

use Signalpost\Core\HttpException;

/**
 * Minimal router. Patterns use {name} placeholders matching one path segment.
 * Each route carries a "guard" that the kernel applies before the handler:
 *   public | guest | session | integration | widget
 */
final class Router
{
    /** @var array<int,array{method:string,regex:string,handler:callable|array,guard:string,opts:array}> */
    private array $routes = [];

    public function add(string $method, string $pattern, callable|array $handler, string $guard = 'public', array $opts = []): void
    {
        $regex = '#^' . preg_replace('#\{([a-zA-Z_]+)\}#', '(?P<$1>[A-Za-z0-9_\-]+)', $pattern) . '$#';
        $this->routes[] = ['method' => $method, 'regex' => $regex, 'handler' => $handler, 'guard' => $guard, 'opts' => $opts];
    }

    public function get(string $p, callable|array $h, string $guard = 'public', array $opts = []): void
    {
        $this->add('GET', $p, $h, $guard, $opts);
    }

    public function post(string $p, callable|array $h, string $guard = 'public', array $opts = []): void
    {
        $this->add('POST', $p, $h, $guard, $opts);
    }

    public function put(string $p, callable|array $h, string $guard = 'public', array $opts = []): void
    {
        $this->add('PUT', $p, $h, $guard, $opts);
    }

    public function delete(string $p, callable|array $h, string $guard = 'public', array $opts = []): void
    {
        $this->add('DELETE', $p, $h, $guard, $opts);
    }

    /** @return array{handler:callable|array,guard:string,opts:array,params:array} */
    public function match(string $method, string $path): array
    {
        $allowed = [];
        $lookup = $method === 'HEAD' ? 'GET' : $method;
        foreach ($this->routes as $r) {
            if (preg_match($r['regex'], $path, $m) !== 1) {
                continue;
            }
            if ($r['method'] !== $lookup) {
                $allowed[] = $r['method'];
                continue;
            }
            $params = array_filter($m, 'is_string', ARRAY_FILTER_USE_KEY);
            return ['handler' => $r['handler'], 'guard' => $r['guard'], 'opts' => $r['opts'], 'params' => $params];
        }
        if ($allowed !== []) {
            if ($method === 'OPTIONS') {
                return ['handler' => 'preflight', 'guard' => 'public', 'opts' => ['allowed' => $allowed], 'params' => []];
            }
            throw new HttpException(405, 'method_not_allowed', 'Method not allowed.');
        }
        throw HttpException::notFound();
    }
}
