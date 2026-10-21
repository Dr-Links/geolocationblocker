<?php
/**
 * Test-only helper that drives the central application's services directly
 * (used by the integration scripts; never deployed).
 *
 * Usage: SIGNALPOST_CONFIG=... php central-helper.php <command> [args]
 */

declare(strict_types=1);

$factory = require __DIR__ . '/../../central/bootstrap.php';
$app = $factory();
$db = $app->db();
$cmd = $argv[1] ?? '';

$ownerCtx = static function () use ($db): \Signalpost\Tenancy\WorkspaceContext {
    $ws = $db->one('SELECT id, name, owner_user_id FROM workspaces ORDER BY id LIMIT 1');
    return new \Signalpost\Tenancy\WorkspaceContext((int) $ws['id'], $ws['name'], (int) $ws['owner_user_id'], 'owner', (int) $ws['owner_user_id']);
};

switch ($cmd) {
    case 'setup':
        $app->migrator()->migrate();
        if ((int) $db->value('SELECT COUNT(*) FROM users') === 0) {
            $app->get(\Signalpost\Auth\AuthService::class)->createPlatformOwner('owner@example.test', 'integration-pass-1', 'Owner', 'Integration WS');
        }
        $ctx = $ownerCtx();
        $origin = $argv[2];
        $id = $db->value('SELECT id FROM websites WHERE canonical_origin = ?', [$origin]);
        if ($id === null) {
            $id = $app->get(\Signalpost\Sites\WebsiteService::class)->create($ctx, 'Integration WP', $origin);
        }
        echo json_encode(['workspace_id' => $ctx->workspaceId, 'website_id' => (int) $id]), "\n";
        break;
    case 'pairing-code':
        echo $app->get(\Signalpost\Sites\WebsiteService::class)->createPairingCode($ownerCtx(), (int) $argv[2]), "\n";
        break;
    case 'request-rotation':
        $app->get(\Signalpost\Sites\WebsiteService::class)->requestRotation($ownerCtx(), (int) $argv[2]);
        echo "ok\n";
        break;
    case 'settings':
        $app->get(\Signalpost\Sites\WebsiteService::class)->updateSettings($ownerCtx()->workspaceId, (int) $argv[2], $argv[3], json_decode($argv[4], true), null);
        echo "ok\n";
        break;
    case 'query':
        echo json_encode($db->all($argv[2])), "\n";
        break;
    default:
        fwrite(STDERR, "unknown command\n");
        exit(1);
}
