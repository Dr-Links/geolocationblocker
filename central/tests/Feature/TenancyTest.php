<?php

declare(strict_types=1);

namespace Signalpost\Tests\Feature;

use Signalpost\Admin\PlatformSettings;
use Signalpost\Auth\Mailer;
use Signalpost\Tests\TestCase;

final class TenancyTest extends TestCase
{
    private int $a;
    private int $b;
    private int $wsA;
    private int $wsB;

    protected function setUp(): void
    {
        parent::setUp();
        $this->a = $this->makeUser('alice@example.com');
        $this->b = $this->makeUser('bob@example.com');
        $this->wsA = $this->makeWorkspace($this->a, 'Alice Co');
        $this->wsB = $this->makeWorkspace($this->b, 'Bob Co');
    }

    public function testUserCannotReadOrModifyAnotherWorkspace(): void
    {
        $alice = $this->loginAs('alice@example.com');
        $this->assertSame(200, $alice->get("/w/{$this->wsA}")->status);
        foreach (['', '/members', '/settings', '/audit'] as $suffix) {
            $res = $alice->get("/w/{$this->wsB}{$suffix}");
            $this->assertSame(404, $res->status, "GET /w/B{$suffix}");
            $this->assertStringNotContainsString('Bob Co', $res->body);
        }
        $this->assertSame(404, $alice->submit("/w/{$this->wsB}/members/invite", ['email' => 'x@example.com', 'role' => 'owner'])->status);
        $this->assertSame(404, $alice->submit("/w/{$this->wsB}/settings", ['name' => 'Pwned'])->status);
        $bobMember = (int) $this->app->db()->value('SELECT id FROM workspace_members WHERE workspace_id = ?', [$this->wsB]);
        // Modified IDs: Alice's workspace in the URL, Bob's member ID in the path.
        $this->assertSame(404, $alice->submit("/w/{$this->wsA}/members/{$bobMember}/revoke")->status);
        $this->assertSame(404, $alice->submit("/w/{$this->wsA}/members/{$bobMember}/role", ['role' => 'agent'])->status);
        $this->assertSame('Bob Co', $this->app->db()->value('SELECT name FROM workspaces WHERE id = ?', [$this->wsB]));
        $this->assertSame('active', $this->app->db()->value('SELECT status FROM workspace_members WHERE id = ?', [$bobMember]));
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM workspace_invitations'));
        // Workspace switcher lists only own workspaces.
        $page = $alice->get("/w/{$this->wsA}")->body;
        $this->assertStringNotContainsString('Bob Co', $page);
    }

    public function testNonNumericOrNegativeIdsAreNotFound(): void
    {
        $alice = $this->loginAs('alice@example.com');
        foreach (['0', '-1', 'abc', '1e3', '00' . $this->wsA, '99999999999999999999'] as $id) {
            $this->assertSame(404, $alice->get("/w/{$id}")->status, $id);
        }
    }

    public function testAgentCannotPerformOwnerOnlyActions(): void
    {
        $agent = $this->makeUser('agent@example.com');
        $this->addMember($this->wsA, $agent, 'agent');
        $b = $this->loginAs('agent@example.com');
        $this->assertSame(200, $b->get("/w/{$this->wsA}")->status);
        $this->assertSame(200, $b->get("/w/{$this->wsA}/members")->status);
        $this->assertSame(403, $b->get("/w/{$this->wsA}/settings")->status);
        $this->assertSame(403, $b->get("/w/{$this->wsA}/audit")->status);
        $this->assertSame(403, $b->submit("/w/{$this->wsA}/settings", ['name' => 'Renamed'])->status);
        $this->assertSame(403, $b->submit("/w/{$this->wsA}/members/invite", ['email' => 'x@example.com', 'role' => 'owner'])->status);
        $self = (int) $this->app->db()->value('SELECT id FROM workspace_members WHERE user_id = ?', [$agent]);
        $this->assertSame(403, $b->submit("/w/{$this->wsA}/members/{$self}/role", ['role' => 'owner'])->status, 'no self-promotion');
        $this->assertSame('agent', $this->app->db()->value('SELECT role FROM workspace_members WHERE id = ?', [$self]));
        $this->assertSame(403, $b->submit("/w/{$this->wsA}/support-grants", ['hours' => 2, 'reason' => 'x'])->status);
    }

    public function testRevokedMemberLosesAccessImmediately(): void
    {
        $agent = $this->makeUser('agent@example.com');
        $memberId = $this->addMember($this->wsA, $agent, 'agent');
        $agentBrowser = $this->loginAs('agent@example.com');
        $this->assertSame(200, $agentBrowser->get("/w/{$this->wsA}")->status);

        $alice = $this->loginAs('alice@example.com');
        $this->assertSame(303, $alice->submit("/w/{$this->wsA}/members/{$memberId}/revoke")->status);
        $this->assertSame(404, $agentBrowser->get("/w/{$this->wsA}")->status);
        $this->assertStringContainsString('member.revoked', json_encode($this->app->db()->all('SELECT action FROM audit_logs')));
    }

