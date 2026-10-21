<?php

declare(strict_types=1);

namespace Signalpost\Visitors;

use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Security\Tokens;
use Signalpost\Tenancy\WorkspaceContext;

/**
 * Opaque, website-scoped visitor identities.
 *
 * - The browser holds a random 256-bit token (first-party storage on the website).
 * - The server stores only HMAC-SHA256(app key, token): lookups work, the token
 *   cannot be recovered from the database.
 * - Operators see a separate random public ID; neither is derived from IP,
 *   fingerprint, email or other personal data, and the public ID is not a credential.
 * - Tokens rotate periodically; the previous hash stays valid until the next
 *   rotation so a lost response does not orphan the visitor. Blocks and
 *   conversations reference the internal visitor row, so rotation keeps them.
 */
final class VisitorService
{
    public function __construct(private readonly App $app)
    {
    }

    public function tokenHash(string $token): string
    {
        return Tokens::keyedHash($this->app->config->appKey(), 'visitor', $token);
    }

    /** Resolves a token to a visitor of THIS website only. */
    public function resolve(array $site, ?string $token): ?array
    {
        if ($token === null || preg_match('/^[A-Za-z0-9_\-]{43}$/', $token) !== 1) {
            return null;
        }
        $hash = $this->tokenHash($token);
        $visitor = $this->app->db()->one(
            'SELECT * FROM visitors WHERE website_id = ? AND (token_hash = ? OR previous_token_hash = ?) LIMIT 1',
            [$site['id'], $hash, $hash]
        );
        if ($visitor !== null) {
            $visitor['_used_previous_token'] = $visitor['token_hash'] !== $hash;
        }
        return $visitor;
    }

