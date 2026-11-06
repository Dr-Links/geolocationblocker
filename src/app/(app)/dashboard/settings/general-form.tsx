"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/forms/field";
import { TimezoneSelect } from "@/components/app/timezone-select";
import type { ActionState } from "@/server/action-state";
import { updateWorkspaceAction } from "./actions";

export function GeneralForm({ name, timezone, canEdit }: { name: string; timezone: string; canEdit: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateWorkspaceAction, {});
  return (
    <form action={action} className="grid max-w-md gap-4">
      <Field name="name" label="Workspace name" defaultValue={state.values?.name ?? name} disabled={!canEdit} errors={state.fieldErrors?.name} />
      <TimezoneSelect defaultValue={state.values?.timezone ?? timezone} disabled={!canEdit} error={state.fieldErrors?.timezone?.[0]} />
      <FormMessage state={state} />
      {canEdit ? <Button type="submit" disabled={pending} className="w-fit">{pending ? "Saving…" : "Save changes"}</Button> : null}
    </form>
  );
}
