<?php

declare(strict_types=1);

namespace Signalpost\Controllers;

use Signalpost\Core\HttpException;
use Signalpost\Core\Validator;
use Signalpost\Http\Request;
use Signalpost\Http\Response;
use Signalpost\Sites\SettingsSchema;
use Signalpost\Sites\WebsiteService;

final class WebsiteController extends Controller
{
    private const TABS = ['connection', 'widget', 'tracking', 'retention'];

    public function index(Request $request, array $errors = [], array $old = [], int $status = 200): Response
    {
        $ctx = $this->ctx($request, 'websites.read');
        return $this->page($request, 'websites', [
            'title' => 'Websites & widget',
            'sites' => $this->app->get(WebsiteService::class)->list($ctx),
            'errors' => $errors,
            'old' => $old,
        ], 'layout_app', $status);
    }

    public function create(Request $request): Response
    {
        $ctx = $this->ctx($request, 'websites.manage');
        $input = $request->allInput();
        return $this->withErrors(function () use ($ctx, $input) {
            $data = Validator::of($input)->string('name', 2, 100)->string('origin', 8, 255)->check();
            $id = $this->app->get(WebsiteService::class)->create($ctx, $data['name'], $data['origin']);
            return Response::redirect("/w/{$ctx->workspaceId}/websites/{$id}?ok=created");
        }, fn ($e, $s) => $this->index($request, $e, $input, $s));
    }

    public function show(Request $request, array $errors = [], ?string $pairingCode = null, int $status = 200, ?string $tab = null): Response
    {
        $ctx = $this->ctx($request, 'websites.read');
        $sites = $this->app->get(WebsiteService::class);
        $site = $sites->get($ctx, $request->intParam('id'));
        $tab = $tab ?? (in_array($request->queryString('tab'), self::TABS, true) ? $request->queryString('tab') : 'connection');
        return $this->page($request, 'website_detail', [
            'title' => $site['name'],
            'site' => $site,
            'settings' => $sites->settings((int) $site['id']),
            'credentials' => $sites->activeCredentials($ctx, (int) $site['id']),
            'tab' => $tab,
            'errors' => $errors,
            'pairingCode' => $pairingCode,
            'pairingTtlMinutes' => intdiv(WebsiteService::PAIRING_TTL, 60),
            'centralUrl' => rtrim((string) $this->app->config->get('app.url'), '/'),
        ], 'layout_app', $status);
    }

    public function update(Request $request): Response
    {
        $ctx = $this->ctx($request, 'websites.manage');
        $id = $request->intParam('id');
        return $this->withErrors(function () use ($request, $ctx, $id) {
            $data = Validator::of($request->allInput())->string('name', 2, 100)->string('origin', 8, 255)->check();
            $this->app->get(WebsiteService::class)->update($ctx, $id, $data['name'], $data['origin']);
            return Response::redirect("/w/{$ctx->workspaceId}/websites/{$id}?ok=saved");
        }, fn ($e, $s) => $this->show($request, $e, null, $s));
    }

    public function pairingCode(Request $request): Response
    {
        $ctx = $this->ctx($request, 'credentials.manage');
        $code = $this->app->get(WebsiteService::class)->createPairingCode($ctx, $request->intParam('id'));
        // Rendered directly (not redirected) so the code is shown exactly once.
        return $this->show($request, [], $code);
    }

    public function rotate(Request $request): Response
    {
        $ctx = $this->ctx($request, 'credentials.manage');
        $id = $request->intParam('id');
        $this->app->get(WebsiteService::class)->requestRotation($ctx, $id);
        return Response::redirect("/w/{$ctx->workspaceId}/websites/{$id}?ok=saved");
    }

    public function disconnect(Request $request): Response
    {
        $ctx = $this->ctx($request, 'credentials.manage');
        $id = $request->intParam('id');
        $this->app->get(WebsiteService::class)->disconnect($ctx, $id);
        return Response::redirect("/w/{$ctx->workspaceId}/websites/{$id}?ok=disconnected");
    }

    public function delete(Request $request): Response
    {
        $ctx = $this->ctx($request, 'websites.manage');
        $id = $request->intParam('id');
        return $this->withErrors(function () use ($request, $ctx, $id) {
            $this->app->get(WebsiteService::class)->delete($ctx, $id, (string) $request->input('confirm_name', ''));
            return Response::redirect("/w/{$ctx->workspaceId}/websites?ok=deleted");
        }, fn ($e, $s) => $this->show($request, $e, null, $s));
    }

    public function saveSettings(Request $request): Response
    {
        $ctx = $this->ctx($request, 'settings.manage');
        $id = $request->intParam('id');
        $section = $request->param('section');
        if (!in_array($section, ['widget', 'tracking', 'retention'], true)) {
            throw HttpException::notFound();
        }
        $sites = $this->app->get(WebsiteService::class);
        $sites->get($ctx, $id, 'settings.manage');
        $input = $request->allInput();
        unset($input['_csrf']);
        // HTML checkboxes are absent when unchecked: map them explicitly.
        $schema = match ($section) {
            'widget' => SettingsSchema::WIDGET,
            'tracking' => SettingsSchema::TRACKING,
            default => SettingsSchema::RETENTION,
        };
        foreach ($schema as $key => $def) {
            if ($def[0] === 'bool') {
                $input[$key] = isset($input[$key]);
            }
        }
        return $this->withErrors(function () use ($ctx, $id, $section, $input, $sites) {
            if ($section === 'tracking' && ($input['legal_basis'] ?? 'consent') === 'other'
                && $sites->settings($id)['tracking']['legal_basis'] !== 'other' && empty($input['ack_other_basis'])) {
                throw HttpException::validation(['ack_other_basis' => 'Confirm that you have assessed and documented another legal basis.']);
            }
            $sites->updateSettings($ctx->workspaceId, $id, $section, $input, $ctx->userId);
            return Response::redirect("/w/{$ctx->workspaceId}/websites/{$id}?tab={$section}&ok=saved");
        }, fn ($e, $s) => $this->show($request, $e, null, $s, $section));
    }
}
