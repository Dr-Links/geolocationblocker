"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { toActionState, type ActionState } from "@/server/action-state";
import { NotFoundError } from "@/server/errors";
import { acceptInvitation } from "@/server/services/members";
import { createWorkspaceForUser } from "@/server/services/workspaces";
import { setActiveWorkspace } from "@/server/tenancy/active-workspace";
import { listMyWorkspaces, requireUser } from "@/server/tenancy/context";

export async function switchWorkspaceAction(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("workspaceId") ?? "");
  // Only allow switching into workspaces the user is actually a member of.
  const mine = await listMyWorkspaces(user.id);
  if (!mine.some((w) => w.id === id)) throw new NotFoundError("Workspace not found");
  await setActiveWorkspace(id);
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function createWorkspaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const values = { name: String(formData.get("name") ?? ""), timezone: String(formData.get("timezone") ?? "UTC") };
  let workspaceId: string;
  try {
    workspaceId = (await createWorkspaceForUser(user.id, values)).id;
  } catch (err) {
    return toActionState(err, values);
  }
  await setActiveWorkspace(workspaceId);
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function acceptInviteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  let workspaceId: string;
  try {
    workspaceId = (await acceptInvitation({ userId: user.id, email: user.email, token: String(formData.get("token") ?? "") })).id;
  } catch (err) {
    return toActionState(err);
  }
  await setActiveWorkspace(workspaceId);
  revalidatePath("/", "layout");
  redirect("/dashboard");
}
