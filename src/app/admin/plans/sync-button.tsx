"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/forms/field";
import type { ActionState } from "@/server/action-state";
import { syncPlansAction } from "../actions";

export function SyncPlansButton() {
  const [state, action, pending] = useActionState<ActionState>(syncPlansAction, {});
  return (
    <form action={action} className="grid gap-1">
      <Button type="submit" variant="outline" disabled={pending}>{pending ? "Syncing…" : "Sync plans to Stripe"}</Button>
      <FormMessage state={state} />
    </form>
  );
}
