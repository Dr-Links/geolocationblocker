"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/forms/field";
import type { ActionState } from "@/server/action-state";
import { compWorkspaceAction, removeCompAction } from "../../actions";
import { CompFields } from "../../comp-fields";

export function CompForm({ workspaceId, plans, hasPaid }: { workspaceId: string; plans: { id: string; name: string }[]; hasPaid: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(compWorkspaceAction, {});
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <CompFields plans={plans} errors={state.fieldErrors} />
      {hasPaid ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="cancelPaid" className="size-4" />
          Also cancel their paid subscription at the end of the current period
        </label>
      ) : null}
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="w-fit">{pending ? "Saving…" : "Comp this workspace"}</Button>
    </form>
  );
}

export function RemoveCompForm({ workspaceId }: { workspaceId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(removeCompAction, {});
  return (
    <form action={action} className="grid gap-3 sm:max-w-md">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <Field name="reason" label="Reason for removing (optional)" />
      <FormMessage state={state} />
      <Button type="submit" variant="destructive" disabled={pending} className="w-fit">{pending ? "Removing…" : "Remove comp"}</Button>
    </form>
  );
}
