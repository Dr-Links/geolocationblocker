<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Admin\AdminService;
use Signalpost\Admin\PlatformSettings;
use Signalpost\Audit\AuditLog;
use Signalpost\Http\Request;
use Signalpost\Http\Response;

/**
 * Platform owner area. Non-admins get 404. Nothing here exposes
 * conversations, messages or visitor data.
 */
final class AdminController extends Controller
{
    public function index(Request $request): Response
    {
        $this->requirePlatformAdmin($request);
        return $this->page($request, 'admin/health', ['title' => 'Platform health', 'health' => $this->app->get(AdminService::class)->health()]);
    }

    public function users(Request $request): Response
    {
        $this->requirePlatformAdmin($request);
        $q = mb_substr($request->queryString('q'), 0, 100);
        return $this->page($request, 'admin/users', [
            'title' => 'Accounts',
            'users' => $this->app->get(AdminService::class)->users($q, $request->queryInt('page', 1, 1, 10000)),
            'q' => $q,
        ]);
    }

    public function setUserStatus(Request $request): Response
    {
        $admin = $this->requirePlatformAdmin($request);
        $this->app->get(AdminService::class)->setUserStatus($admin['id'], $request->intParam('id'), (string) $request->input('status', ''));
        return Response::redirect('/admin/users?ok=saved');
    }

    public function workspaces(Request $request): Response
    {
        $this->requirePlatformAdmin($request);
        return $this->page($request, 'admin/workspaces', ['title' => 'Workspaces', 'rows' => $this->app->get(AdminService::class)->workspaces()]);
    }

    public function setWorkspaceStatus(Request $request): Response
    {
        $admin = $this->requirePlatformAdmin($request);
        $this->app->get(AdminService::class)->setWorkspaceStatus($admin['id'], $request->intParam('id'), (string) $request->input('status', ''));
        return Response::redirect('/admin/workspaces?ok=saved');
    }

    public function settings(Request $request): Response
    {
        $this->requirePlatformAdmin($request);
        return $this->page($request, 'admin/settings', [
            'title' => 'Platform settings',
            'settings' => $this->app->get(PlatformSettings::class)->all(),
            'schema' => PlatformSettings::SCHEMA,
        ]);
    }

    public function saveSettings(Request $request): Response
    {
        $admin = $this->requirePlatformAdmin($request);
        $input = $request->allInput();
        // Unchecked checkboxes are absent from form posts.
        $input['require_email_verification'] = isset($input['require_email_verification']);
        $changed = $this->app->get(PlatformSettings::class)->update($input);
        if ($changed !== []) {
            $this->app->get(AuditLog::class)->platform($admin['id'], 'platform.settings_changed', 'settings', '', ['changed' => $changed]);
        }
        return Response::redirect('/admin/settings?ok=saved');
    }

    public function audit(Request $request): Response
    {
        $this->requirePlatformAdmin($request);
        $svc = $this->app->get(AdminService::class);
        return $this->page($request, 'admin/audit', [
            'title' => 'Platform audit',
            'rows' => $svc->audit(),
            'security' => $svc->securityEvents(),
        ]);
    }

    public function runMigrations(Request $request): Response
    {
        $admin = $this->requirePlatformAdmin($request);
        $done = $this->app->migrator()->migrate();
        $this->app->get(AuditLog::class)->platform($admin['id'], 'platform.migrated', 'schema', '', ['migrations' => $done]);
        return Response::redirect('/admin?ok=saved');
    }
}
