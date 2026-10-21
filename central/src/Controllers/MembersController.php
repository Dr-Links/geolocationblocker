<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Core\Validator;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Tenancy\Roles;
use Signalpost\Tenancy\WorkspaceService;

final class MembersController extends Controller
{
    public function index(Request $request, array $errors = [], ?string $inviteUrl = null, int $status = 200): Response
    {
        $ctx = $this->ctx($request, 'workspace.view');
        $service = $this->app->get(WorkspaceService::class);
        return $this->page($request, 'members', [
            'title' => 'Members',
            'members' => $service->members($ctx),
            'invitations' => $ctx->can('members.manage') ? $service->invitations($ctx) : [],
            'grants' => $ctx->can('workspace.manage') ? $service->supportGrants($ctx) : [],
            'errors' => $errors,
            'inviteUrl' => $inviteUrl,
            'roles' => Roles::ASSIGNABLE,
        ], 'layout_app', $status);
    }

    public function invite(Request $request): Response
    {
        $ctx = $this->ctx($request, 'members.manage');
        return $this->withErrors(function () use ($request, $ctx) {
            $data = Validator::of($request->allInput())->email('email')->enum('role', Roles::ASSIGNABLE)->check();
            $url = $this->app->get(WorkspaceService::class)->invite($ctx, $data['email'], $data['role']);
            // Shown once so the owner can deliver it manually if email is not configured.
            return $this->index($request, [], $url);
        }, fn ($errors, $status) => $this->index($request, $errors, null, $status));
    }

    public function revokeInvitation(Request $request): Response
    {
        $ctx = $this->ctx($request, 'members.manage');
        $this->app->get(WorkspaceService::class)->revokeInvitation($ctx, $request->intParam('id'));
        return Response::redirect("/w/{$ctx->workspaceId}/members?ok=revoked");
    }

    public function changeRole(Request $request): Response
    {
        $ctx = $this->ctx($request, 'members.manage');
        $role = (string) $request->input('role', '');
        $this->app->get(WorkspaceService::class)->changeRole($ctx, $request->intParam('id'), $role);
        return Response::redirect("/w/{$ctx->workspaceId}/members?ok=saved");
    }

    public function revoke(Request $request): Response
    {
        $ctx = $this->ctx($request, 'members.manage');
        $this->app->get(WorkspaceService::class)->revokeMember($ctx, $request->intParam('id'));
        return Response::redirect("/w/{$ctx->workspaceId}/members?ok=revoked");
    }

    public function grantSupport(Request $request): Response
    {
        $ctx = $this->ctx($request, 'workspace.manage');
        $data = Validator::of($request->allInput())->int('hours', 1, 168, 4)->string('reason', 3, 255)->check();
        $this->app->get(WorkspaceService::class)->grantSupport($ctx, $data['hours'], $data['reason']);
        return Response::redirect("/w/{$ctx->workspaceId}/members?ok=saved");
    }

    public function revokeSupport(Request $request): Response
    {
        $ctx = $this->ctx($request, 'workspace.manage');
        $this->app->get(WorkspaceService::class)->revokeSupport($ctx, $request->intParam('id'));
        return Response::redirect("/w/{$ctx->workspaceId}/members?ok=revoked");
    }
}
