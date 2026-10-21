<?php

declare(strict_types=1);

namespace Signalpost\Auth;

use Signalpost\Core\App;

/**
 * Outbound email. Transports:
 *   mail   - PHP mail() (available on cPanel hosting)
 *   file   - writes .eml files to storage/mail (development only)
 *   memory - keeps messages in memory (tests)
 */
final class Mailer
{
    /** @var array<int,array{to:string,subject:string,body:string}> */
    public array $sent = [];

    public function __construct(private readonly App $app)
    {
    }

    public function send(string $to, string $subject, string $body): bool
    {
        $to = str_replace(["\r", "\n"], '', $to);
        $subject = str_replace(["\r", "\n"], ' ', $subject);
        $from = (string) $this->app->config->get('mail.from');
        $fromName = str_replace(["\r", "\n", '"'], '', (string) $this->app->config->get('mail.from_name'));
        $headers = [
            'From' => sprintf('"%s" <%s>', $fromName, $from),
            'MIME-Version' => '1.0',
            'Content-Type' => 'text/plain; charset=UTF-8',
            'Content-Transfer-Encoding' => '8bit',
            'X-Auto-Response-Suppress' => 'All',
        ];
        $transport = (string) $this->app->config->get('mail.transport');
        switch ($transport) {
            case 'memory':
                $this->sent[] = ['to' => $to, 'subject' => $subject, 'body' => $body];
                return true;
            case 'file':
                $dir = $this->app->config->get('paths.storage') . '/mail';
                @mkdir($dir, 0750, true);
                $raw = "To: {$to}\nSubject: {$subject}\n";
                foreach ($headers as $k => $v) {
                    $raw .= "{$k}: {$v}\n";
                }
                return file_put_contents($dir . '/' . date('Ymd-His') . '-' . bin2hex(random_bytes(3)) . '.eml', $raw . "\n" . $body) !== false;
            default:
                $ok = @mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', $body, $headers);
                if (!$ok) {
                    $this->app->logger()->warning('mail() returned false', ['subject_prefix' => substr($subject, 0, 30)]);
                }
                return $ok;
        }
    }

    public function url(string $path): string
    {
        return rtrim((string) $this->app->config->get('app.url'), '/') . $path;
    }
}
