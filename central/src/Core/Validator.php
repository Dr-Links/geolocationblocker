<?php

declare(strict_types=1);

namespace Signalpost\Core;

/**
 * Explicit input validation. Collects errors and throws a 422 on check().
 */
final class Validator
{
    private array $errors = [];
    private array $clean = [];

    public function __construct(private readonly array $input)
    {
    }

    public static function of(array $input): self
    {
        return new self($input);
    }

    public function string(string $key, int $min = 0, int $max = 255, bool $required = true, ?string $pattern = null): self
    {
        $v = $this->input[$key] ?? null;
        if ($v === null || $v === '') {
            if ($required) {
                $this->errors[$key] = 'This field is required.';
            } else {
                $this->clean[$key] = null;
            }
            return $this;
        }
        if (!is_string($v) && !is_int($v)) {
            $this->errors[$key] = 'Must be text.';
            return $this;
        }
        $v = trim((string) $v);
        if (!mb_check_encoding($v, 'UTF-8')) {
            $this->errors[$key] = 'Invalid characters.';
            return $this;
        }
        // Strip control characters except newline and tab.
        $v = (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $v);
        $len = mb_strlen($v);
        if ($len < $min || ($required && $len === 0)) {
            $this->errors[$key] = $min > 1 ? "Must be at least {$min} characters." : 'This field is required.';
        } elseif ($len > $max) {
            $this->errors[$key] = "Must be at most {$max} characters.";
        } elseif ($pattern !== null && preg_match($pattern, $v) !== 1) {
            $this->errors[$key] = 'Invalid format.';
        } else {
            $this->clean[$key] = $v === '' ? null : $v;
        }
        return $this;
    }

    public function email(string $key, bool $required = true): self
    {
        $this->string($key, 3, 254, $required);
        if (isset($this->clean[$key])) {
            $v = strtolower($this->clean[$key]);
            if (filter_var($v, FILTER_VALIDATE_EMAIL) === false) {
                $this->errors[$key] = 'Enter a valid email address.';
                unset($this->clean[$key]);
            } else {
                $this->clean[$key] = $v;
            }
        }
        return $this;
    }

    public function phone(string $key, bool $required = false): self
    {
        $this->string($key, 3, 32, $required, '/^\+?[0-9 ()\-.]{3,32}$/');
        if (isset($this->errors[$key]) && $this->errors[$key] === 'Invalid format.') {
            $this->errors[$key] = 'Enter a valid phone number.';
        }
        return $this;
    }

    public function enum(string $key, array $allowed, bool $required = true, ?string $default = null): self
    {
        $v = $this->input[$key] ?? null;
        if ($v === null || $v === '') {
            if ($required && $default === null) {
                $this->errors[$key] = 'This field is required.';
            } else {
                $this->clean[$key] = $default;
            }
            return $this;
        }
        if (!is_string($v) || !in_array($v, $allowed, true)) {
            $this->errors[$key] = 'Invalid value.';
        } else {
            $this->clean[$key] = $v;
        }
        return $this;
    }

    public function bool(string $key, bool $default = false): self
    {
        $v = $this->input[$key] ?? null;
        $this->clean[$key] = match (true) {
            $v === null => $default,
            is_bool($v) => $v,
            in_array($v, ['1', 'true', 'on', 'yes', 1], true) => true,
            default => false,
        };
        return $this;
    }

    public function int(string $key, int $min, int $max, ?int $default = null): self
    {
        $v = $this->input[$key] ?? null;
        if ($v === null || $v === '') {
            if ($default === null) {
                $this->errors[$key] = 'This field is required.';
            } else {
                $this->clean[$key] = $default;
            }
            return $this;
        }
        if (is_string($v) && preg_match('/^-?[0-9]{1,12}$/', $v) === 1) {
            $v = (int) $v;
        }
        if (!is_int($v) || $v < $min || $v > $max) {
            $this->errors[$key] = "Must be a whole number between {$min} and {$max}.";
        } else {
            $this->clean[$key] = $v;
        }
        return $this;
    }

    public function fail(string $key, string $message): self
    {
        $this->errors[$key] = $message;
        return $this;
    }

    public function errors(): array
    {
        return $this->errors;
    }

    /** @throws HttpException */
    public function check(): array
    {
        if ($this->errors !== []) {
            throw HttpException::validation($this->errors);
        }
        return $this->clean;
    }

    public function get(string $key): mixed
    {
        return $this->clean[$key] ?? null;
    }
}
