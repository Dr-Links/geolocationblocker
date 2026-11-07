"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/forms/field";
import type { ActionState } from "@/server/action-state";

/** Small generic form wrapper: server action + submit button + message. */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel = "Saving…",
  variant = "default",
  className = "grid gap-4",
}: {
  action: (prev: ActionState, f: FormData) => Promise<ActionState>;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "default" | "outline" | "destructive" | "ghost";
  className?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={formAction} className={className}>
      {children}
      <FormMessage state={state} />
      {state.fieldErrors ? <p className="text-sm text-destructive">{Object.values(state.fieldErrors).flat()[0]}</p> : null}
      <Button type="submit" variant={variant} disabled={pending} className="w-fit">{pending ? pendingLabel : submitLabel}</Button>
    </form>
  );
}
