"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/forms/field";
import type { ActionState } from "@/server/action-state";
import { mockPortalAction } from "../actions";

export function PortalButton({ token, kind, planId, label, variant = "outline" }: { token: string; kind: string; planId?: string; label: string; variant?: "outline" | "destructive" | "default" | "ghost" }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(mockPortalAction, {});
  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="t" value={token} />
      <input type="hidden" name="kind" value={kind} />
      {planId ? <input type="hidden" name="planId" value={planId} /> : null}
      <Button type="submit" variant={variant} size="sm" disabled={pending}>{pending ? "…" : label}</Button>
      <FormMessage state={state} />
    </form>
  );
}
