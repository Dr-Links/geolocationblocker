<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Core\Validator;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Sites\WebsiteService;
use Signalpost\Visitors\BlockService;
use Signalpost\Visitors\ConsentService;
use Signalpost\Visitors\VisitorService;

final class VisitorController extends Controller
{
    public function index(Request $request): Response
    {
        $ctx = $this->ctx($request, 'visitors.read');
        $q = mb_substr(trim($request->queryString('q')), 0, 100);
        $website = $request->queryInt('website', 0, 0);
        $before = $request->queryInt('before', 0, 0);
        return $this->page($request, 'visitors', [
            'title' => 'Visitor profiles',
            'rows' => $this->app->get(VisitorService::class)->list($ctx, $q, $website, $before),
            'sites' => $this->app->get(WebsiteService::class)->list($ctx),
            'q' => $q,
            'website' => $website,
        ]);
    }

    public function show(Request $request): Response
    {
        $ctx = $this->ctx($request, 'visitors.read');
        $id = $request->intParam('id');
        $visitors = $this->app->get(VisitorService::class);
        $visitor = $visitors->get($ctx, $id);
        $tracking = $this->app->get(WebsiteService::class)->settings((int) $visitor['website_id'])['tracking'];
        return $this->page($request, 'visitor_profile', [
            'title' => $visitor['name'] ?: 'Visitor ' . substr($visitor['public_id'], 0, 8),
            'v' => $visitor,
            'tracking' => $tracking,
            'analyticsPermitted' => ConsentService::analyticsPermitted($tracking, $visitor),
            'timeline' => $visitors->timeline($ctx, $id),
            'sessions' => $visitors->sessions($ctx, $id),
            'contacts' => $visitors->contactSubmissions($ctx, $id),
            'consents' => $visitors->consentHistory($ctx, $id),
            'conversations' => $visitors->conversations($ctx, $id),
            'block' => $this->app->get(BlockService::class)->activeBlock($ctx, $id),
            'blockHistory' => $this->app->get(BlockService::class)->history($ctx, $id),
        ]);
    }

    public function block(Request $request): Response
    {
        $ctx = $this->ctx($request, 'visitors.block');
        $id = $request->intParam('id');
        $data = Validator::of($request->allInput())->string('reason', 0, 500, false)->check();
        $this->app->get(BlockService::class)->block($ctx, $id, $data['reason'] ?? null);
        return Response::redirect($this->back($request, $ctx->workspaceId, $id) . '?ok=blocked');
    }

    public function unblock(Request $request): Response
    {
        $ctx = $this->ctx($request, 'visitors.block');
        $id = $request->intParam('id');
        $this->app->get(BlockService::class)->unblock($ctx, $id);
        return Response::redirect($this->back($request, $ctx->workspaceId, $id) . '?ok=unblocked');
    }

    public function delete(Request $request): Response
    {
        $ctx = $this->ctx($request, 'privacy.manage');
        $this->app->get(VisitorService::class)->delete($ctx, $request->intParam('id'));
        return Response::redirect("/w/{$ctx->workspaceId}/visitors?ok=deleted");
    }

    public function blocks(Request $request): Response
    {
        $ctx = $this->ctx($request, 'visitors.read');
        return $this->page($request, 'blocks', [
            'title' => 'Visitor blocking',
            'rows' => $this->app->get(BlockService::class)->list($ctx, $request->queryString('all') === '1'),
            'showAll' => $request->queryString('all') === '1',
        ]);
    }

    private function back(Request $request, int $ws, int $id): string
    {
        return $request->input('return') === 'blocks' ? "/w/{$ws}/blocks" : "/w/{$ws}/visitors/{$id}";
    }
}
