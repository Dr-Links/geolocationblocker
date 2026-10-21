<?php

declare(strict_types=1);

namespace Signalpost\Chat;

use Signalpost\Chat\Transport\MessageNotifier;
use Signalpost\Chat\Transport\PollingNotifier;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Tenancy\WorkspaceContext;
use Signalpost\Visitors\BlockService;

/**
 * Conversations and messages.
 *
 * Visitor-side methods take the website and visitor resolved by the widget
 * guard and only ever touch that visitor's conversations. Operator-side
 * methods take an authorised WorkspaceContext and scope every query by it.
 * Message creation is idempotent per (conversation, sender type, client ID).
 */
final class ConversationService
{
    public const STATUSES = ['open', 'pending', 'closed'];

    public function __construct(private readonly App $app)
    {
    }

    private function notifier(): MessageNotifier
    {
        return $this->app->get(PollingNotifier::class);
    }

    public static function validClientId(mixed $id): bool
    {
        return is_string($id) && preg_match('/^[A-Za-z0-9\-_]{8,64}$/', $id) === 1;
    }

    public function validateBody(mixed $body): string
    {
        if (!is_string($body)) {
            throw HttpException::validation(['body' => 'Message must be text.']);
        }
        $body = str_replace(["\r\n", "\r"], "\n", $body);
        $body = (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $body);
        $body = trim($body);
        $max = $this->app->config->int('limits.message_max_chars');
        if ($body === '' || !mb_check_encoding($body, 'UTF-8')) {
            throw HttpException::validation(['body' => 'Message cannot be empty.']);
        }
        if (mb_strlen($body) > $max) {
            throw HttpException::validation(['body' => "Message is longer than {$max} characters."]);
        }
        return $body;
    }

    // ---- Visitor side -----------------------------------------------------------------

    /** The visitor's most recent conversation on this website, or null. */
    public function currentForVisitor(array $visitor): ?array
    {
        return $this->app->db()->one('SELECT * FROM conversations WHERE visitor_id = ? ORDER BY id DESC LIMIT 1', [$visitor['id']]);
    }

