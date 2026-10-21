<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Core\Validator;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Tenancy\Authorizer;
use Signalpost\Tenancy\WorkspaceService;

final class DashboardController extends Controller
{
    public function home(Request $request): Response
    {
        $workspaces = $this->app->get(Authorizer::class)->accessibleWorkspaces($this->user($request));
        $wanted = $request->queryInt('ws', 0, 0);
        foreach ($workspaces as $ws) {
            if ((int) $ws['id'] === $wanted) {
                return Response::redirect('/w/' . $wanted);
            }
        }
        foreach ($workspaces as $ws) {
            if ($ws['role'] !== 'support') {
                return Response::redirect('/w/' . $ws['id']);
            }
        }
        return $this->page($request, 'workspace_new', ['title' => 'Create a workspace', 'errors' => [], 'first' => true]);
    }

    public function newWorkspace(Request $request): Response
    {
        return $this->page($request, 'workspace_new', ['title' => 'Create a workspace', 'errors' => [], 'first' => false]);
    }

    public function createWorkspace(Request $request): Response
    {
        return $this->withErrors(function () use ($request) {
            $data = Validator::of($request->allInput())->string('name', 2, 100)->check();
            $id = $this->app->get(WorkspaceService::class)->create($this->user($request)['id'], $data['name']);
            return Response::redirect('/w/' . $id . '?ok=created');
        }, fn ($errors, $status) => $this->page($request, 'workspace_new', ['title' => 'Create a workspace', 'errors' => $errors, 'first' => false], 'layout_app', $status));
    }
}
