"use server";

import { revalidatePath } from "next/cache";
import { toActionState, type ActionState } from "@/server/action-state";
import { requestGeneration, type GenerationInput } from "@/server/ai/service";
import { deletePost, retryFailedTargets, savePost, schedulePost, unschedulePost, type SavePostInput, type ScheduleInput, type TargetCheck } from "@/server/scheduling/posts";
import { validateForAccounts, type AccountValidation } from "@/server/social/accounts";
import { requireTenant } from "@/server/tenancy/context";

const refresh = () => {
  for (const p of ["/dashboard", "/dashboard/compose", "/dashboard/posts", "/dashboard/calendar"]) revalidatePath(p);
};

export async function generateAction(input: GenerationInput): Promise<ActionState & { id?: string }> {
  try {
    const ctx = await requireTenant("content.create");
    const req = await requestGeneration(ctx, input);
    return { ok: true, id: req.id };
  } catch (err) {
    return toActionState(err);
  }
}

export async function savePostAction(input: SavePostInput): Promise<ActionState & { postId?: string }> {
  try {
    const ctx = await requireTenant("content.create");
    const post = await savePost(ctx, input);
    refresh();
    return { ok: true, message: "Draft saved.", postId: post.id };
  } catch (err) {
    return toActionState(err);
  }
}

/** Save, then schedule / publish now / add to queue. Returns per-account problems if any target fails validation. */
export async function saveAndScheduleAction(input: SavePostInput, schedule: ScheduleInput): Promise<ActionState & { postId?: string; checks?: TargetCheck[]; scheduledAt?: string }> {
  let postId: string | undefined;
  try {
    const ctx = await requireTenant("content.publish");
    postId = (await savePost(ctx, input)).id;
    const r = await schedulePost(ctx, postId, schedule);
    refresh();
    if (!r.ok) return { error: "Fix the issues below before scheduling.", postId, checks: r.checks };
    return { ok: true, postId, scheduledAt: r.scheduledAt.toISOString() };
  } catch (err) {
    return { ...toActionState(err), postId };
  }
}

export async function unscheduleAction(postId: string): Promise<ActionState> {
  try {
    await unschedulePost(await requireTenant("content.publish"), postId);
    refresh();
    return { ok: true, message: "Unscheduled. The post is a draft again." };
  } catch (err) {
    return toActionState(err);
  }
}

export async function retryAction(postId: string): Promise<ActionState> {
  try {
    await retryFailedTargets(await requireTenant("content.publish"), postId);
    refresh();
    return { ok: true, message: "Retrying failed platforms now." };
  } catch (err) {
    return toActionState(err);
  }
}

export async function deleteAction(postId: string): Promise<ActionState> {
  try {
    await deletePost(await requireTenant("content.create"), postId);
    refresh();
    return { ok: true, message: "Deleted." };
  } catch (err) {
    return toActionState(err);
  }
}

export async function validateAction(input: { content: string; mediaAssetIds: string[]; accountIds: string[] }): Promise<ActionState & { results?: AccountValidation[] }> {
  try {
    const ctx = await requireTenant("content.create");
    return { ok: true, results: await validateForAccounts(ctx, input) };
  } catch (err) {
    return toActionState(err);
  }
}
