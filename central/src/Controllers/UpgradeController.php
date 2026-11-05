<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Audit\AuditLog;
use Signalpost\Auth\SessionGuard;
use Signalpost\Core\HttpException;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Security\Tokens;

/**
 * Web upgrade for hosts without SSH. When new code is uploaded over an
 * installed site, pending migrations are applied here. Like the installer,
 * it requires a one-time token written to storage/upgrade-token.txt (outside
 * the web root), so only someone with access to the hosting files can run it.
 * It is available only while migrations are pending.
 */
final class UpgradeController extends Controller
{
    public function show(Request $request): Response
    {
        $pending = $this->pending();
        if ($pending === []) {
            throw HttpException::notFound();
        }
        $this->ensureToken();
        $csrf = $request->cookie(SessionGuard::GUEST_CSRF_COOKIE);
        $fresh = $csrf === null || preg_match('/^[0-9a-f]{64}$/', $csrf) !== 1;
        if ($fresh) {
            $csrf = Tokens::hex(32);
        }
        $response = Response::html($this->view()->render('upgrade', [
            'title' => 'Update', 'csrf' => $csrf, 'pending' => $pending, 'errors' => [],
        ], 'layout_plain'), 200);
        if ($fresh) {
            $response->cookie(SessionGuard::GUEST_CSRF_COOKIE, $csrf, ['path' => '/', 'httponly' => true, 'samesite' => 'Strict', 'secure' => $this->app->isSecure($request)]);
        }
        return $response;
    }

    public function run(Request $request): Response
    {
        $pending = $this->pending();
        if ($pending === []) {
            throw HttpException::notFound();
        }
        $cookie = (string) $request->cookie(SessionGuard::GUEST_CSRF_COOKIE);
        if ($cookie === '' || !hash_equals($cookie, (string) $request->input('_csrf', ''))) {
            throw new HttpException(419, 'csrf_failed', 'Your form has expired. Please reload the page and try again.');
        }
        if (!hash_equals($this->ensureToken(), trim((string) $request->input('upgrade_token', '')))) {
            return Response::html($this->view()->render('upgrade', [
                'title' => 'Update', 'csrf' => $cookie, 'pending' => $pending,
                'errors' => ['upgrade_token' => 'The token does not match the contents of storage/upgrade-token.txt.'],
            ], 'layout_plain'), 422);
        }
        $done = $this->app->migrator()->migrate();
        @unlink($this->tokenFile());
        $this->app->get(AuditLog::class)->platform(null, 'platform.migrated', 'schema', '', ['migrations' => $done, 'via' => 'web upgrade'], 'system');
        return Response::redirect('/login?ok=upgraded');
    }

    private function pending(): array
    {
        try {
            return $this->app->migrator()->pending();
        } catch (\PDOException) {
            return [];
        }
    }

    private function tokenFile(): string
    {
        return $this->app->config->get('paths.storage') . '/upgrade-token.txt';
    }

    private function ensureToken(): string
    {
        $file = $this->tokenFile();
        if (!is_file($file)) {
            $old = umask(0077);
            file_put_contents($file, Tokens::random(24) . "\n");
            umask($old);
            @chmod($file, 0600);
        }
        return trim((string) file_get_contents($file));
    }
}
