<?php

declare(strict_types=1);

use Signalpost\Controllers\AccountController;
use Signalpost\Controllers\AdminController;
use Signalpost\Controllers\AuthController;
use Signalpost\Controllers\DashboardController;
use Signalpost\Controllers\HealthController;
use Signalpost\Controllers\InboxApiController;
use Signalpost\Controllers\InboxController;
use Signalpost\Controllers\InstallController;
use Signalpost\Controllers\IntegrationController;
use Signalpost\Controllers\VisitorController;
use Signalpost\Controllers\WebsiteController;
use Signalpost\Controllers\WidgetController;
use Signalpost\Controllers\MembersController;
use Signalpost\Controllers\WorkspaceController;
use Signalpost\Http\Router;

/*
 * Route table. The third argument is the guard (trust boundary):
 *   public      - no authentication
 *   guest       - optional session, CSRF (double-submit) on writes
 *   session     - dashboard user session required, CSRF on writes
 *   integration - WordPress server-to-server site credential
 *   widget      - public visitor widget, scoped to one website
 */
return static function (Router $r): void {
    $r->get('/api/v1/health', [HealthController::class, 'health']);

    // Installation (only while no user exists).
    $r->get('/install', [InstallController::class, 'show']);
    $r->post('/install', [InstallController::class, 'submit']);

    // Authentication.
    $r->get('/login', [AuthController::class, 'loginForm'], 'guest');
    $r->post('/login', [AuthController::class, 'login'], 'guest');
    $r->post('/logout', [AuthController::class, 'logout'], 'session');
    $r->get('/register', [AuthController::class, 'registerForm'], 'guest');
    $r->post('/register', [AuthController::class, 'register'], 'guest');
    $r->get('/forgot-password', [AuthController::class, 'forgotForm'], 'guest');
    $r->post('/forgot-password', [AuthController::class, 'forgot'], 'guest');
    $r->get('/reset-password', [AuthController::class, 'resetForm'], 'guest');
    $r->post('/reset-password', [AuthController::class, 'reset'], 'guest');
    $r->get('/verify-email', [AuthController::class, 'verifyForm'], 'guest');
    $r->post('/verify-email', [AuthController::class, 'verify'], 'guest');
    $r->post('/verify-email/resend', [AuthController::class, 'resendVerification'], 'guest');
    $r->get('/invite/{token}', [AuthController::class, 'inviteShow'], 'guest');
    $r->post('/invite/{token}', [AuthController::class, 'inviteAccept'], 'guest');

    // Dashboard.
    $r->get('/', [DashboardController::class, 'home'], 'session');
    $r->get('/workspaces/new', [DashboardController::class, 'newWorkspace'], 'session');
    $r->post('/workspaces', [DashboardController::class, 'createWorkspace'], 'session');
    $r->get('/account', [AccountController::class, 'show'], 'session');
    $r->post('/account/profile', [AccountController::class, 'updateProfile'], 'session');
    $r->post('/account/password', [AccountController::class, 'changePassword'], 'session');
    $r->post('/account/sessions/{id}/revoke', [AccountController::class, 'revokeSession'], 'session');
    $r->post('/account/sessions/revoke-others', [AccountController::class, 'revokeOtherSessions'], 'session');

    $r->get('/w/{ws}', [WorkspaceController::class, 'overview'], 'session');
    $r->get('/w/{ws}/settings', [WorkspaceController::class, 'settings'], 'session');
    $r->post('/w/{ws}/settings', [WorkspaceController::class, 'rename'], 'session');
    $r->get('/w/{ws}/audit', [WorkspaceController::class, 'audit'], 'session');
    $r->get('/w/{ws}/members', [MembersController::class, 'index'], 'session');
    $r->post('/w/{ws}/members/invite', [MembersController::class, 'invite'], 'session');
    $r->post('/w/{ws}/invitations/{id}/revoke', [MembersController::class, 'revokeInvitation'], 'session');
    $r->post('/w/{ws}/members/{id}/role', [MembersController::class, 'changeRole'], 'session');
    $r->post('/w/{ws}/members/{id}/revoke', [MembersController::class, 'revoke'], 'session');
    $r->post('/w/{ws}/support-grants', [MembersController::class, 'grantSupport'], 'session');
    $r->post('/w/{ws}/support-grants/{id}/revoke', [MembersController::class, 'revokeSupport'], 'session');

    // Websites, credentials and per-website settings.
    $r->get('/w/{ws}/websites', [WebsiteController::class, 'index'], 'session');
    $r->post('/w/{ws}/websites', [WebsiteController::class, 'create'], 'session');
    $r->get('/w/{ws}/websites/{id}', [WebsiteController::class, 'show'], 'session');
    $r->post('/w/{ws}/websites/{id}', [WebsiteController::class, 'update'], 'session');
    $r->post('/w/{ws}/websites/{id}/pairing-code', [WebsiteController::class, 'pairingCode'], 'session');
    $r->post('/w/{ws}/websites/{id}/rotate', [WebsiteController::class, 'rotate'], 'session');
    $r->post('/w/{ws}/websites/{id}/disconnect', [WebsiteController::class, 'disconnect'], 'session');
    $r->post('/w/{ws}/websites/{id}/delete', [WebsiteController::class, 'delete'], 'session');
    $r->post('/w/{ws}/websites/{id}/settings/{section}', [WebsiteController::class, 'saveSettings'], 'session');

    // WordPress connector (server-to-server).
    $r->post('/api/v1/integration/pair', [IntegrationController::class, 'pair']);
    $r->get('/api/v1/integration/config', [IntegrationController::class, 'config'], 'integration');
    $r->post('/api/v1/integration/heartbeat', [IntegrationController::class, 'heartbeat'], 'integration');
    $r->post('/api/v1/integration/rotate', [IntegrationController::class, 'rotate'], 'integration');
    $r->post('/api/v1/integration/disconnect', [IntegrationController::class, 'disconnect'], 'integration');
    $r->put('/api/v1/integration/settings', [IntegrationController::class, 'updateSettings'], 'integration');

    // Inbox, live visitors, visitor profiles and blocking (HTML).
    $r->get('/w/{ws}/inbox', [InboxController::class, 'inbox'], 'session');
    $r->get('/w/{ws}/live', [InboxController::class, 'live'], 'session');
    $r->get('/w/{ws}/visitors', [VisitorController::class, 'index'], 'session');
    $r->get('/w/{ws}/visitors/{id}', [VisitorController::class, 'show'], 'session');
    $r->post('/w/{ws}/visitors/{id}/block', [VisitorController::class, 'block'], 'session');
    $r->post('/w/{ws}/visitors/{id}/unblock', [VisitorController::class, 'unblock'], 'session');
    $r->post('/w/{ws}/visitors/{id}/delete', [VisitorController::class, 'delete'], 'session');
    $r->get('/w/{ws}/blocks', [VisitorController::class, 'blocks'], 'session');

    // Dashboard JSON API (session + X-CSRF-Token on writes).
    $d = '/api/v1/dashboard/w/{ws}';
    $r->get($d . '/conversations', [InboxApiController::class, 'conversations'], 'session', ['poll' => true]);
    $r->get($d . '/conversations/{id}', [InboxApiController::class, 'conversation'], 'session');
    $r->get($d . '/conversations/{id}/messages', [InboxApiController::class, 'messages'], 'session', ['poll' => true]);
    $r->post($d . '/conversations/{id}/messages', [InboxApiController::class, 'reply'], 'session');
    $r->post($d . '/conversations/{id}/status', [InboxApiController::class, 'status'], 'session');
    $r->post($d . '/conversations/{id}/read', [InboxApiController::class, 'read'], 'session', ['poll' => true]);
    $r->get($d . '/live', [InboxApiController::class, 'live'], 'session', ['poll' => true]);

    // Public visitor widget API. Only visitor-facing endpoints exist under this prefix.
    $wgt = '/api/v1/widget/{site}';
    $r->post($wgt . '/session', [WidgetController::class, 'session'], 'widget');
    $r->get($wgt . '/messages', [WidgetController::class, 'messages'], 'widget');
    $r->post($wgt . '/messages', [WidgetController::class, 'send'], 'widget');
    $r->post($wgt . '/contact', [WidgetController::class, 'contact'], 'widget');
    $r->post($wgt . '/consent', [WidgetController::class, 'consent'], 'widget');
    $r->post($wgt . '/events', [WidgetController::class, 'events'], 'widget');

    // Platform administration.
    $r->get('/admin', [AdminController::class, 'index'], 'session');
    $r->post('/admin/migrate', [AdminController::class, 'runMigrations'], 'session');
    $r->get('/admin/users', [AdminController::class, 'users'], 'session');
    $r->post('/admin/users/{id}/status', [AdminController::class, 'setUserStatus'], 'session');
    $r->get('/admin/workspaces', [AdminController::class, 'workspaces'], 'session');
    $r->post('/admin/workspaces/{id}/status', [AdminController::class, 'setWorkspaceStatus'], 'session');
    $r->get('/admin/settings', [AdminController::class, 'settings'], 'session');
    $r->post('/admin/settings', [AdminController::class, 'saveSettings'], 'session');
    $r->get('/admin/audit', [AdminController::class, 'audit'], 'session');
};
