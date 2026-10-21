<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Admin\PlatformSettings;
use Signalpost\Auth\AuthService;
use Signalpost\Auth\SessionManager;
use Signalpost\Core\HttpException;
use Signalpost\Core\Validator;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Tenancy\WorkspaceService;

final class AuthController extends Controller
{
    public function loginForm(Request $request): Response
    {
        if (isset($request->attributes['user'])) {
            return Response::redirect('/');
        }
        if ((int) $this->app->db()->value('SELECT COUNT(*) FROM users') === 0) {
            return Response::redirect('/install');
        }
        return $this->page($request, 'auth/login', ['title' => 'Sign in', 'email' => '', 'errors' => [], 'registration' => $this->registrationMode()], 'layout_plain');
    }

    public function login(Request $request): Response
    {
        $email = strtolower(trim((string) $request->input('email', '')));
        $password = (string) $request->input('password', '');
        return $this->withErrors(function () use ($request, $email, $password) {
            if ($email === '' || $password === '' || strlen($email) > 254 || strlen($password) > 1024) {
                throw new HttpException(401, 'invalid_credentials', 'Invalid email or password.');
            }
            $userId = $this->app->get(AuthService::class)->login($email, $password, $request);
            $sessions = $this->app->get(SessionManager::class);
            // Regenerate: drop any session presented with this request, issue a new one.
            if (isset($request->attributes['session'])) {
                $sessions->revoke((int) $request->attributes['session']['id']);
            }
            $created = $sessions->create($userId, $request);
            $response = Response::redirect('/');
            $sessions->attachCookie($response, $request, $created['token']);
            return $response;
        }, fn (array $errors, int $status) => $this->page($request, 'auth/login', [
            'title' => 'Sign in', 'email' => $email, 'errors' => $errors, 'registration' => $this->registrationMode(),
            'unverified' => str_contains((string) ($errors['_form'] ?? ''), 'verify'),
        ], 'layout_plain', $status));
    }

    public function logout(Request $request): Response
    {
        $sessions = $this->app->get(SessionManager::class);
        $sessions->revoke((int) $request->attributes['session']['id']);
        $response = Response::redirect('/login?ok=logged_out');
        $sessions->clearCookie($response, $request);
        return $response;
    }

    public function registerForm(Request $request): Response
    {
        if ($this->registrationMode() !== 'open') {
            return $this->page($request, 'auth/registration_closed', ['title' => 'Registration'], 'layout_plain', 403);
        }
        return $this->page($request, 'auth/register', ['title' => 'Create account', 'old' => [], 'errors' => []], 'layout_plain');
    }

    public function register(Request $request): Response
    {
        $input = $request->allInput();
        return $this->withErrors(function () use ($request, $input) {
            $data = Validator::of($input)
                ->email('email')
                ->string('display_name', 1, 100)
                ->string('workspace_name', 2, 100)
                ->string('password', 1, 1024)
                ->check();
            if (($input['password'] ?? '') !== ($input['password_confirm'] ?? null)) {
                throw HttpException::validation(['password_confirm' => 'Passwords do not match.']);
            }
            $result = $this->app->get(AuthService::class)->register($data['email'], (string) $input['password'], $data['display_name'], $data['workspace_name'], $request);
            if (!$result['needs_verification'] && $result['user_id'] !== null) {
                return Response::redirect('/login?ok=verified');
            }
            return Response::redirect('/login?ok=check_email');
        }, fn (array $errors, int $status) => $this->page($request, 'auth/register', [
            'title' => 'Create account', 'old' => $input, 'errors' => $errors,
        ], 'layout_plain', $status));
    }

    public function forgotForm(Request $request): Response
    {
        return $this->page($request, 'auth/forgot', ['title' => 'Reset password', 'errors' => []], 'layout_plain');
    }

    public function forgot(Request $request): Response
    {
        $email = strtolower(trim((string) $request->input('email', '')));
        if (filter_var($email, FILTER_VALIDATE_EMAIL) !== false) {
            $this->app->get(AuthService::class)->requestPasswordReset($email, $request);
        }
        return Response::redirect('/login?ok=check_email');
    }

    public function resetForm(Request $request): Response
    {
        return $this->page($request, 'auth/reset', ['title' => 'Choose a new password', 'token' => $request->queryString('token'), 'errors' => []], 'layout_plain');
    }