    /** @return array{0:array,1:string} [visitor row, plaintext token] */
    public function create(array $site): array
    {
        $token = Tokens::random(32);
        $now = $this->app->clock->sql();
        $id = $this->app->db()->insert('visitors', [
            'public_id' => Tokens::hex(10),
            'workspace_id' => $site['workspace_id'],
            'website_id' => $site['id'],
            'token_hash' => $this->tokenHash($token),
            'token_issued_at' => $now,
            'first_seen_at' => $now,
            'last_seen_at' => $now,
            'consent_state' => 'unknown',
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        return [$this->app->db()->one('SELECT * FROM visitors WHERE id = ?', [$id]), $token];
    }

    /** Issues a new token if the current one is older than the rotation period. */
    public function rotateIfDue(array $visitor): ?string
    {
        $days = $this->app->config->int('limits.visitor_token_rotate_days');
        if (!empty($visitor['_used_previous_token']) || strtotime($visitor['token_issued_at'] . ' UTC') > $this->app->clock->timestamp() - $days * 86400) {
            return null;
        }
        $token = Tokens::random(32);
        $this->app->db()->exec(
            'UPDATE visitors SET previous_token_hash = token_hash, token_hash = ?, token_issued_at = ?, updated_at = ? WHERE id = ?',
            [$this->tokenHash($token), $this->app->clock->sql(), $this->app->clock->sql(), $visitor['id']]
        );
        return $token;
    }

    /** Essential activity timestamp (chat continuity and "active now" status). */
    public function touch(array $visitor, array $site): void
    {
        $now = $this->app->clock->timestamp();
        if (strtotime($visitor['last_seen_at'] . ' UTC') > $now - 30) {
            return; // Throttle writes.
        }
        $sql = $this->app->clock->sql();
        $this->app->db()->exec('UPDATE visitors SET last_seen_at = ? WHERE id = ?', [$sql, $visitor['id']]);
        $this->app->db()->exec('UPDATE websites SET last_activity_at = ? WHERE id = ?', [$sql, $site['id']]);
    }

    /** Validated pre-chat submission. Returns the stored values. */
    public function submitContact(array $site, array $visitor, array $widget, array $input): array
    {
        $fields = ['name' => 'prechat_name', 'email' => 'prechat_email', 'phone' => 'prechat_phone'];
        $v = \Signalpost\Core\Validator::of($input);
        foreach ($fields as $field => $setting) {
            $mode = $widget[$setting];
            if ($mode === 'off') {
                continue;
            }
            $required = $mode === 'required';
            match ($field) {
                'name' => $v->string('name', 1, 100, $required),
                'email' => $v->email('email', $required),
                'phone' => $v->phone('phone', $required),
            };
        }
        $clean = $v->check();
        $clean = array_intersect_key($clean, $fields);
        if ($clean === [] || array_filter($clean, static fn ($x) => $x !== null) === []) {
            throw HttpException::validation(['_form' => 'Nothing to save.']);
        }
        $now = $this->app->clock->sql();
        $db = $this->app->db();
        $db->transaction(function () use ($db, $site, $visitor, $clean, $now): void {
            $db->insert('visitor_contact_submissions', [
                'workspace_id' => $site['workspace_id'],
                'website_id' => $site['id'],
                'visitor_id' => $visitor['id'],
                'name' => $clean['name'] ?? null,
                'email' => $clean['email'] ?? null,
                'phone' => $clean['phone'] ?? null,
                'submitted_at' => $now,
            ]);
            $db->exec(
                'UPDATE visitors SET name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone), updated_at = ? WHERE id = ? AND website_id = ?',
                [$clean['name'] ?? null, $clean['email'] ?? null, $clean['phone'] ?? null, $now, $visitor['id'], $site['id']]
            );
        });
        return $clean;
    }

    /** Whether all required pre-chat fields have been provided. */
    public function prechatSatisfied(array $visitor, array $widget): bool
    {
        foreach (['name' => 'prechat_name', 'email' => 'prechat_email', 'phone' => 'prechat_phone'] as $field => $setting) {
            if ($widget[$setting] === 'required' && ($visitor[$field] ?? null) === null) {
                return false;
            }
        }
        return true;
    }

    // ---- Dashboard (authorised) access -------------------------------------------------

    public function get(WorkspaceContext $ctx, int $visitorId): array
    {
        $ctx->require('visitors.read');
        $row = $this->app->db()->one(
            'SELECT v.*, s.name AS website_name, s.canonical_origin FROM visitors v JOIN websites s ON s.id = v.website_id
              WHERE v.id = ? AND v.workspace_id = ?',
            [$visitorId, $ctx->workspaceId]
        );
        if ($row === null) {
            throw HttpException::notFound();
        }
        unset($row['token_hash'], $row['previous_token_hash']);
        return $row;
    }

    public function list(WorkspaceContext $ctx, string $q = '', int $websiteId = 0, int $beforeId = 0, int $limit = 50): array
    {
        $ctx->require('visitors.read');
        $sql = 'SELECT v.id, v.public_id, v.name, v.email, v.phone, v.first_seen_at, v.last_seen_at, v.visit_count, v.consent_state,
                       v.country_code, s.name AS website_name,
                       (SELECT COUNT(*) FROM visitor_blocks b WHERE b.visitor_id = v.id AND b.status = \'active\') AS blocked,
                       (SELECT COUNT(*) FROM conversations c WHERE c.visitor_id = v.id) AS conversations
                  FROM visitors v JOIN websites s ON s.id = v.website_id
                 WHERE v.workspace_id = ?';
        $params = [$ctx->workspaceId];
        if ($websiteId > 0) {
            $sql .= ' AND v.website_id = ?';
            $params[] = $websiteId;
        }
        if ($beforeId > 0) {
            $sql .= ' AND v.id < ?';
            $params[] = $beforeId;
        }
        if ($q !== '') {
            $like = '%' . addcslashes($q, '%_\\') . '%';
            $sql .= ' AND (v.public_id LIKE ? OR v.name LIKE ? OR v.email LIKE ? OR v.phone LIKE ?)';
            array_push($params, $like, $like, $like, $like);
        }
        $sql .= ' ORDER BY v.id DESC LIMIT ' . max(1, min($limit, 100));
        return $this->app->db()->all($sql, $params);
    }

    public function timeline(WorkspaceContext $ctx, int $visitorId, int $limit = 100): array
    {
        $this->get($ctx, $visitorId);
        return $this->app->db()->all(
            'SELECT e.event_type, e.page_path, e.page_title, e.referrer_origin, e.occurred_at, e.session_id
               FROM visitor_events e WHERE e.visitor_id = ? AND e.workspace_id = ? ORDER BY e.occurred_at DESC, e.id DESC LIMIT ' . max(1, min($limit, 500)),
            [$visitorId, $ctx->workspaceId]
        );
    }

    public function contactSubmissions(WorkspaceContext $ctx, int $visitorId): array
    {
        $this->get($ctx, $visitorId);
        return $this->app->db()->all(
            'SELECT name, email, phone, submitted_at FROM visitor_contact_submissions WHERE visitor_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT 20',
            [$visitorId, $ctx->workspaceId]
        );
    }

    public function sessions(WorkspaceContext $ctx, int $visitorId): array
    {
        $this->get($ctx, $visitorId);
        return $this->app->db()->all(
            'SELECT started_at, last_activity_at, page_views FROM visitor_sessions WHERE visitor_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT 20',
            [$visitorId, $ctx->workspaceId]
        );
    }

    public function consentHistory(WorkspaceContext $ctx, int $visitorId): array
    {
        $this->get($ctx, $visitorId);
        return $this->app->db()->all(
            'SELECT category, decision, policy_version, source, recorded_at FROM consent_records WHERE visitor_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT 20',
            [$visitorId, $ctx->workspaceId]
        );
    }

    public function conversations(WorkspaceContext $ctx, int $visitorId): array
    {
        $this->get($ctx, $visitorId);
        return $this->app->db()->all(
            'SELECT id, status, read_only, created_at, last_message_at, closed_at FROM conversations WHERE visitor_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT 50',
            [$visitorId, $ctx->workspaceId]
        );
    }

    /** Deletes a visitor profile and all dependent data (conversations, events, blocks). */
    public function delete(WorkspaceContext $ctx, int $visitorId): void
    {
        $ctx->require('privacy.manage');
        $visitor = $this->get($ctx, $visitorId);
        $this->app->db()->exec('DELETE FROM visitors WHERE id = ? AND workspace_id = ?', [$visitorId, $ctx->workspaceId]);
        $this->app->get(\Signalpost\Audit\AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'visitor.deleted', 'visitor', $visitor['public_id'], ['website_id' => (int) $visitor['website_id']]);
    }
}
