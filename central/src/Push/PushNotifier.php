<?php

declare(strict_types=1);

namespace Signalpost\Push;

use Signalpost\Chat\Transport\MessageNotifier;
use Signalpost\Core\App;

/**
 * Sends push notifications for new visitor messages. Work is deferred until
 * after the HTTP response has been sent, so visitors never wait for push
 * services. Failures never affect message delivery.
 */
final class PushNotifier implements MessageNotifier
{
    public function __construct(private readonly App $app)
    {
    }

    public function messageCreated(array $conversation, array $message): void
    {
        if (($message['sender_type'] ?? '') !== 'visitor' || !$this->app->config->get('push.enabled', true)) {
            return;
        }
        $this->app->defer(function () use ($conversation, $message): void {
            try {
                $this->app->get(PushService::class)->notifyNewVisitorMessage($conversation, $message);
            } catch (\Throwable $e) {
                $this->app->logger()->warning('Push notification failed', ['type' => $e::class]);
            }
        });
    }

    public function conversationChanged(array $conversation): void
    {
    }
}
