<?php

declare(strict_types=1);

namespace Signalpost\Core;

use Signalpost\Http\ClientIp;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Http\Router;

/**
 * Application kernel and lightweight service locator.
 *
 * Services are classes with a constructor taking the App; they are created
 * lazily and shared for the lifetime of the App (one request in production).
 */
final class App
{
    public readonly Clock $clock;
    private array $services = [];
    private ?Database $db = null;
    private ?Logger $logger = null;
    private ?Router $router = null;

    public function __construct(public readonly Config $config)
    {
        $this->clock = new Clock();
    }

    public function db(): Database
    {
        return $this->db ??= new Database($this->config);
    }

    public function logger(): Logger
    {
        return $this->logger ??= new Logger($this->config->get('paths.storage') . '/logs', $this->clock);
    }

    /**
     * @template T of object
     * @param class-string<T> $class
     * @return T
     */
    public function get(string $class): object
    {
        return $this->services[$class] ??= new $class($this);
    }

    /** Replace a service (tests use this to swap the mailer, etc.). */
    public function set(string $class, object $instance): void
    {
        $this->services[$class] = $instance;
    }

    public function migrator(): Migrator
    {
        return new Migrator($this->db(), SIGNALPOST_ROOT . '/migrations');
    }

    public function router(): Router
    {
        if ($this->router === null) {
            $this->router = new Router();
            (require SIGNALPOST_ROOT . '/routes.php')($this->router);
        }
        return $this->router;
    }

    public function clientIp(Request $request): string
    {
        return ClientIp::resolve($request, (array) $this->config->get('security.trusted_proxies', []));
    }

    public function isSecure(Request $request): bool
    {
        if ($request->secure) {
            return true;
        }
        return ClientIp::isTrustedPeer($request, (array) $this->config->get('security.trusted_proxies', []))
            && strtolower((string) $request->header('x-forwarded-proto')) === 'https';
    }

    public function handle(Request $request): Response
    {
        try {
            $response = $this->dispatch($request);
        } catch (HttpException $e) {
            $response = $this->errorResponse($request, $e);
        } catch (\PDOException $e) {
            // Fresh installation: the schema does not exist yet. Send people to the installer.
            if (($e->errorInfo[0] ?? $e->getCode()) === '42S02' && $request->method === 'GET'
                && !str_starts_with($request->path, '/api/') && $request->path !== '/install') {
                return $this->applySecurityHeaders($request, Response::redirect('/install'));
            }
            $response = $this->unhandled($request, $e);
        } catch (\Throwable $e) {
            $response = $this->unhandled($request, $e);
        }
        return $this->applySecurityHeaders($request, $response);
    }

    private function unhandled(Request $request, \Throwable $e): Response
    {
        $ref = bin2hex(random_bytes(6));
        $this->logger()->error('Unhandled exception', [
            'ref' => $ref,
            'type' => $e::class,
            'message' => $e->getMessage(),
            'file' => basename($e->getFile()) . ':' . $e->getLine(),
            'path' => $request->path,
        ]);
        return $this->errorResponse(
            $request,
            new HttpException(500, 'server_error', 'An internal error occurred. Reference: ' . $ref)
        );
    }

    private function dispatch(Request $request): Response
    {
        $maxBytes = $this->config->int('limits.max_request_bytes');
        if (strlen($request->body) > $maxBytes || (int) $request->header('content-length') > $maxBytes) {
            throw new HttpException(413, 'payload_too_large', 'The request body is too large.');
        }

        if ($this->config->get('security.force_https') && !$this->isSecure($request)) {
            if ($request->method === 'GET' && !str_starts_with($request->path, '/api/')) {
                $host = parse_url((string) $this->config->get('app.url'), PHP_URL_HOST) ?: 'localhost';
                return new Response('', 301, ['Location' => 'https://' . $host . $request->path]);
            }
            throw new HttpException(403, 'https_required', 'HTTPS is required.');
        }

        $route = $this->router()->match($request->method, $request->path);
        $request->params = $route['params'];

        if ($route['handler'] === 'preflight') {
            return $this->get(\Signalpost\Visitors\WidgetGuard::class)->preflight($request, $route['opts']['allowed']);
        }

        $guard = match ($route['guard']) {
            'public' => null,
            'guest', 'session' => $this->get(\Signalpost\Auth\SessionGuard::class),
            'integration' => $this->get(\Signalpost\Sites\IntegrationGuard::class),
            'widget' => $this->get(\Signalpost\Visitors\WidgetGuard::class),
            default => throw new \LogicException('Unknown guard'),
        };
        $guard?->before($request, $route['guard'], $route['opts']);

        [$class, $method] = $route['handler'];
        $response = $this->get($class)->$method($request);

        if ($guard !== null && method_exists($guard, 'after')) {
            $response = $guard->after($request, $response);
        }
        return $response;
    }

    private function errorResponse(Request $request, HttpException $e): Response
    {
        if ($request->wantsJson()) {
            $response = Response::jsonError($e->status, $e->errorCode, $e->getMessage(), $e->details);
        } elseif ($e->status === 401) {
            $response = Response::redirect('/login');
        } else {
            $response = Response::html($this->get(View::class)->render('error', [
                'status' => $e->status,
                'message' => $e->getMessage(),
            ], 'layout_plain'), $e->status);
        }
        if ($e->status === 429) {
            $response->header('Retry-After', '60');
        }
        // Widget routes need CORS headers on errors too, so the widget can read them.
        if (isset($request->attributes['cors_origin'])) {
            $response->header('Access-Control-Allow-Origin', $request->attributes['cors_origin'])->header('Vary', 'Origin');
        }
        return $response;
    }

    private function applySecurityHeaders(Request $request, Response $response): Response
    {
        $h = [
            'X-Content-Type-Options' => 'nosniff',
            'Referrer-Policy' => 'strict-origin-when-cross-origin',
        ];
        if (!str_starts_with($request->path, '/api/v1/widget/')) {
            $h['X-Frame-Options'] = 'DENY';
            $h['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
        }
        if ($this->isSecure($request)) {
            $h['Strict-Transport-Security'] = 'max-age=31536000';
        }
        foreach ($h as $k => $v) {
            $response->headers[$k] ??= $v;
        }
        return $response;
    }
}
