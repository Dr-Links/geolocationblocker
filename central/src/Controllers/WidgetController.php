<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Chat\ConversationService;
use Signalpost\Core\HttpException;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Security\RateLimiter;
use Signalpost\Visitors\BlockService;
use Signalpost\Visitors\ConsentService;
use Signalpost\Visitors\TrackingService;
use Signalpost\Visitors\VisitorService;

/**
 * Public visitor widget API (/api/v1/widget/{site}/...).
 *
 * Responses contain only the requesting visitor's own data. Contact details
 * are never echoed back; the widget only learns which pre-chat fields are
 * still required.
 */
final class WidgetController extends Controller
{
    /** Starts or resumes the visitor's chat session (creates an identity only here). */
    public function session(Request $request): Response
    {
        $site = $request->attributes['website'];
        $settings = $request->attributes['settings'];
        $visitors = $this->app->get(VisitorService::class);
        $visitor = $request->attributes['visitor'];
        $newToken = null;
        if ($visitor === null) {
            $this->app->get(RateLimiter::class)->enforce('widget:new:' . $site['id'] . ':' . $this->app->clientIp($request), 30, 3600);
            [$visitor, $newToken] = $visitors->create($site);
        } else {
            $newToken = $visitors->rotateIfDue($visitor);
            $visitors->touch($visitor, $site);
        }
        return Response::json($this->state($site, $settings, $visitor) + ['token' => $newToken]);
    }

    public function messages(Request $request): Response
    {
        $visitor = $this->visitor($request);
        $this->app->get(VisitorService::class)->touch($visitor, $request->attributes['website']);
        $data = $this->app->get(ConversationService::class)->visitorMessages($visitor, $request->queryInt('after', 0, 0));
        $data['chat_available'] = !$this->app->get(BlockService::class)->isBlocked((int) $visitor['id']);
        return Response::json($data);
    }

    public function send(Request $request): Response
    {
        $site = $request->attributes['website'];
        $settings = $request->attributes['settings'];
        $visitor = $this->visitor($request);
        $limiter = $this->app->get(RateLimiter::class);
        $limiter->enforce('widget:msg:' . $visitor['id'], 20, 60);
        $limiter->enforce('widget:msg:site:' . $site['id'], 600, 60);
        if ($this->app->get(BlockService::class)->isBlocked((int) $visitor['id'])) {
            BlockService::deny();
        }
        if (!$this->app->get(VisitorService::class)->prechatSatisfied($visitor, $settings['widget'])) {
            throw new HttpException(409, 'prechat_required', 'Please fill in the form before sending a message.');
        }
        $in = $request->json();
        $result = $this->app->get(ConversationService::class)->visitorSend($site, $visitor, $settings['widget'], (string) ($in['client_message_id'] ?? ''), $in['body'] ?? null);
        $m = $result['message'];
        return Response::json([
            'message' => ['id' => (int) $m['id'], 'sender' => 'visitor', 'client_id' => $m['client_message_id'], 'body' => $m['body'], 'created_at' => ConversationService::iso($m['created_at'])],
            'duplicate' => $result['duplicate'],
        ], $result['duplicate'] ? 200 : 201);
    }

    public function contact(Request $request): Response
    {
        $site = $request->attributes['website'];
        $visitor = $this->visitor($request);
        $this->app->get(RateLimiter::class)->enforce('widget:contact:' . $visitor['id'], 5, 600);
        if ($this->app->get(BlockService::class)->isBlocked((int) $visitor['id'])) {
            BlockService::deny();
        }
        $saved = $this->app->get(VisitorService::class)->submitContact($site, $visitor, $request->attributes['settings']['widget'], $request->json());
        // Confirm which fields were saved without echoing their values.
        return Response::json(['saved' => array_keys(array_filter($saved, static fn ($v) => $v !== null))]);
    }

    public function consent(Request $request): Response
    {
        $site = $request->attributes['website'];
        $tracking = $request->attributes['settings']['tracking'];
        $visitor = $this->visitor($request);
        $this->app->get(RateLimiter::class)->enforce('widget:consent:' . $visitor['id'], 20, 600);
        $in = $request->json();
        if (!is_bool($in['analytics'] ?? null)) {
            throw HttpException::validation(['analytics' => 'Must be true or false.']);
        }
        $source = in_array($in['source'] ?? '', ['widget', 'wp_consent_api', 'custom'], true) ? $in['source'] : 'widget';
        if ($in['analytics'] && !$tracking['analytics_enabled']) {
            // Nothing to consent to; record nothing.
            return Response::json(['consent_state' => $visitor['consent_state'], 'analytics_permitted' => false]);
        }
        $state = $this->app->get(ConsentService::class)->record($site, $visitor, $tracking, $in['analytics'], $source);
        $visitor['consent_state'] = $state;
        $visitor['consent_policy_version'] = $tracking['policy_version'];
        return Response::json(['consent_state' => $state, 'analytics_permitted' => ConsentService::analyticsPermitted($tracking, $visitor)]);
    }

    public function events(Request $request): Response
    {
        $site = $request->attributes['website'];
        $visitor = $this->visitor($request);
        $this->app->get(RateLimiter::class)->enforce('widget:events:' . $visitor['id'], 60, 60);
        $in = $request->json();
        $events = is_array($in['events'] ?? null) && array_is_list($in['events']) ? $in['events'] : [];
        if (count($events) > $this->app->config->int('limits.events_per_batch')) {
            throw HttpException::validation(['events' => 'Too many events in one batch.']);
        }
        $result = $this->app->get(TrackingService::class)->ingest($site, $visitor, $request->attributes['settings']['tracking'], $events, $request);
        return Response::json($result, 202);
    }

    private function visitor(Request $request): array
    {
        $visitor = $request->attributes['visitor'];
        if ($visitor === null) {
            throw new HttpException(401, 'session_required', 'Your chat session has expired. Please reload the page.');
        }
        return $visitor;
    }

    private function state(array $site, array $settings, array $visitor): array
    {
        $widget = $settings['widget'];
        $tracking = $settings['tracking'];
        $conversations = $this->app->get(ConversationService::class);
        $blocked = $this->app->get(BlockService::class)->isBlocked((int) $visitor['id']);
        $required = [];
        foreach (['name' => 'prechat_name', 'email' => 'prechat_email', 'phone' => 'prechat_phone'] as $f => $s) {
            if ($widget[$s] === 'required' && $visitor[$f] === null) {
                $required[] = $f;
            }
        }
        $history = $conversations->visitorMessages($visitor, 0);
        return [
            'visitor' => ['id' => $visitor['public_id'], 'consent_state' => $visitor['consent_state']],
            'chat' => [
                'available' => !$blocked,
                'conversation' => $history['conversation'],
                'messages' => $history['messages'],
                'prechat' => [
                    'fields' => ['name' => $widget['prechat_name'], 'email' => $widget['prechat_email'], 'phone' => $widget['prechat_phone']],
                    'missing_required' => $required,
                    'submitted' => $visitor['name'] !== null || $visitor['email'] !== null || $visitor['phone'] !== null,
                ],
            ],
            'analytics' => [
                'permitted' => ConsentService::analyticsPermitted($tracking, $visitor),
                'needs_prompt' => ConsentService::needsPrompt($tracking, $visitor),
                'policy_version' => $tracking['policy_version'],
            ],
        ];
    }
}
