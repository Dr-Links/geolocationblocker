"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/forms/field";
import type { ActionState } from "@/server/action-state";
import { checkoutAction, portalAction } from "./actions";

export function ChoosePlanButton({ planId, label, variant = "default" }: { planId: string; label: string; variant?: "default" | "outline" }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(checkoutAction, {});
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="planId" value={planId} />
      <Button type="submit" variant={variant} disabled={pending} className="w-full">{pending ? "Redirecting…" : label}</Button>
      <FormMessage state={state} />
    </form>
  );
}

export function ManageBillingButton() {
  const [state, action, pending] = useActionState<ActionState>(portalAction, {});
  return (
    <form action={action} className="grid gap-2">
      <Button type="submit" variant="outline" disabled={pending}>{pending ? "Opening…" : "Manage billing"}</Button>
      <FormMessage state={state} />
    </form>
  );
}