    /**
     * Visitor sends a message. Applies blocking, pre-chat and reopening rules.
     *
     * @return array{message:array,conversation:array,duplicate:bool}
     */
    public function visitorSend(array $site, array $visitor, array $widget, string $clientId, mixed $body): array
    {
        if (!self::validClientId($clientId)) {
            throw HttpException::validation(['client_message_id' => 'Invalid message ID.']);
        }
        $body = $this->validateBody($body);
        if ($this->app->get(BlockService::class)->isBlocked((int) $visitor['id'])) {
            BlockService::deny();
        }
        $db = $this->app->db();
        return $db->transaction(function () use ($db, $site, $visitor, $widget, $clientId, $body) {
            // Serialise per visitor to avoid two parallel first messages creating two conversations.
            $db->one('SELECT id FROM visitors WHERE id = ? FOR UPDATE', [$visitor['id']]);
            $now = $this->app->clock->sql();
            $conv = $this->currentForVisitor($visitor);

            // Idempotent retry: same client ID already stored for this visitor.
            if ($conv !== null) {
                $existing = $db->one(
                    "SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
                      WHERE c.visitor_id = ? AND m.sender_type = 'visitor' AND m.client_message_id = ? LIMIT 1",
                    [$visitor['id'], $clientId]
                );
                if ($existing !== null) {
                    return ['message' => $existing, 'conversation' => $db->one('SELECT * FROM conversations WHERE id = ?', [$existing['conversation_id']]), 'duplicate' => true];
                }
            }

            if ($conv !== null && (int) $conv['read_only'] === 1) {
                BlockService::deny();
            }
            $reopenWindow = (int) $widget['reopen_window_hours'] * 3600;
            if ($conv === null || ($conv['status'] === 'closed'
                && ($reopenWindow === 0 || strtotime((string) $conv['closed_at'] . ' UTC') < $this->app->clock->timestamp() - $reopenWindow))) {
                $convId = $db->insert('conversations', [
                    'workspace_id' => $site['workspace_id'],
                    'website_id' => $site['id'],
                    'visitor_id' => $visitor['id'],
                    'status' => 'open',
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            } else {
                $convId = (int) $conv['id'];
                // Visitor activity (re)opens the conversation for operators.
                $db->exec("UPDATE conversations SET status = 'open', closed_at = NULL WHERE id = ?", [$convId]);
            }
            $msgId = $db->insert('messages', [
                'workspace_id' => $site['workspace_id'],
                'conversation_id' => $convId,
                'sender_type' => 'visitor',
                'client_message_id' => $clientId,
                'body' => $body,
                'created_at' => $now,
                'delivered_at' => $now,
            ]);
            $db->exec('UPDATE conversations SET last_message_id = ?, last_message_at = ?, last_visitor_message_at = ?, updated_at = ? WHERE id = ?',
                [$msgId, $now, $now, $now, $convId]);
            $conversation = $db->one('SELECT * FROM conversations WHERE id = ?', [$convId]);
            $message = $db->one('SELECT * FROM messages WHERE id = ?', [$msgId]);
            $this->notifier()->messageCreated($conversation, $message);
            return ['message' => $message, 'conversation' => $conversation, 'duplicate' => false];
        });
    }

    /**
     * Messages visible to the visitor: only their own conversation on this website.
     * The cursor is applied inside that scope, so changing it cannot reveal other data.
     */
    public function visitorMessages(array $visitor, int $afterId, int $limit = 100): array
    {
        $conv = $this->currentForVisitor($visitor);
        if ($conv === null) {
            return ['conversation' => null, 'messages' => []];
        }
        $db = $this->app->db();
        $rows = $db->all(
            "SELECT m.id, m.sender_type, m.client_message_id, m.body, m.created_at, m.delivered_at, u.display_name
               FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id
              WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT " . max(1, min($limit, 200)),
            [$conv['id'], max(0, $afterId)]
        );
        $undelivered = array_column(array_filter($rows, static fn ($r) => $r['sender_type'] !== 'visitor' && $r['delivered_at'] === null), 'id');
        if ($undelivered !== []) {
            $db->exec('UPDATE messages SET delivered_at = ? WHERE conversation_id = ? AND id IN (' . implode(',', array_map('intval', $undelivered)) . ')',
                [$this->app->clock->sql(), $conv['id']]);
        }
        return [
            'conversation' => ['status' => $conv['status'], 'read_only' => (bool) $conv['read_only']],
            'messages' => array_map(static fn (array $r) => [
                'id' => (int) $r['id'],
                'sender' => $r['sender_type'],
                // Operators are shown by display name only; never email or user ID.
                'author' => $r['sender_type'] === 'operator' ? ($r['display_name'] ?: 'Support') : null,
                'client_id' => $r['sender_type'] === 'visitor' ? $r['client_message_id'] : null,
                'body' => $r['body'],
                'created_at' => str_replace(' ', 'T', $r['created_at']) . 'Z',
            ], $rows),
        ];
    }

    // ---- Operator side ----------------------------------------------------------------

    public function get(WorkspaceContext $ctx, int $conversationId): array
    {
        $ctx->require('conversations.read');
        $row = $this->app->db()->one('SELECT * FROM conversations WHERE id = ? AND workspace_id = ?', [$conversationId, $ctx->workspaceId]);
        if ($row === null) {
            throw HttpException::notFound();
        }
        return $row;
    }

    /**
     * Inbox list, newest activity first, paginated by last_message_id cursor.
     *
     * @param array{status?:string,website?:int,q?:string,before?:int,since?:int,limit?:int,unread?:bool} $f
     */
    public function list(WorkspaceContext $ctx, array $f): array
    {
        $ctx->require('conversations.read');
        $sql = "SELECT c.id, c.status, c.read_only, c.website_id, c.last_message_id, c.last_message_at, c.created_at,
                       v.id AS visitor_id, v.public_id, v.name AS visitor_name, v.email AS visitor_email, v.last_seen_at,
                       s.name AS website_name, COALESCE(r.last_read_message_id, 0) AS last_read_message_id,
                       (SELECT LEFT(m.body, 140) FROM messages m WHERE m.id = c.last_message_id) AS preview,
                       (SELECT m.sender_type FROM messages m WHERE m.id = c.last_message_id) AS last_sender
                  FROM conversations c
                  JOIN visitors v ON v.id = c.visitor_id
                  JOIN websites s ON s.id = c.website_id
                  LEFT JOIN conversation_reads r ON r.conversation_id = c.id AND r.user_id = ?
                 WHERE c.workspace_id = ? AND c.last_message_id > 0";
        $params = [$ctx->userId, $ctx->workspaceId];
        if (!empty($f['status']) && in_array($f['status'], self::STATUSES, true)) {
            $sql .= ' AND c.status = ?';
            $params[] = $f['status'];
        }
        if (!empty($f['website'])) {
            $sql .= ' AND c.website_id = ?';
            $params[] = (int) $f['website'];
        }
        if (!empty($f['before'])) {
            $sql .= ' AND c.last_message_id < ?';
            $params[] = (int) $f['before'];
        }
        if (!empty($f['since'])) {
            $sql .= ' AND c.last_message_id > ?';
            $params[] = (int) $f['since'];
        }
        if (!empty($f['unread'])) {
            $sql .= " AND c.last_message_id > COALESCE(r.last_read_message_id, 0)";
        }
        if (isset($f['q']) && $f['q'] !== '') {
            $like = '%' . addcslashes((string) $f['q'], '%_\\') . '%';
            // Search is confined to this workspace by the WHERE clause above.
            $sql .= ' AND (v.name LIKE ? OR v.email LIKE ? OR v.public_id LIKE ?
                       OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.conversation_id = c.id AND m2.workspace_id = ? AND m2.body LIKE ?))';
            array_push($params, $like, $like, $like, $ctx->workspaceId, $like);
        }
        $limit = max(1, min((int) ($f['limit'] ?? 30), 100));
        $sql .= ' ORDER BY c.last_message_id DESC LIMIT ' . $limit;
        $rows = $this->app->db()->all($sql, $params);
        return array_map(static fn (array $r) => [
            'id' => (int) $r['id'],
            'status' => $r['status'],
            'read_only' => (bool) $r['read_only'],
            'website' => ['id' => (int) $r['website_id'], 'name' => $r['website_name']],
            'visitor' => ['id' => (int) $r['visitor_id'], 'public_id' => $r['public_id'], 'name' => $r['visitor_name'], 'email' => $r['visitor_email'], 'last_seen_at' => self::iso($r['last_seen_at'])],
            'last_message_id' => (int) $r['last_message_id'],
            'last_message_at' => self::iso($r['last_message_at']),
            'last_sender' => $r['last_sender'],
            'preview' => $r['preview'],
            'unread' => (int) $r['last_message_id'] > (int) $r['last_read_message_id'] && $r['last_sender'] === 'visitor',
        ], $rows);
    }

