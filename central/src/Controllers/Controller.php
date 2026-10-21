<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Auth\SessionGuard;
use Signalpost\Core\App;
use Signalpost\Core\HttpException;
use Signalpost\Core\View;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Tenancy\Authorizer;
use Signalpost\Tenancy\WorkspaceContext;

abstract class Controller
{
    /** Fixed notice messages selected by ?ok=code after a redirect (no user-controlled text). */
    private const NOTICES = [
        'saved' => 'Changes saved.',
        'created' => 'Created.',
        'deleted' => 'Deleted.',
        'revoked' => 'Access revoked.',
        'invited' => 'Invitation sent.',
        'password' => 'Your password was changed. Other sessions were signed out.',
        'reset' => 'Your password was reset. Please sign in.',
        'verified' => 'Your email address is verified. You can sign in now.',
        'check_email' => 'If the address can receive mail, a message is on its way. Check your inbox.',
        'joined' => 'You joined the workspace.',
        'blocked' => 'Visitor blocked.',
        'unblocked' => 'Visitor unblocked.',
        'rotated' => 'Credentials rotated.',
        'disconnected' => 'Website disconnected. Its credentials no longer work.',
        'cleanup' => 'Cleanup finished.',
        'logged_out' => 'You have been signed out.',
        'installed' => 'Installation complete. Sign in with the owner account you created.',
    ];

    public function __construct(protected readonly App $app)
    {
    }

    protected function view(): View
    {
        return $this->app->get(View::class);
    }

    protected function page(Request $request, string $template, array $vars = [], string $layout = 'layout_app', int $status = 200): Response
    {
        $view = $this->view();
        $view->share('csrf', SessionGuard::token($request));
        $view->share('user', $request->attributes['user'] ?? null);
        $view->share('path', $request->path);
        $ok = $request->queryString('ok');
        $view->share('notice', self::NOTICES[$ok] ?? null);
        if (isset($request->attributes['user'])) {
            $view->share('workspaces', $this->app->get(Authorizer::class)->accessibleWorkspaces($request->attributes['user']));
        }
        return Response::html($view->render($template, $vars, $layout), $status);
    }

    protected function ctx(Request $request, string $permission = 'workspace.view'): WorkspaceContext
    {
        $ctx = $this->app->get(Authorizer::class)->context($request, $request->intParam('ws'), $permission);
        $this->view()->share('ctx', $ctx);
        return $ctx;
    }

    protected function user(Request $request): array
    {
        $u = $request->attributes['user'] ?? null;
        if ($u === null) {
            throw HttpException::unauthorized();
        }
        return $u;
    }

    protected function requirePlatformAdmin(Request $request): array
    {
        $u = $this->user($request);
        if (!$u['is_platform_admin']) {
            throw HttpException::notFound();
        }
        return $u;
    }

    /**
     * Renders a form page again with validation errors instead of throwing,
     * so HTML forms show inline messages.
     */
    protected function withErrors(callable $action, callable $onError): Response
    {
        try {
            return $action();
        } catch (HttpException $e) {
            if (in_array($e->status, [400, 401, 403, 409, 422, 429], true)) {
                return $onError($e->details ?: ['_form' => $e->getMessage()], $e->status === 422 ? 422 : $e->status);
            }
            throw $e;
        }
    }
}
