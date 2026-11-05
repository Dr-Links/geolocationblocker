<?php

declare(strict_types=1);

namespace Signalpost\Push;

use Signalpost\Core\App;

final class CurlPushTransport implements PushTransport
{
    public function __construct(App $app)
    {
    }

    public function post(string $url, array $headers, string $body): int
    {
        $lines = [];
        foreach ($headers as $k => $v) {
            $lines[] = $k . ': ' . $v;
        }
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_HTTPHEADER => $lines,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
                CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_TIMEOUT => 10,
                CURLOPT_SSL_VERIFYPEER => true,
            ]);
            curl_exec($ch);
            $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            curl_close($ch);
            return $code;
        }
        $ctx = stream_context_create(['http' => [
            'method' => 'POST', 'header' => implode("\r\n", $lines), 'content' => $body,
            'timeout' => 10, 'ignore_errors' => true, 'follow_location' => 0,
        ]]);
        @file_get_contents($url, false, $ctx);
        $status = $http_response_header[0] ?? '';
        return preg_match('/^HTTP\/\S+\s+(\d{3})/', $status, $m) ? (int) $m[1] : 0;
    }
}