    public function messages(WorkspaceContext $ctx, int $conversationId, int $afterId = 0, int $beforeId = 0, int $limit = 50): array
    {
        $conv = $this->get($ctx, $conversationId);
        $sql = 'SELECT m.id, m.sender_type, m.sender_user_id, m.client_message_id, m.body, m.created_at, m.delivered_at, u.display_name
                  FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id
                 WHERE m.conversation_id = ? AND m.workspace_id = ?';
        $params = [$conv['id'], $ctx->workspaceId];
        $limit = max(1, min($limit, 200));
        if ($beforeId > 0) {
            $sql .= ' AND m.id < ? ORDER BY m.id DESC LIMIT ' . $limit;
            $params[] = $beforeId;
            $rows = array_reverse($this->app->db()->all($sql, $params));
        } elseif ($afterId > 0) {
            $sql .= ' AND m.id > ? ORDER BY m.id ASC LIMIT ' . $limit;
            $params[] = $afterId;
            $rows = $this->app->db()->all($sql, $params);
        } else {
            $sql .= ' ORDER BY m.id DESC LIMIT ' . $limit;
            $rows = array_reverse($this->app->db()->all($sql, $params));
        }
        return array_map(static fn (array $r) => [
            'id' => (int) $r['id'],
            'sender' => $r['sender_type'],
            'author' => $r['sender_type'] === 'operator' ? ($r['display_name'] ?: 'Operator') : null,
            'client_id' => $r['client_message_id'],
            'body' => $r['body'],
            'created_at' => self::iso($r['created_at']),
            'delivered' => $r['delivered_at'] !== null,
        ], $rows);
    }

