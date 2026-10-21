<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Auth\AuthService;
use Signalpost\Auth\SessionManager;
use Signalpost\Core\HttpException;
use Signalpost\Core\Validator;
use Signalpost\Http\Request;
use Signalpost\Http\Response;

final class AccountController extends Controller
{
    public function show(Request $request, array $errors = [], int $status = 200): Response
    {
        $user = $this->user($request);
        return $this->page($request, 'account', [
            'title' => 'Account',
            'sessions' => $this->app->get(SessionManager::class)->activeForUser($user['id']),
            'currentSessionId' => (int) $request->attributes['session']['id'],
            'errors' => $errors,
        ], 'layout_app', $status);
    }

    public function updateProfile(Request $request): Response
    {
        return $this->withErrors(function () use ($request) {
            $data = Validator::of($request->allInput())->string('display_name', 1, 100)->check();
            $this->app->db()->exec('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', [$data['display_name'], $this->app->clock->sql(), $this->user($request)['id']]);
            return Response::redirect('/account?ok=saved');
        }, fn ($e, $s) => $this->show($request, $e, $s));
    }

    public function changePassword(Request $request): Response
    {
        return $this->withErrors(function () use ($request) {
            $new = (string) $request->input('new_password', '');
            if ($new !== (string) $request->input('new_password_confirm', '')) {
                throw HttpException::validation(['new_password_confirm' => 'Passwords do not match.']);
            }
            $this->app->get(AuthService::class)->changePassword(
                $this->user($request)['id'],
                (string) $request->input('current_password', ''),
                $new,
                (int) $request->attributes['session']['id']
            );
            return Response::redirect('/account?ok=password');
        }, fn ($e, $s) => $this->show($request, $e, $s));
    }

    public function revokeSession(Request $request): Response
    {
        $id = $request->intParam('id');
        $userId = $this->user($request)['id'];
        $n = $this->app->db()->exec('UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [$this->app->clock->sql(), $id, $userId]);
        if ($n !== 1) {
            throw HttpException::notFound();
        }
        return Response::redirect('/account?ok=revoked');
    }

    public function revokeOtherSessions(Request $request): Response
    {
        $this->app->get(SessionManager::class)->revokeAllForUser($this->user($request)['id'], (int) $request->attributes['session']['id']);
        return Response::redirect('/account?ok=revoked');
    }
}
