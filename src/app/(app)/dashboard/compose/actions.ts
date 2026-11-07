"use server";

import { revalidatePath } from "next/cache";
import { toActionState, type ActionState } from "@/server/action-state";
import { requestGeneration, type GenerationInput } from "@/server/ai/service";
import { saveDraft } from "@/server/services/posts";
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