    /** @return array{message:array,duplicate:bool} */
    public function operatorReply(WorkspaceContext $ctx, int $conversationId, string $clientId, mixed $body): array
    {
        $ctx->require('conversations.reply');
        if (!self::validClientId($clientId)) {
            throw HttpException::validation(['client_message_id' => 'Invalid message ID.']);
        }
        $body = $this->validateBody($body);
        $db = $this->app->db();
        return $db->transaction(function () use ($db, $ctx, $conversationId, $clientId, $body) {
            $conv = $db->one('SELECT * FROM conversations WHERE id = ? AND workspace_id = ? FOR UPDATE', [$conversationId, $ctx->workspaceId]);
            if ($conv === null) {
                throw HttpException::notFound();
            }
            $existing = $db->one("SELECT * FROM messages WHERE conversation_id = ? AND sender_type = 'operator' AND client_message_id = ?", [$conversationId, $clientId]);
            if ($existing !== null) {
                return ['message' => $this->shapeOne($existing), 'duplicate' => true];
            }
            $now = $this->app->clock->sql();
            $msgId = $db->insert('messages', [
                'workspace_id' => $ctx->workspaceId,
                'conversation_id' => $conversationId,
                'sender_type' => 'operator',
                'sender_user_id' => $ctx->userId,
                'client_message_id' => $clientId,
                'body' => $body,
                'created_at' => $now,
            ]);
            $status = $conv['status'] === 'closed' ? 'open' : $conv['status'];
            $db->exec('UPDATE conversations SET last_message_id = ?, last_message_at = ?, status = ?, closed_at = IF(? = \'open\', NULL, closed_at),
                              assigned_user_id = COALESCE(assigned_user_id, ?), updated_at = ? WHERE id = ?',
                [$msgId, $now, $status, $status, $ctx->userId, $now, $conversationId]);
            if ($ctx->can('conversations.mark_read')) {
                $this->markRead($ctx, $conversationId, $msgId);
            }
            $message = $db->one('SELECT * FROM messages WHERE id = ?', [$msgId]);
            $this->notifier()->messageCreated($conv, $message);
            return ['message' => $this->shapeOne($message), 'duplicate' => false];
        });
    }

    public function setStatus(WorkspaceContext $ctx, int $conversationId, string $status): array
    {
        $ctx->require('conversations.update');
        if (!in_array($status, self::STATUSES, true)) {
            throw HttpException::validation(['status' => 'Invalid status.']);
        }
        $conv = $this->get($ctx, $conversationId);
        $now = $this->app->clock->sql();
        $this->app->db()->exec(
            'UPDATE conversations SET status = ?, closed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
            [$status, $status === 'closed' ? $now : null, $now, $conversationId, $ctx->workspaceId]
        );
        $conv['status'] = $status;
        $this->notifier()->conversationChanged($conv);
        return $conv;
    }

    public function markRead(WorkspaceContext $ctx, int $conversationId, int $messageId): void
    {
        $this->get($ctx, $conversationId);
        // Clamp to the conversation's real last message so a forged cursor cannot mark beyond it.
        $this->app->db()->exec(
            'INSERT INTO conversation_reads (conversation_id, user_id, last_read_message_id)
             SELECT c.id, ?, LEAST(?, c.last_message_id) FROM conversations c WHERE c.id = ? AND c.workspace_id = ?
             ON DUPLICATE KEY UPDATE last_read_message_id = GREATEST(last_read_message_id, VALUES(last_read_message_id))',
            [$ctx->userId, $messageId, $conversationId, $ctx->workspaceId]
        );
    }

    private function shapeOne(array $m): array
    {
        return [
            'id' => (int) $m['id'],
            'sender' => $m['sender_type'],
            'client_id' => $m['client_message_id'],
            'body' => $m['body'],
            'created_at' => self::iso($m['created_at']),
            'delivered' => $m['delivered_at'] !== null,
        ];
    }

    public static function iso(?string $sql): ?string
    {
        return $sql ? str_replace(' ', 'T', $sql) . 'Z' : null;
    }
}
