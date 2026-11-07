"use server";

import { revalidatePath } from "next/cache";
import { idSchema } from "@/lib/validation/workspace";
import { toActionState, type ActionState } from "@/server/action-state";
import { checkAccountHealth, disconnectAccount } from "@/server/social/accounts";
import { requireTenant } from "@/server/tenancy/context";

export async function checkHealthAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant("accounts.manage");
    const a = await checkAccountHealth(ctx, idSchema.parse(f.get("accountId")));
    revalidatePath("/dashboard/accounts");
    return a.status === "CONNECTED" ? { ok: true, message: "Connection OK." } : { error: a.lastError ?? `Status: ${a.status}` };
  } catch (err) {
    return toActionState(err);
  }
}

export async function disconnectAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant("accounts.manage");
    await disconnectAccount(ctx, idSchema.parse(f.get("accountId")));
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/dashboard/accounts");
  return { ok: true, message: "Disconnected." };
}
