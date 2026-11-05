<?php

declare(strict_types=1);

namespace Signalpost\Push;

/** Sends one HTTP POST to a push service. Swappable so tests can record requests. */
interface PushTransport
{
    /** @return int HTTP status code (0 on network failure) */
    public function post(string $url, array $headers, string $body): int;
}
