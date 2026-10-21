<?php

declare(strict_types=1);

namespace Signalpost\Tests;

use Signalpost\Http\Response;
use Signalpost\Sites\WebsiteService;
use Signalpost\Tenancy\WorkspaceContext;

/** Helpers for exercising the public widget API like a browser on the customer's site. */
trait WidgetFixtures
{
    /** Creates a connected website and returns its row. */
    protected function connectedSite(int $workspaceId, int $ownerId, string $origin = 'https://shop.example.com', string $name = 'Shop'): array
    {
        $ctx = new WorkspaceContext($workspaceId, 'ws', $ownerId, 'owner', $ownerId);
        $id = $this->app->get(WebsiteService::class)->create($ctx, $name, $origin);
        $this->app->db()->exec("UPDATE websites SET status = 'connected' WHERE id = ?", [$id]);
        return $this->app->db()->one('SELECT * FROM websites WHERE id = ?', [$id]);
    }

    protected function setSiteSettings(array $site, string $section, array $values): void
    {
        $this->app->get(WebsiteService::class)->updateSettings((int) $site['workspace_id'], (int) $site['id'], $section, $values, null);
    }

    protected function widget(array $site, string $method, string $path, ?string $token = null, ?array $json = null, array $headers = []): Response
    {
        $headers += ['Origin' => $site['canonical_origin']];
        if ($token !== null) {
            $headers['X-Visitor-Token'] = $token;
        }
        $opts = ['headers' => $headers];
        if ($json !== null) {
            $opts['json'] = $json;
        }
        return $this->request($method, '/api/v1/widget/' . $site['public_key'] . $path, $opts);
    }

    /** Starts a visitor session and returns [token, sessionData]. */
    protected function newVisitor(array $site): array
    {
        $res = $this->widget($site, 'POST', '/session', null, []);
        $this->assertSame(200, $res->status, $res->body);
        $data = $res->data();
        $this->assertIsString($data['token']);
        return [$data['token'], $data];
    }

    protected function visitorSend(array $site, string $token, string $body, ?string $clientId = null): Response
    {
        return $this->widget($site, 'POST', '/messages', $token, ['client_message_id' => $clientId ?? bin2hex(random_bytes(8)), 'body' => $body]);
    }

    protected function visitorRow(string $token): array
    {
        return $this->app->db()->one('SELECT * FROM visitors WHERE token_hash = ?', [$this->app->get(\Signalpost\Visitors\VisitorService::class)->tokenHash($token)]);
    }
}
