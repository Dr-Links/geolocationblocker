<?php

declare(strict_types=1);

namespace Signalpost\Core;

/**
 * An error whose message is safe to show to the client.
 * Anything else that escapes a handler becomes a generic 500.
 */
class HttpException extends \RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $publicMessage,
        public readonly array $details = [],
    ) {
        parent::__construct($publicMessage);
    }

    public static function notFound(): self
    {
        // Same response for "does not exist" and "not yours" to avoid leaking existence.
        return new self(404, 'not_found', 'The requested resource was not found.');
    }

    public static function forbidden(string $message = 'You do not have permission to perform this action.'): self
    {
        return new self(403, 'forbidden', $message);
    }

    public static function unauthorized(string $message = 'Authentication is required.'): self
    {
        return new self(401, 'unauthenticated', $message);
    }

    public static function validation(array $errors): self
    {
        return new self(422, 'validation_failed', 'Some fields are invalid.', $errors);
    }

    public static function badRequest(string $message = 'The request could not be processed.'): self
    {
        return new self(400, 'bad_request', $message);
    }

    public static function tooMany(): self
    {
        return new self(429, 'rate_limited', 'Too many requests. Please wait and try again.');
    }

    public static function conflict(string $message): self
    {
        return new self(409, 'conflict', $message);
    }
}
