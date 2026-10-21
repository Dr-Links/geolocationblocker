<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Auth\AuthService;
use Signalpost\Auth\SessionGuard;
use Signalpost\Core\HttpException;
use Signalpost\Core\Validator;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Security\Tokens;

/**
 * Web installer for hosts without SSH. It only works while no user exists.
 * Possession of a one-time setup token, written to storage/setup-token.txt
 * (outside the web root), proves the installer has file access to the
 * account, so a stranger cannot claim a fresh installation.
 */
final class InstallController extends Controller
{
    public function show(Request $request): Response
    {
        if ($this->installed()) {
            throw HttpException::notFound();
        }
        $this->ensureSetupToken();
        $csrf = $request->cookie(SessionGuard::GUEST_CSRF_COOKIE);
        $fresh = $csrf === null || preg_match('/^[0-9a-f]{64}$/', $csrf) !== 1;
        if ($fresh) {
            $csrf = Tokens::hex(32);
        }
        $response = Response::html($this->view()->render('install', [
            'title' => 'Install', 'csrf' => $csrf, 'errors' => [], 'old' => [],
            'tokenPath' => 'storage/setup-token.txt',
        ], 'layout_plain'));
        if ($fresh) {
            $response->cookie(SessionGuard::GUEST_CSRF_COOKIE, $csrf, ['path' => '/', 'httponly' => true, 'samesite' => 'Strict', 'secure' => $this->app->isSecure($request)]);
        }
        return $response;
    }

    public function submit(Request $request): Response
    {
        if ($this->installed()) {
            throw HttpException::notFound();
        }
        $cookie = (string) $request->cookie(SessionGuard::GUEST_CSRF_COOKIE);
        $sent = (string) $request->input('_csrf', '');
        if ($cookie === '' || !hash_equals($cookie, $sent)) {
            throw new HttpException(419, 'csrf_failed', 'Your form has expired. Please reload the page and try again.');
        }
        $input = $request->allInput();
        try {
            $expected = $this->ensureSetupToken();
            if (!hash_equals($expected, trim((string) ($input['setup_token'] ?? '')))) {
                throw HttpException::validation(['setup_token' => 'The setup token does not match the contents of storage/setup-token.txt.']);
            }
            $data = Validator::of($input)->email('email')->string('display_name', 1, 100)->string('workspace_name', 2, 100)->string('password', 1, 1024)->check();
            if (($input['password'] ?? '') !== ($input['password_confirm'] ?? null)) {
                throw HttpException::validation(['password_confirm' => 'Passwords do not match.']);
            }
            $this->app->migrator()->migrate();
            $this->app->get(AuthService::class)->createPlatformOwner($data['email'], (string) $input['password'], $data['display_name'], $data['workspace_name']);
            @unlink($this->tokenFile());
            return Response::redirect('/login?ok=installed');
        } catch (HttpException $e) {
            if ($e->status !== 422 && $e->status !== 409) {
                throw $e;
            }
            return Response::html($this->view()->render('install', [
                'title' => 'Install', 'csrf' => $cookie, 'errors' => $e->details ?: ['_form' => $e->getMessage()],
                'old' => $input, 'tokenPath' => 'storage/setup-token.txt',
            ], 'layout_plain'), 422);
        }
    }

    private function installed(): bool
    {
        try {
            return (int) $this->app->db()->value('SELECT COUNT(*) FROM users') > 0;
        } catch (\PDOException) {
            return false; // Tables not created yet.
        }
    }

    private function tokenFile(): string
    {
        return $this->app->config->get('paths.storage') . '/setup-token.txt';
    }

    private function ensureSetupToken(): string
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
