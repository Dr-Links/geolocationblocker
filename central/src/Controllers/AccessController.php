<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Core\HttpException;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Licensing\AccessService;

/** Renewal of time-limited access, and the platform owner's activation-code admin. */
final class AccessController extends Controller
{
    public function renewForm(Request $request, array $errors = [], int $status = 200): Response
    {
        $user = $this->user($request);
        $access = $this->app->get(AccessService::class);
        return $this->page($request, 'renew', [
            'title' => 'Renew access',
            'expired' => $access->isExpired($user),
            'expiresAt' => $user['access_expires_at'],
            'errors' => $errors,
        ], 'layout_plain', $status);
    }

    public function renew(Request $request): Response
    {
        $user = $this->user($request);
        try {
            $this->app->get(AccessService::class)->renew($user['id'], (string) $request->input('activation_code', ''), $this->app->clientIp($request));
        } catch (HttpException $e) {
            if (in_array($e->status, [422, 429], true)) {
                return $this->renewForm($request, $e->details ?: ['activation_code' => $e->getMessage()], $e->status);
            }
            throw $e;
        }
        return Response::redirect('/?ok=renewed');
    }

    public function codes(Request $request, ?array $newCodes = null, array $errors = [], int $status = 200): Response
    {
        $this->requirePlatformAdmin($request);
        $filter = in_array($request->queryString('status'), ['unused', 'used', 'revoked'], true) ? $request->queryString('status') : 'all';
        return $this->page($request, 'admin/codes', [
            'title' => 'Activation codes',
            'rows' => $this->app->get(AccessService::class)->list($filter),
            'filter' => $filter,
            'newCodes' => $newCodes,
            'errors' => $errors,
            'durations' => AccessService::DURATIONS,
        ], 'layout_app', $status);
    }

    public function generate(Request $request): Response
    {
        $admin = $this->requirePlatformAdmin($request);
        $months = (int) $request->input('duration_months', 0);
        $qty = (int) $request->input('quantity', 1);
        try {
            $codes = $this->app->get(AccessService::class)->generate($admin['id'], $months, $qty, (string) $request->input('note', ''));
        } catch (HttpException $e) {
            if ($e->status === 422) {
                return $this->codes($request, null, $e->details, 422);
            }
            throw $e;
        }
        // Rendered directly (not redirected): codes are shown exactly once.
        return $this->codes($request, $codes);
    }

    public function revoke(Request $request): Response
    {
        $admin = $this->requirePlatformAdmin($request);
        $this->app->get(AccessService::class)->revoke($admin['id'], $request->intParam('id'));
        return Response::redirect('/admin/codes?ok=revoked');
    }

    public function extend(Request $request): Response
    {
        $admin = $this->requirePlatformAdmin($request);
        $this->app->get(AccessService::class)->extendByAdmin($admin['id'], $request->intParam('id'), (int) $request->input('months', 0));
        return Response::redirect('/admin/users?ok=saved');
    }
}