    public function reset(Request $request): Response
    {
        $token = (string) $request->input('token', '');
        return $this->withErrors(function () use ($request, $token) {
            $password = (string) $request->input('password', '');
            if ($password !== (string) $request->input('password_confirm', '')) {
                throw HttpException::validation(['password_confirm' => 'Passwords do not match.']);
            }
            $this->app->get(AuthService::class)->resetPassword($token, $password);
            $response = Response::redirect('/login?ok=reset');
            $this->app->get(SessionManager::class)->clearCookie($response, $request);
            return $response;
        }, fn (array $errors, int $status) => $this->page($request, 'auth/reset', [
            'title' => 'Choose a new password', 'token' => $token, 'errors' => $errors,
        ], 'layout_plain', $status));
    }

    /** GET shows a confirmation button so link scanners cannot consume the token. */
    public function verifyForm(Request $request): Response
    {
        return $this->page($request, 'auth/verify', ['title' => 'Verify email', 'token' => $request->queryString('token'), 'failed' => false], 'layout_plain');
    }

    public function verify(Request $request): Response
    {
        $token = (string) $request->input('token', '');
        if ($this->app->get(AuthService::class)->verifyEmail($token)) {
            return Response::redirect('/login?ok=verified');
        }
        return $this->page($request, 'auth/verify', ['title' => 'Verify email', 'token' => '', 'failed' => true], 'layout_plain', 400);
    }

    public function resendVerification(Request $request): Response
    {
        $email = strtolower(trim((string) $request->input('email', '')));
        if (filter_var($email, FILTER_VALIDATE_EMAIL) !== false) {
            $this->app->get(AuthService::class)->resendVerification($email, $request);
        }
        return Response::redirect('/login?ok=check_email');
    }

    public function inviteShow(Request $request): Response
    {
        $token = $request->param('token');
        $inv = $this->app->get(WorkspaceService::class)->findInvitation($token);
        if ($inv === null) {
            return $this->page($request, 'auth/invite_invalid', ['title' => 'Invitation'], 'layout_plain', 404);
        }
        $existing = $this->app->db()->value('SELECT id FROM users WHERE email = ?', [$inv['email']]) !== null;
        return $this->page($request, 'auth/invite', [
            'title' => 'Join workspace', 'inv' => $inv, 'token' => $token, 'existing' => $existing, 'errors' => [],
        ], 'layout_plain');
    }

    public function inviteAccept(Request $request): Response
    {
        $token = $request->param('token');
        $workspaces = $this->app->get(WorkspaceService::class);
        $inv = $workspaces->findInvitation($token);
        if ($inv === null) {
            return $this->page($request, 'auth/invite_invalid', ['title' => 'Invitation'], 'layout_plain', 404);
        }
        $existing = $this->app->db()->value('SELECT id FROM users WHERE email = ?', [$inv['email']]) !== null;
        return $this->withErrors(function () use ($request, $token, $inv, $existing, $workspaces) {
            $user = $request->attributes['user'] ?? null;
            if ($user === null) {
                if ($existing) {
                    throw HttpException::unauthorized('Sign in with the invited email address, then open the invitation link again.');
                }
                if ($this->registrationMode() === 'closed') {
                    throw HttpException::forbidden('New accounts cannot be created while registration is closed. Ask the platform owner.');
                }
                // New account: the invitation link proves control of the mailbox.
                $data = Validator::of($request->allInput())->string('display_name', 1, 100)->string('password', 1, 1024)->check();
                if ($request->input('password') !== $request->input('password_confirm')) {
                    throw HttpException::validation(['password_confirm' => 'Passwords do not match.']);
                }
                $userId = $this->app->get(AuthService::class)->createInvitedUser($inv['email'], (string) $request->input('password'), $data['display_name']);
                $user = ['id' => $userId, 'email' => $inv['email']];
                $wsId = $workspaces->acceptInvitation($token, $user);
                if ($this->app->db()->value('SELECT status FROM users WHERE id = ?', [$userId]) !== 'active') {
                    return Response::redirect('/login?ok=check_email');
                }
                $sessions = $this->app->get(SessionManager::class);
                $created = $sessions->create($userId, $request);
                $response = Response::redirect('/w/' . $wsId . '?ok=joined');
                $sessions->attachCookie($response, $request, $created['token']);
                return $response;
            }
            $wsId = $workspaces->acceptInvitation($token, $user);
            return Response::redirect('/w/' . $wsId . '?ok=joined');
        }, fn (array $errors, int $status) => $this->page($request, 'auth/invite', [
            'title' => 'Join workspace', 'inv' => $inv, 'token' => $token, 'existing' => $existing, 'errors' => $errors,
        ], 'layout_plain', $status));
    }

    private function registrationMode(): string
    {
        return (string) $this->app->get(PlatformSettings::class)->get('registration_mode');
    }
}
