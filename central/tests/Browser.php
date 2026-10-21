<?php

declare(strict_types=1);

namespace Signalpost\Tests;

use Signalpost\Core\App;
use Signalpost\Http\Request;
use Signalpost\Http\Response;

/**
 * In-process HTTP client with a cookie jar. Requests go through the full
 * kernel (routing, guards, CSRF, error handling), without a web server.
 */
final class Browser
{
    public array $cookies = [];
    public ?Response $last = null;
    public string $csrf = '';

    public function __construct(private readonly App $app)
    {
    }

    /**
     * @param array{json?:array,form?:array,headers?:array,query?:array,raw?:string,ip?:string,secure?:bool} $opts
     */
    public function request(string $method, string $path, array $opts = []): Response
    {
        $headers = array_change_key_case($opts['headers'] ?? [], CASE_LOWER);
        $body = $opts['raw'] ?? '';
        $post = [];
        if (isset($opts['json'])) {
            $body = (string) json_encode($opts['json']);
            $headers['content-type'] = 'application/json';
        } elseif (isset($opts['form'])) {
            $post = $opts['form'];
            $body = http_build_query($post);
            $headers['content-type'] = 'application/x-www-form-urlencoded';
        }
        $query = $opts['query'] ?? [];
        if (str_contains($path, '?')) {
            [$path, $qs] = explode('?', $path, 2);
            parse_str($qs, $parsed);
            $query += $parsed;
        }
        $request = new Request(
            strtoupper($method),
            $path,
            $query,
            $post,
            $headers,
            $this->cookies,
            $body,
            $opts['ip'] ?? '203.0.113.10',
            $opts['secure'] ?? false,
        );
        $response = $this->app->handle($request);
        if ($response->stream !== null) {
            ob_start();
            ($response->stream)();
            $response->body = (string) ob_get_clean();
        }
        foreach ($response->cookies as $c) {
            $expires = $c['options']['expires'] ?? null;
            if ($c['value'] === '' || ($expires !== null && $expires > 0 && $expires < time())) {
                unset($this->cookies[$c['name']]);
            } else {
                $this->cookies[$c['name']] = $c['value'];
            }
        }
        return $this->last = $response;
    }

    public function get(string $path, array $opts = []): Response
    {
        return $this->request('GET', $path, $opts);
    }

    public function post(string $path, array $opts = []): Response
    {
        return $this->request('POST', $path, $opts);
    }

    /** Form POST including the session CSRF token. */
    public function submit(string $path, array $form = []): Response
    {
        return $this->request('POST', $path, ['form' => $form + ['_csrf' => $this->csrf]]);
    }

    /** JSON request including the session CSRF header. */
    public function api(string $method, string $path, ?array $json = null): Response
    {
        $opts = ['headers' => ['X-CSRF-Token' => $this->csrf, 'Accept' => 'application/json']];
        if ($json !== null) {
            $opts['json'] = $json;
        }
        return $this->request($method, $path, $opts);
    }
}
