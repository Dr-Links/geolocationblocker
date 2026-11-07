"use server";

import type { AiProvider } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { toActionState, type ActionState } from "@/server/action-state";
import { removePlatformKey, setPlatformKey } from "@/server/ai/credentials";
import { setCreditCosts } from "@/server/settings";
import { requireSuperAdmin } from "@/server/tenancy/context";

export async function saveCreditCostsAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    await setCreditCosts(admin.id, { TEXT: f.get("TEXT"), IMAGE: f.get("IMAGE"), VIDEO: f.get("VIDEO") });
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/admin/ai");
  return { ok: true, message: "Credit costs saved. They apply to new generations." };
}

export async function savePlatformKeyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    await setPlatformKey(admin.id, String(f.get("provider")) as AiProvider, String(f.get("apiKey") ?? ""));
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/admin/ai");
  return { ok: true, message: "Platform key saved (encrypted)." };
}

export async function removePlatformKeyAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    await removePlatformKey(admin.id, String(f.get("provider")) as AiProvider);
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/admin/ai");
  return { ok: true, message: "Key removed." };
}
