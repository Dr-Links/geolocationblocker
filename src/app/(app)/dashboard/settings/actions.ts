"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { idSchema, workspaceRoleSchema } from "@/lib/validation/workspace";
import { toActionState, type ActionState } from "@/server/action-state";
import { changeMemberRole, createInvitation, removeMember, revokeInvitation } from "@/server/services/members";
import { updateWorkspace } from "@/server/services/workspaces";
import { clearActiveWorkspace } from "@/server/tenancy/active-workspace";
import { requireTenant } from "@/server/tenancy/context";

const MEMBERS_PATH = "/dashboard/settings/members";

export async function updateWorkspaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = { name: String(formData.get("name") ?? ""), timezone: String(formData.get("timezone") ?? "") };
  try {
    const ctx = await requireTenant("workspace.update");
    await updateWorkspace(ctx, values);
  } catch (err) {
    return toActionState(err, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved." };
}

export async function inviteMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = { email: String(formData.get("email") ?? ""), role: String(formData.get("role") ?? "MEMBER") };
  try {
    const ctx = await requireTenant("members.manage");
    const { url, invitation } = await createInvitation(ctx, { email: values.email, role: workspaceRoleSchema.parse(values.role) });
    revalidatePath(MEMBERS_PATH);
    return { ok: true, message: `Invitation created for ${invitation.email}.`, data: { url } };
  } catch (err) {
    return toActionState(err, values);
  }
}

export async function changeRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant("members.manage");
    await changeMemberRole(ctx, idSchema.parse(formData.get("membershipId")), workspaceRoleSchema.parse(formData.get("role")));
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath(MEMBERS_PATH);
  return { ok: true };
}

export async function removeMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let leftSelf = false;
  try {
    const ctx = await requireTenant();
    const membershipId = idSchema.parse(formData.get("membershipId"));
    const own = await ctx.db.membership.findFirst({ where: { id: membershipId, userId: ctx.userId }, select: { id: true } });
    await removeMember(ctx, membershipId);
    leftSelf = !!own;
  } catch (err) {
    return toActionState(err);
  }
  if (leftSelf) {
    await clearActiveWorkspace();
    revalidatePath("/", "layout");
    redirect("/dashboard");
  }
  revalidatePath(MEMBERS_PATH);
  return { ok: true };
}

export async function revokeInviteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant("members.manage");
    await revokeInvitation(ctx, idSchema.parse(formData.get("invitationId")));
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath(MEMBERS_PATH);
  return { ok: true };
}
