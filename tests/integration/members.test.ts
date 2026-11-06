import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, systemDb } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/errors";
import { ConsoleMailer } from "@/server/mail";
import {
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  getInvitationByToken,
  listMembers,
  removeMember,
  revokeInvitation,
} from "@/server/services/members";
import { updateWorkspace } from "@/server/services/workspaces";
import { addMember, cleanupTestData, ctxFor, makeTenant, testEmail } from "./fixtures";

type Tenant = Awaited<ReturnType<typeof makeTenant>>;
let A: Tenant;
let B: Tenant;

const tokenFrom = (url: string) => url.split("/invite/")[1]!;

beforeAll(async () => {
  await cleanupTestData();
});
beforeEach(async () => {
  [A, B] = await Promise.all([makeTenant("alpha"), makeTenant("bravo")]);
});
afterAll(async () => {
  await cleanupTestData();
  await db.$disconnect();
});

const adminCtx = () => ctxFor(A.admin.id, A.workspace.id, "WORKSPACE_ADMIN");

describe("roles", () => {
  it("members can view but not manage", async () => {
    const { user } = await addMember(A.workspace.id);
    const memberCtx = ctxFor(user.id, A.workspace.id, "MEMBER");
    expect((await listMembers(memberCtx)).length).toBe(2);
    await expect(createInvitation(memberCtx, { email: testEmail("x") })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateWorkspace(memberCtx, { name: "Renamed", timezone: "UTC" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("admin can promote and demote", async () => {
    const { membership } = await addMember(A.workspace.id);
    expect((await changeMemberRole(adminCtx(), membership.id, "WORKSPACE_ADMIN")).role).toBe("WORKSPACE_ADMIN");
    expect((await changeMemberRole(adminCtx(), membership.id, "MEMBER")).role).toBe("MEMBER");
    expect(await systemDb.auditLog.count({ where: { action: "member.role_change", targetId: membership.id } })).toBe(2);
  });

  it("the last admin cannot be demoted or removed", async () => {
    const own = await systemDb.membership.findFirstOrThrow({ where: { userId: A.admin.id, workspaceId: A.workspace.id } });
    await expect(changeMemberRole(adminCtx(), own.id, "MEMBER")).rejects.toBeInstanceOf(ConflictError);
    await expect(removeMember(adminCtx(), own.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("a member can leave; a member cannot remove others", async () => {
    const m1 = await addMember(A.workspace.id, "MEMBER", "m1");
    const m2 = await addMember(A.workspace.id, "MEMBER", "m2");
    const m1Ctx = ctxFor(m1.user.id, A.workspace.id, "MEMBER");
    await expect(removeMember(m1Ctx, m2.membership.id)).rejects.toBeInstanceOf(ForbiddenError);
    await removeMember(m1Ctx, m1.membership.id);
    expect(await systemDb.membership.count({ where: { id: m1.membership.id } })).toBe(0);
  });

  it("an admin of workspace A cannot touch workspace B's members (not found)", async () => {
    const bMember = await addMember(B.workspace.id);
    await expect(changeMemberRole(adminCtx(), bMember.membership.id, "WORKSPACE_ADMIN")).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeMember(adminCtx(), bMember.membership.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await systemDb.membership.findUniqueOrThrow({ where: { id: bMember.membership.id } })).role).toBe("MEMBER");
  });
});

describe("invitations", () => {
  it("invite → email sent → token lookup → accept creates membership with the invited role", async () => {
    const invitee = await systemDb.user.create({ data: { email: testEmail("invitee") } });
    const { url, invitation } = await createInvitation(adminCtx(), { email: invitee.email.toUpperCase(), role: "WORKSPACE_ADMIN" });

    expect(invitation.email).toBe(invitee.email); // normalized
    expect(ConsoleMailer.outbox.at(-1)).toMatchObject({ to: invitee.email });
    expect(ConsoleMailer.outbox.at(-1)!.text).toContain(url);

    const token = tokenFrom(url);
    const stored = await systemDb.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(stored.tokenHash).not.toBe(token); // only the hash is stored

    expect((await getInvitationByToken(token))?.state).toBe("pending");
    const ws = await acceptInvitation({ userId: invitee.id, email: invitee.email, token });
    expect(ws.id).toBe(A.workspace.id);

    const m = await systemDb.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: invitee.id, workspaceId: A.workspace.id } },
    });
    expect(m.role).toBe("WORKSPACE_ADMIN");
    expect((await getInvitationByToken(token))?.state).toBe("accepted");
  });

  it("a token can only be used once", async () => {
    const invitee = await systemDb.user.create({ data: { email: testEmail("once") } });
    const { url } = await createInvitation(adminCtx(), { email: invitee.email });
    await acceptInvitation({ userId: invitee.id, email: invitee.email, token: tokenFrom(url) });
    await expect(acceptInvitation({ userId: invitee.id, email: invitee.email, token: tokenFrom(url) })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a different user cannot accept someone else's invite", async () => {
    const intruder = await systemDb.user.create({ data: { email: testEmail("intruder") } });
    const { url } = await createInvitation(adminCtx(), { email: testEmail("intended") });
    await expect(acceptInvitation({ userId: intruder.id, email: intruder.email, token: tokenFrom(url) })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await systemDb.membership.count({ where: { userId: intruder.id } })).toBe(0);
  });

  it("revoked and expired invitations cannot be accepted", async () => {
    const email = testEmail("revoked");
    const user = await systemDb.user.create({ data: { email } });
    const { url, invitation } = await createInvitation(adminCtx(), { email });
    await revokeInvitation(adminCtx(), invitation.id);
    await expect(acceptInvitation({ userId: user.id, email, token: tokenFrom(url) })).rejects.toBeInstanceOf(NotFoundError);

    const second = await createInvitation(adminCtx(), { email });
    await systemDb.invitation.update({ where: { id: second.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await getInvitationByToken(tokenFrom(second.url)))?.state).toBe("expired");
    await expect(acceptInvitation({ userId: user.id, email, token: tokenFrom(second.url) })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("re-inviting revokes the previous pending invite", async () => {
    const email = testEmail("reinvite");
    const first = await createInvitation(adminCtx(), { email });
    await createInvitation(adminCtx(), { email });
    expect((await getInvitationByToken(tokenFrom(first.url)))?.state).toBe("revoked");
  });

  it("cannot invite an existing member", async () => {
    const { user } = await addMember(A.workspace.id);
    await expect(createInvitation(adminCtx(), { email: user.email })).rejects.toBeInstanceOf(ConflictError);
  });

  it("cannot revoke another workspace's invitation", async () => {
    const bInvite = await createInvitation(ctxFor(B.admin.id, B.workspace.id, "WORKSPACE_ADMIN"), { email: testEmail("b-inv") });
    await expect(revokeInvitation(adminCtx(), bInvite.invitation.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("unknown tokens return null", async () => {
    expect(await getInvitationByToken("nope")).toBeNull();
    expect(await getInvitationByToken("x".repeat(500))).toBeNull();
  });
});

describe("workspace settings", () => {
  it("admin can rename + change timezone; audit captures before/after", async () => {
    const ws = await updateWorkspace(adminCtx(), { name: "Alpha Renamed", timezone: "Europe/Berlin" });
    expect(ws).toMatchObject({ name: "Alpha Renamed", timezone: "Europe/Berlin" });
    const log = await systemDb.auditLog.findFirstOrThrow({ where: { action: "workspace.update", workspaceId: A.workspace.id } });
    expect(log.metadata).toMatchObject({ before: { name: "alpha ws" }, after: { name: "Alpha Renamed" } });
  });

  it("rejects invalid timezones", async () => {
    await expect(updateWorkspace(adminCtx(), { name: "Fine", timezone: "Mars/Olympus" })).rejects.toThrow();
  });
});
