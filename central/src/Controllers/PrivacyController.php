<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Audit\AuditLog;
use Signalpost\Core\HttpException;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Privacy\ExportService;
use Signalpost\Privacy\RetentionService;
use Signalpost\Privacy\WorkspaceDeletionService;
use Signalpost\Security\RateLimiter;
use Signalpost\Sites\WebsiteService;

final class PrivacyController extends Controller
{
    public function index(Request $request, array $errors = [], ?array $report = null, int $status = 200): Response
    {
        $ctx = $this->ctx($request, 'privacy.manage');
        $sites = $this->app->get(WebsiteService::class);
        $rows = [];
        foreach ($sites->list($ctx) as $s) {
            $rows[] = $s + ['settings' => $sites->settings((int) $s['id'])];
        }
        return $this->page($request, 'privacy', [
            'title' => 'Privacy & retention',
            'sites' => $rows,
            'errors' => $errors,
            'report' => $report,
            'isPrimaryOwner' => $ctx->userId === $ctx->primaryOwnerId,
            'lastCron' => $this->app->get(\Signalpost\Admin\PlatformSettings::class)->getState('last_cron_run'),
        ], 'layout_app', $status);
    }

    public function cleanup(Request $request): Response
    {
        $ctx = $this->ctx($request, 'privacy.manage');
        $dry = $request->input('mode') !== 'run';
        if (!$dry) {
            $this->app->get(RateLimiter::class)->enforce('cleanup:ws:' . $ctx->workspaceId, 10, 3600);
        }
        $report = $this->app->get(RetentionService::class)->run($dry, $ctx->workspaceId);
        if (!$dry) {
            $this->app->get(AuditLog::class)->workspace($ctx->workspaceId, $ctx->userId, 'retention.cleanup', 'workspace', $ctx->workspaceId, ['dry_run' => false, 'count' => array_sum($report['totals'])]);
        }
        return $this->index($request, [], $report);
    }

    public function export(Request $request): Response
    {
        $ctx = $this->ctx($request, 'privacy.manage');
        $this->app->get(RateLimiter::class)->enforce('export:ws:' . $ctx->workspaceId, 10, 3600);
        $stream = $this->app->get(ExportService::class)->streamWorkspace($ctx);
        return Response::download($stream, 'signalpost-workspace-' . $ctx->workspaceId . '-' . gmdate('Ymd-His') . '.json');
    }

    public function exportVisitor(Request $request): Response
    {
        $ctx = $this->ctx($request, 'privacy.manage');
        $data = $this->app->get(ExportService::class)->visitor($ctx, $request->intParam('id'));
        $json = (string) json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        return Response::download(static function () use ($json): void {
            echo $json;
        }, 'signalpost-visitor-' . $data['visitor']['public_id'] . '.json');
    }

    public function deleteWorkspace(Request $request): Response
    {
        $ctx = $this->ctx($request, 'workspace.manage');
        $this->app->get(RateLimiter::class)->enforce('wsdelete:' . $ctx->userId, 5, 900);
        try {
            $this->app->get(WorkspaceDeletionService::class)->delete($ctx, (string) $request->input('confirm_name', ''), (string) $request->input('password', ''));
        } catch (HttpException $e) {
            if ($e->status === 422) {
                return $this->index($request, $e->details, null, 422);
            }
            throw $e;
        }
        return Response::redirect('/?ok=deleted');
    }
}
