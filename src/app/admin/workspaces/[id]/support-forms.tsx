"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/forms/field";
import type { ActionState } from "@/server/action-state";
import { impersonateAction, suspendWorkspaceAction } from "../../actions";

export function ImpersonateForm({ workspaceId }: { workspaceId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(impersonateAction, {});
  return (
    <form action={action} className="grid gap-3 sm:max-w-lg">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <Field name="reason" id="impersonate-reason" label="Why you need access (audit log)" placeholder="e.g. Ticket #123: scheduled post not publishing" errors={state.fieldErrors?.reason} required />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="w-fit">{pending ? "Starting…" : "Open workspace as support"}</Button>
    </form>
  );
}

export function SuspendForm({ workspaceId, suspended }: { workspaceId: string; suspended: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(suspendWorkspaceAction, {});
  return (
    <form action={action} className="grid gap-3 sm:max-w-lg">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="suspend" value={suspended ? "false" : "true"} />
      {suspended ? null : <Field name="reason" id="suspend-reason" label="Reason for suspending" errors={state.fieldErrors?.reason} required />}
      <FormMessage state={state} />
      <Button type="submit" variant={suspended ? "default" : "destructive"} disabled={pending} className="w-fit">
        {pending ? "…" : suspended ? "Reinstate workspace" : "Suspend workspace"}
      </Button>
    </form>
  );
}
