"use server";

import { revalidatePath } from "next/cache";
import { toActionState, type ActionState } from "@/server/action-state";
import { requestGeneration, type GenerationInput } from "@/server/ai/service";
import { saveDraft } from "@/server/services/posts";
import { validateForAccounts, type AccountValidation } from "@/server/social/accounts";
import { requireTenant } from "@/server/tenancy/context";

export async function generateAction(input: GenerationInput): Promise<ActionState & { id?: string }> {
  try {
    const ctx = await requireTenant("content.create");
    const req = await requestGeneration(ctx, input);
    return { ok: true, id: req.id };
  } catch (err) {
    return toActionState(err);
  }
}

export async function saveDraftAction(input: { postId?: string; content: string; mediaAssetIds: string[] }): Promise<ActionState & { postId?: string }> {
  try {
    const ctx = await requireTenant("content.create");
    const post = await saveDraft(ctx, input);
    revalidatePath("/dashboard/compose");
    revalidatePath("/dashboard");
    return { ok: true, message: "Draft saved.", postId: post.id };
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