    public function testPrimaryOwnerCannotBeRemovedOrDemoted(): void
    {
        $coOwner = $this->makeUser('co@example.com');
        $this->addMember($this->wsA, $coOwner, 'owner');
        $co = $this->loginAs('co@example.com');
        $primary = (int) $this->app->db()->value('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [$this->wsA, $this->a]);
        $this->assertSame(403, $co->submit("/w/{$this->wsA}/members/{$primary}/revoke")->status);
        $this->assertSame(403, $co->submit("/w/{$this->wsA}/members/{$primary}/role", ['role' => 'agent'])->status);
    }

    public function testSuspendedAccountLosesAccessToProtectedOperations(): void
    {
        $this->app->db()->exec('UPDATE users SET is_platform_admin = 1 WHERE id = ?', [$this->a]);
        $bob = $this->loginAs('bob@example.com');
        $this->assertSame(200, $bob->get("/w/{$this->wsB}")->status);
        $admin = $this->loginAs('alice@example.com');
        $this->assertSame(303, $admin->submit("/admin/users/{$this->b}/status", ['status' => 'suspended'])->status);
        $this->assertSame(303, $bob->get("/w/{$this->wsB}")->status, 'session invalid after suspension');
        $this->assertSame(303, $bob->submit("/w/{$this->wsB}/settings", ['name' => 'X'])->status, 'writes redirect to login');
        $this->assertSame('Bob Co', $this->app->db()->value('SELECT name FROM workspaces WHERE id = ?', [$this->wsB]));
        // Admin cannot suspend themselves.
        $this->assertSame(403, $admin->submit("/admin/users/{$this->a}/status", ['status' => 'suspended'])->status);
    }

    public function testSuspendedWorkspaceIsInaccessible(): void
    {
        $this->app->db()->exec('UPDATE users SET is_platform_admin = 1 WHERE id = ?', [$this->a]);
        $admin = $this->loginAs('alice@example.com');
        $bob = $this->loginAs('bob@example.com');
        $admin->submit("/admin/workspaces/{$this->wsB}/status", ['status' => 'suspended']);
        $this->assertSame(404, $bob->get("/w/{$this->wsB}")->status);
    }

    public function testInvitationFlowForNewUser(): void
    {
        $alice = $this->loginAs('alice@example.com');
        $res = $alice->submit("/w/{$this->wsA}/members/invite", ['email' => 'Carol@Example.com', 'role' => 'agent']);
        $this->assertSame(200, $res->status);
        $mail = $this->app->get(Mailer::class)->sent;
        $this->assertSame('carol@example.com', $mail[0]['to']);
        preg_match('#/invite/([A-Za-z0-9_\-]+)#', $mail[0]['body'], $m);
        $token = $m[1];
        $this->assertStringContainsString('/invite/' . $token, $res->body, 'link shown once to the owner');
        $this->assertNull($this->app->db()->value('SELECT id FROM workspace_invitations WHERE token_hash = ?', [$token]));

        $carol = $this->client();
        $this->assertSame(200, $carol->get('/invite/' . $token)->status);
        $res = $carol->post('/invite/' . $token, ['form' => ['_csrf' => $carol->cookies['sp_csrf'], 'display_name' => 'Carol', 'password' => 'carols-password-1', 'password_confirm' => 'carols-password-1']]);
        $this->assertSame(303, $res->status);
        $this->assertSame("/w/{$this->wsA}?ok=joined", $res->headers['Location']);
        $this->assertSame(200, $carol->get("/w/{$this->wsA}")->status);
        $this->assertSame(404, $carol->get("/w/{$this->wsB}")->status);
        $this->assertSame('agent', $this->app->db()->value("SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'carol@example.com'"));
        // Reuse fails.
        $this->assertSame(404, $this->client()->get('/invite/' . $token)->status);
    }

    public function testInvitationCannotBeAcceptedByDifferentAccount(): void
    {
        $alice = $this->loginAs('alice@example.com');
        $alice->submit("/w/{$this->wsA}/members/invite", ['email' => 'carol@example.com', 'role' => 'owner']);
        preg_match('#/invite/([A-Za-z0-9_\-]+)#', $this->app->get(Mailer::class)->sent[0]['body'], $m);
        $bob = $this->loginAs('bob@example.com');
        $res = $bob->submit('/invite/' . $m[1]);
        $this->assertSame(403, $res->status);
        $this->assertSame(0, (int) $this->app->db()->value('SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [$this->wsA, $this->b]));
    }

    public function testRevokedAndExpiredInvitationsDoNotWork(): void
    {
        $alice = $this->loginAs('alice@example.com');
        $alice->submit("/w/{$this->wsA}/members/invite", ['email' => 'c1@example.com', 'role' => 'agent']);
        $alice->submit("/w/{$this->wsA}/members/invite", ['email' => 'c2@example.com', 'role' => 'agent']);
        $sent = $this->app->get(Mailer::class)->sent;
        preg_match('#/invite/([A-Za-z0-9_\-]+)#', $sent[0]['body'], $m1);
        preg_match('#/invite/([A-Za-z0-9_\-]+)#', $sent[1]['body'], $m2);
        $id = (int) $this->app->db()->value("SELECT id FROM workspace_invitations WHERE email = 'c1@example.com'");
        $alice->submit("/w/{$this->wsA}/invitations/{$id}/revoke");
        $this->assertSame(404, $this->client()->get('/invite/' . $m1[1])->status);
        $this->app->clock->advance(8 * 86400);
        $this->assertSame(404, $this->client()->get('/invite/' . $m2[1])->status);
    }

    public function testClosedRegistrationBlocksNewAccountsFromInvitations(): void
    {
        $this->app->get(PlatformSettings::class)->update(['registration_mode' => 'closed']);
        $alice = $this->loginAs('alice@example.com');
        $alice->submit("/w/{$this->wsA}/members/invite", ['email' => 'dan@example.com', 'role' => 'agent']);
        preg_match('#/invite/([A-Za-z0-9_\-]+)#', $this->app->get(Mailer::class)->sent[0]['body'], $m);
        $dan = $this->client();
        $dan->get('/invite/' . $m[1]);
        $res = $dan->post('/invite/' . $m[1], ['form' => ['_csrf' => $dan->cookies['sp_csrf'], 'display_name' => 'Dan', 'password' => 'dans-password-12', 'password_confirm' => 'dans-password-12']]);
        $this->assertSame(403, $res->status);
        $this->assertNull($this->app->db()->value("SELECT id FROM users WHERE email = 'dan@example.com'"));
    }

    public function testPlatformAdminPagesAreHiddenFromRegularUsers(): void
    {
        $bob = $this->loginAs('bob@example.com');
        foreach (['/admin', '/admin/users', '/admin/settings', '/admin/audit', '/admin/workspaces'] as $p) {
            $this->assertSame(404, $bob->get($p)->status, $p);
        }
        $this->assertSame(404, $bob->submit('/admin/settings', ['registration_mode' => 'open'])->status);
        $this->assertSame('invite_only', $this->app->get(PlatformSettings::class)->get('registration_mode'));
    }

    public function testPlatformAdminHasNoImplicitWorkspaceAccessButSupportGrantGivesAuditedReadOnly(): void
    {
        $admin = $this->makeUser('root@example.com', true);
        $root = $this->loginAs('root@example.com');
        $this->assertSame(200, $root->get('/admin/users')->status);
        $this->assertSame(404, $root->get("/w/{$this->wsB}")->status, 'no implicit access to customer workspace');

        $bob = $this->loginAs('bob@example.com');
        $this->assertSame(303, $bob->submit("/w/{$this->wsB}/support-grants", ['hours' => 1, 'reason' => 'Help with setup'])->status);
        $res = $root->get("/w/{$this->wsB}");
        $this->assertSame(200, $res->status);
        $this->assertStringContainsString('Support access', $res->body);
        $this->assertSame(1, (int) $this->app->db()->value("SELECT COUNT(*) FROM audit_logs WHERE workspace_id = ? AND action = 'support.access' AND actor_user_id = ?", [$this->wsB, $admin]));
        // Read-only: owner/agent actions are refused.
        $this->assertSame(403, $root->submit("/w/{$this->wsB}/members/invite", ['email' => 'x@example.com', 'role' => 'owner'])->status);
        $this->assertSame(403, $root->get("/w/{$this->wsB}/settings")->status);

        $this->app->clock->advance(3600 + 1);
        $this->assertSame(200, $root->get('/account')->status, 'admin session still valid');
        $this->assertSame(404, $root->get("/w/{$this->wsB}")->status, 'grant expired');
    }

    public function testOwnerCanRevokeSupportGrant(): void
    {
        $this->makeUser('root@example.com', true);
        $bob = $this->loginAs('bob@example.com');
        $bob->submit("/w/{$this->wsB}/support-grants", ['hours' => 5, 'reason' => 'Help']);
        $root = $this->loginAs('root@example.com');
        $this->assertSame(200, $root->get("/w/{$this->wsB}")->status);
        $grant = (int) $this->app->db()->value('SELECT id FROM support_grants');
        $bob->submit("/w/{$this->wsB}/support-grants/{$grant}/revoke");
        $this->assertSame(404, $root->get("/w/{$this->wsB}")->status);
        // Alice cannot revoke Bob's grant via her own workspace URL.
        $this->assertSame(404, $this->loginAs('alice@example.com')->submit("/w/{$this->wsA}/support-grants/{$grant}/revoke")->status);
    }

    public function testWorkspaceLimitIsEnforced(): void
    {
        $this->app->get(PlatformSettings::class)->update(['max_workspaces_per_user' => 1]);
        $alice = $this->loginAs('alice@example.com');
        $res = $alice->submit('/workspaces', ['name' => 'Second']);
        $this->assertSame(403, $res->status);
        $this->assertSame(1, (int) $this->app->db()->value('SELECT COUNT(*) FROM workspaces WHERE owner_user_id = ?', [$this->a]));
    }

    public function testPlatformSettingsAreValidatedAgainstSchema(): void
    {
        $settings = $this->app->get(PlatformSettings::class);
        $this->expectException(\Signalpost\Core\HttpException::class);
        $settings->update(['registration_mode' => 'everyone']);
    }
}
