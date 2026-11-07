"use server";

import { revalidatePath } from "next/cache";
import { toActionState, type ActionState } from "@/server/action-state";
import { updateQueueSlots } from "@/server/scheduling/posts";
import { parseSlots } from "@/server/scheduling/queue-slots";
import { requireTenant } from "@/server/tenancy/context";

export async function addSlotAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant("workspace.update");
    const ws = await ctx.db.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { queueSlots: true } });
    const days = f.getAll("day").map(String);
    if (!days.length) return { error: "Pick at least one day" };
    await updateQueueSlots(ctx, [...parseSlots(ws.queueSlots), ...days.map((day) => ({ day: Number(day), time: String(f.get("time") ?? "") }))]);
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/dashboard/calendar");
  return { ok: true, message: "Slots added." };
}

export async function removeSlotAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant("workspace.update");
    const ws = await ctx.db.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { queueSlots: true } });
    const key = String(f.get("slot"));
    await updateQueueSlots(ctx, parseSlots(ws.queueSlots).filter((s) => `${s.day}-${s.time}` !== key));
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/dashboard/calendar");
  return { ok: true };
}
