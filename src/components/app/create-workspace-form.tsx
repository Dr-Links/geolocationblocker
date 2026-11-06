"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/forms/field";
import { TimezoneSelect } from "@/components/app/timezone-select";
import { createWorkspaceAction } from "@/app/workspace-actions";
import type { ActionState } from "@/server/action-state";

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createWorkspaceAction, {});
  return (
    <form action={action} className="grid gap-4">
      <Field name="name" label="Workspace name" placeholder="Acme Inc." required defaultValue={state.values?.name} errors={state.fieldErrors?.name} />
      <TimezoneSelect defaultValue={state.values?.timezone ?? "UTC"} error={state.fieldErrors?.timezone?.[0]} />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create workspace"}</Button>
    </form>
  );
}
