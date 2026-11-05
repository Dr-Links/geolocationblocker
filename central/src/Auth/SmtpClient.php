<?php

declare(strict_types=1);

namespace Signalpost\Auth;

/**
 * Minimal SMTP client: implicit TLS (port 465) or STARTTLS (587), AUTH LOGIN,
 * one message per connection. Certificates are always verified.
 */
final class SmtpClient
{
    /** @var resource|null */
    private $sock = null;
    private array $transcript = [];

    public function __construct(
        private readonly string $host,
        private readonly int $port,
        private readonly string $encryption, // ssl | tls | none
        private readonly string $username,
        private readonly string $password,
        private readonly int $timeout = 15,
    ) {
    }

    public function send(string $from, string $to, string $data): void
    {
        $remote = ($this->encryption === 'ssl' ? 'ssl://' : 'tcp://') . $this->host . ':' . $this->port;
        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $this->host]]);
        $sock = @stream_socket_client($remote, $errno, $errstr, $this->timeout, STREAM_CLIENT_CONNECT, $ctx);
        if ($sock === false) {
            throw new \RuntimeException('SMTP connection failed.');
        }
        $this->sock = $sock;
        stream_set_timeout($sock, $this->timeout);
        try {
            $this->expect(220);
            $ehlo = 'EHLO ' . $this->heloName();
            $this->command($ehlo, 250);
            if ($this->encryption === 'tls') {
                $this->command('STARTTLS', 220);
                if (!stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT)) {
                    throw new \RuntimeException('SMTP STARTTLS failed.');
                }
                $this->command($ehlo, 250);
            }
            if ($this->username !== '') {
                $this->command('AUTH LOGIN', 334);
                $this->command(base64_encode($this->username), 334);
                $this->command(base64_encode($this->password), 235, true);
            }
            $this->command('MAIL FROM:<' . $from . '>', 250);
            $this->command('RCPT TO:<' . $to . '>', [250, 251]);
            $this->command('DATA', 354);
            $lines = preg_split('/\r\n|\r|\n/', $data) ?: [];
            // Dot-stuffing (RFC 5321 section 4.5.2).
            $body = implode("\r\n", array_map(static fn ($l) => str_starts_with($l, '.') ? '.' . $l : $l, $lines));
            $this->write($body . "\r\n.\r\n");
            $this->expect(250);
            $this->command('QUIT', 221);
        } finally {
            fclose($sock);
            $this->sock = null;
        }
    }

    private function heloName(): string
    {
        $h = gethostname() ?: 'localhost';
        return preg_match('/^[A-Za-z0-9.\-]+$/', $h) ? $h : 'localhost';
    }

    private function command(string $line, int|array $expect, bool $secret = false): void
    {
        $this->transcript[] = 'C: ' . ($secret ? '[credentials]' : (str_starts_with($line, base64_encode($this->username)) ? '[credentials]' : $line));
        $this->write($line . "\r\n");
        $this->expect($expect);
    }

    private function write(string $data): void
    {
        if (fwrite($this->sock, $data) === false) {
            throw new \RuntimeException('SMTP write failed.');
        }
    }

    private function expect(int|array $codes): void
    {
        $codes = (array) $codes;
        $reply = '';
        while (($line = fgets($this->sock, 1024)) !== false) {
            $reply .= $line;
            if (strlen($line) < 4 || $line[3] !== '-') {
                break;
            }
        }
        $code = (int) substr($reply, 0, 3);
        if (!in_array($code, $codes, true)) {
            // Server text may contain addresses; keep only the code for logs.
            throw new \RuntimeException('SMTP server replied ' . ($code ?: 'nothing') . '.');
        }
    }
}
