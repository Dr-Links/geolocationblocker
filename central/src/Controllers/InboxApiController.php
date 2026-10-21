<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Chat\ConversationService;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Security\RateLimiter;
use Signalpost\Visitors\BlockService;
use Signalpost\Visitors\ConsentService;
use Signalpost\Visitors\VisitorService;
use Signalpost\Sites\WebsiteService;

/**
 * Dashboard JSON API (/api/v1/dashboard/w/{ws}/...). Session + CSRF header
 * required; every query is scoped by the authorised workspace context.
 */
final class InboxApiController extends Controller
{
    public function conversations(Request $request): Response
    {
        $ctx = $this->ctx($request, 'conversations.read');
        $items = $this->app->get(ConversationService::class)->list($ctx, [
            'status' => $request->queryString('status'),
            'website' => $request->queryInt('website', 0, 0),
            'q' => mb_substr(trim($request->queryString('q')), 0, 100),
            'before' => $request->queryInt('before', 0, 0),
            'since' => $request->queryInt('since', 0, 0),
            'unread' => $request->queryString('unread') === '1',
            'limit' => $request->queryInt('limit', 30, 1, 100),
        ]);
        $last = $items === [] ? null : end($items)['last_message_id'];
        return Response::json(['items' => $items, 'next_before' => count($items) >= $request->queryInt('limit', 30, 1, 100) ? $last : null]);
    }

    public function conversation(Request $request): Response
    {
        $ctx = $this->ctx($request, 'conversations.read');
        $service = $this->app->get(ConversationService::class);
        $conv = $service->get($ctx, $request->intParam('id'));
        return Response::json([
            'conversation' => [
                'id' => (int) $conv['id'],
                'status' => $conv['status'],
                'read_only' => (bool) $conv['read_only'],
                'created_at' => ConversationService::iso($conv['created_at']),
                'closed_at' => ConversationService::iso($conv['closed_at']),
            ],
            'visitor' => $this->visitorPanel($request, (int) $conv['visitor_id']),
            'messages' => $service->messages($ctx, (int) $conv['id']),
            'permissions' => ['reply' => $ctx->can('conversations.reply'), 'update' => $ctx->can('conversations.update'), 'block' => $ctx->can('visitors.block')],
        ]);
    }

    public function messages(Request $request): Response
    {
        $ctx = $this->ctx($request, 'conversations.read');
        $service = $this->app->get(ConversationService::class);
        $conv = $service->get($ctx, $request->intParam('id'));
        return Response::json([
            'messages' => $service->messages($ctx, (int) $conv['id'], $request->queryInt('after', 0, 0), $request->queryInt('before', 0, 0)),
            'status' => $conv['status'],
            'read_only' => (bool) $conv['read_only'],
        ]);
    }

    public function reply(Request $request): Response
    {
        $ctx = $this->ctx($request, 'conversations.reply');
        $this->app->get(RateLimiter::class)->enforce('dash:reply:' . $ctx->userId, 60, 60);
        $in = $request->json();
        $result = $this->app->get(ConversationService::class)->operatorReply($ctx, $request->intParam('id'), (string) ($in['client_message_id'] ?? ''), $in['body'] ?? null);
        return Response::json($result, $result['duplicate'] ? 200 : 201);
    }

    public function status(Request $request): Response
    {
        $ctx = $this->ctx($request, 'conversations.update');
        $conv = $this->app->get(ConversationService::class)->setStatus($ctx, $request->intParam('id'), (string) ($request->json()['status'] ?? ''));
        return Response::json(['id' => (int) $conv['id'], 'status' => $conv['status']]);
    }

    public function read(Request $request): Response
    {
        $ctx = $this->ctx($request, 'conversations.mark_read');
        $mid = $request->json()['message_id'] ?? 0;
        $this->app->get(ConversationService::class)->markRead($ctx, $request->intParam('id'), is_int($mid) ? max(0, $mid) : 0);
        return Response::json(['ok' => true]);
    }

    public function live(Request $request): Response
    {
        $ctx = $this->ctx($request, 'visitors.read');
        $activeSeconds = $this->app->config->int('limits.active_visitor_seconds');
        $recentMinutes = $this->app->config->int('limits.recent_visitor_minutes');
        $rows = $this->app->db()->all(
            "SELECT v.id, v.public_id, v.name, v.last_seen_at, v.last_page_path, v.last_page_at, v.country_code, v.consent_state,
                    s.name AS website_name, s.id AS website_id,
                    (SELECT c.id FROM conversations c WHERE c.visitor_id = v.id AND c.status <> 'closed' ORDER BY c.id DESC LIMIT 1) AS open_conversation_id
               FROM visitors v JOIN websites s ON s.id = v.website_id
              WHERE v.workspace_id = ? AND v.last_seen_at >= ? ORDER BY v.last_seen_at DESC LIMIT 200",
            [$ctx->workspaceId, $this->app->clock->sql(-$recentMinutes * 60)]
        );
        $now = $this->app->clock->timestamp();
        $items = array_map(static function (array $r) use ($now, $activeSeconds) {
            $seen = strtotime($r['last_seen_at'] . ' UTC');
            return [
                'id' => (int) $r['id'],
                'public_id' => $r['public_id'],
                'name' => $r['name'],
                'website' => $r['website_name'],
                'state' => $now - $seen <= $activeSeconds ? 'active' : 'recent',
                'last_seen_at' => ConversationService::iso($r['last_seen_at']),
                'seconds_since_seen' => max(0, $now - $seen),
                // Present only when analytics were permitted for this visitor.
                'last_page' => $r['last_page_path'],
                'last_page_at' => ConversationService::iso($r['last_page_at']),
                'country' => $r['country_code'],
                'open_conversation_id' => $r['open_conversation_id'] !== null ? (int) $r['open_conversation_id'] : null,
            ];
        }, $rows);
        return Response::json([
            'active_window_seconds' => $activeSeconds,
            'recent_window_minutes' => $recentMinutes,
            'generated_at' => gmdate('Y-m-d\TH:i:s\Z', $now),
            'items' => $items,
        ]);
    }

    private function visitorPanel(Request $request, int $visitorId): array
    {
        $ctx = $this->ctx($request, 'visitors.read');
        $v = $this->app->get(VisitorService::class)->get($ctx, $visitorId);
        $tracking = $this->app->get(WebsiteService::class)->settings((int) $v['website_id'])['tracking'];
        $block = $this->app->get(BlockService::class)->activeBlock($ctx, $visitorId);
        return [
            'id' => (int) $v['id'],
            'public_id' => $v['public_id'],
            'website' => $v['website_name'],
            'submitted' => ['name' => $v['name'], 'email' => $v['email'], 'phone' => $v['phone']],
            'observed' => [
                'first_seen_at' => ConversationService::iso($v['first_seen_at']),
                'last_seen_at' => ConversationService::iso($v['last_seen_at']),
                'last_page' => $v['last_page_path'],
                'browser' => $v['browser'],
                'os' => $v['os'],
                'visit_count' => $tracking['analytics_enabled'] ? (int) $v['visit_count'] : null,
            ],
            'inferred' => ['country' => $v['country_code'], 'country_source' => $v['country_source']],
            'consent' => [
                'state' => $v['consent_state'],
                'analytics_permitted' => ConsentService::analyticsPermitted($tracking, $v),
                'tracking_mode' => $tracking['analytics_enabled'] ? 'analytics' : 'essential',
            ],
            'blocked' => $block !== null,
        ];
    }
}
