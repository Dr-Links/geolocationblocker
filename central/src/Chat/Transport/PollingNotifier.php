<?php

declare(strict_types=1);

namespace Signalpost\Chat\Transport;

use Signalpost\Core\App;

/** Default notifier for short polling: no push, state lives in the database. */
final class PollingNotifier implements MessageNotifier
{
    public function __construct(App $app)
    {
    }

    public function messageCreated(array $conversation, array $message): void
    {
    }

    public function conversationChanged(array $conversation): void
    {
    }
}
