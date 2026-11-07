"use server";

import { revalidatePath } from "next/cache";
import { toActionState, type ActionState } from "@/server/action-state";
import { removeWorkspaceKey, setWorkspaceKey } from "@/server/ai/credentials";
import { updatePreferences } from "@/server/ai/preferences";
import { requireTenant } from "@/server/tenancy/context";
import type { AiProvider } from "@prisma/client";

const PATH = "/dashboard/settings/ai";

export async function savePreferencesAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant("settings.ai");
    const pref = (t: string) => ({ provider: String(f.get(`${t}_provider`) ?? "AUTO"), model: String(f.get(`${t}_model`) ?? "") });
    await updatePreferences(ctx, { TEXT: pref("TEXT"), IMAGE: pref("IMAGE"), VIDEO: pref("VIDEO") });
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath(PATH);
  return { ok: true, message: "Defaults saved." };
}

export async function saveKeyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant("settings.ai");
    await setWorkspaceKey(ctx, String(f.get("provider")) as AiProvider, String(f.get("apiKey") ?? ""));
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath(PATH);
  return { ok: true, message: "Key saved. Generations with this provider now use your key and no platform credits." };
}

export async function removeKeyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant("settings.ai");
    await removeWorkspaceKey(ctx, String(f.get("provider")) as AiProvider);
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath(PATH);
  return { ok: true, message: "Key removed." };
}
