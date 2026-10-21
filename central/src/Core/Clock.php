<?php

declare(strict_types=1);

namespace Signalpost\Core;

use DateTimeImmutable;
use DateTimeZone;

/** UTC clock that tests can freeze or advance. */
final class Clock
{
    private ?DateTimeImmutable $frozen = null;

    public function now(): DateTimeImmutable
    {
        return $this->frozen ?? new DateTimeImmutable('now', new DateTimeZone('UTC'));
    }

    public function timestamp(): int
    {
        return $this->now()->getTimestamp();
    }

    /** MySQL DATETIME string in UTC, optionally offset by seconds. */
    public function sql(int $offsetSeconds = 0): string
    {
        return $this->now()->modify(sprintf('%+d seconds', $offsetSeconds))->format('Y-m-d H:i:s');
    }

    public function freeze(DateTimeImmutable|string $at): void
    {
        $this->frozen = is_string($at) ? new DateTimeImmutable($at, new DateTimeZone('UTC')) : $at;
    }

    public function advance(int $seconds): void
    {
        $this->frozen = $this->now()->modify(sprintf('%+d seconds', $seconds));
    }

    public function unfreeze(): void
    {
        $this->frozen = null;
    }
}
