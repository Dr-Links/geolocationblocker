<?php

declare(strict_types=1);

namespace Signalpost\Chat\Transport;

/**
 * Hook for real-time delivery. The shared-hosting release uses short
 * polling, so the default implementation does nothing: clients discover new
 * messages through incremental cursors. A WebSocket or queue-backed notifier
 * can implement this interface later without changing the messaging code.
 */
interface MessageNotifier
{
    public function messageCreated(array $conversation, array $message): void;

    public function conversationChanged(array $conversation): void;
}
