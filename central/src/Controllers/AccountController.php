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
    public function show(Request $request, array $errors = [], int $status = 200, array $extra = []): Response
    {
        $user = $this->user($request);
        $twoFactor = $this->app->get(\Signalpost\Auth\TwoFactorService::class);
        return $this->page($request, 'account', array_replace([
            'title' => 'Account',
            'sessions' => $this->app->get(SessionManager::class)->activeForUser($user['id']),
            'currentSessionId' => (int) $request->attributes['session']['id'],
            'devices' => $this->app->get(\Signalpost\Push\PushService::class)->subscriptions($user['id']),
            'pushPreview' => (bool) $this->app->db()->value('SELECT push_show_preview FROM users WHERE id = ?', [$user['id']]),
            'errors' => $errors,
            'twoFactorOn' => $twoFactor->isEnabled($user['id']),
            'recoveryLeft' => $twoFactor->remainingRecoveryCodes($user['id']),
            'setupSecret' => null,
            'recoveryCodes' => null,
            'setupUri' => null,
        ], $extra), 'layout_app', $status);
    }

    public function twoFactorSetup(Request $request): Response
    {
        $user = $this->user($request);
        $secret = $this->app->get(\Signalpost\Auth\TwoFactorService::class)->beginSetup($user['id']);
        return $this->show($request, [], 200, ['setupSecret' => $secret,
            'setupUri' => \Signalpost\Security\Totp::uri($secret, $user['email'], (string) $this->app->config->get('app.name'))]);
    }

    public function twoFactorEnable(Request $request): Response
    {
        $user = $this->user($request);
        $svc = $this->app->get(\Signalpost\Auth\TwoFactorService::class);
        try {
            $codes = $svc->enable($user['id'], (string) $request->input('code', ''));
        } catch (HttpException $e) {
            if ($e->status !== 422) {
                throw $e;
            }
            $secret = $svc->pendingSecret($user['id']);
            return $this->show($request, $e->details, 422, ['setupSecret' => $secret,
                'setupUri' => $secret ? \Signalpost\Security\Totp::uri($secret, $user['email'], (string) $this->app->config->get('app.name')) : null]);
        }
        // Signing in elsewhere now needs the second factor: end other sessions.
        $this->app->get(SessionManager::class)->revokeAllForUser($user['id'], (int) $request->attributes['session']['id']);
        return $this->show($request, [], 200, ['recoveryCodes' => $codes]);
    }

    public function twoFactorDisable(Request $request): Response
    {
        return $this->withErrors(function () use ($request) {
            $this->app->get(\Signalpost\Auth\TwoFactorService::class)->disable($this->user($request)['id'], (string) $request->input('password', ''), (string) $request->input('code', ''));
            return Response::redirect('/account?ok=saved#two-factor');
        }, fn ($e, $s) => $this->show($request, $e, $s));
    }

    public function recoveryCodes(Request $request): Response
    {
        $user = $this->user($request);
        $svc = $this->app->get(\Signalpost\Auth\TwoFactorService::class);
        if (!$svc->verifyCode($user['id'], (string) $request->input('code', ''))) {
            return $this->show($request, ['recovery_code' => 'That code is not valid.'], 422);
        }
        return $this->show($request, [], 200, ['recoveryCodes' => $svc->regenerateRecoveryCodes($user['id'])]);
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
