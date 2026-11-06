"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { toActionState, type ActionState } from "@/server/action-state";
import { completeMockCheckout, runMockPortalAction, type MockPortalAction } from "@/server/billing/checkout";
import { setActiveWorkspace } from "@/server/tenancy/active-workspace";
import { requireUser } from "@/server/tenancy/context";

export async function mockPayAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  let workspaceId: string;
  try {
    ({ workspaceId } = await completeMockCheckout(String(formData.get("t") ?? ""), user.id, String(formData.get("card") ?? "")));
  } catch (err) {
    return toActionState(err);
  }
  await setActiveWorkspace(workspaceId);
  revalidatePath("/", "layout");
  redirect("/dashboard/billing?checkout=success");
}

const KINDS = new Set(["switch", "cancel_at_period_end", "resume", "cancel_now", "simulate_renewal", "simulate_payment_failed"]);

export async function mockPortalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const kind = String(formData.get("kind") ?? "");
  if (!KINDS.has(kind)) return { error: "Unknown action" };
  const action = (kind === "switch" ? { kind, planId: String(formData.get("planId") ?? "") } : { kind }) as MockPortalAction;
  try {
    await runMockPortalAction(String(formData.get("t") ?? ""), user.id, action);
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Done." };
}
