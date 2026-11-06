"use server";

import { redirect } from "next/navigation";
import { toActionState, type ActionState } from "@/server/action-state";
import { openBillingPortal, startCheckout } from "@/server/billing/checkout";
import { idSchema } from "@/lib/validation/workspace";
import { requireTenant } from "@/server/tenancy/context";

export async function checkoutAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let url: string;
  try {
    const ctx = await requireTenant("billing.manage");
    url = (await startCheckout(ctx, idSchema.parse(formData.get("planId")))).url;
  } catch (err) {
    return toActionState(err);
  }
  redirect(url);
}

export async function portalAction(_prev: ActionState): Promise<ActionState> {
  let url: string;
  try {
    const ctx = await requireTenant("billing.manage");
    url = (await openBillingPortal(ctx)).url;
  } catch (err) {
    return toActionState(err);
  }
  redirect(url);
}
