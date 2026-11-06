"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormMessage } from "@/components/forms/field";
import type { ActionState } from "@/server/action-state";
import { createCompedAccountAction } from "../../actions";
import { CompFields } from "../../comp-fields";

export function CreateCompedAccountForm({ plans }: { plans: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createCompedAccountAction, {});
  if (state.ok) {
    return (
      <div className="grid gap-3" data-testid="comped-created">
        <FormMessage state={state} />
        {state.data?.url ? <Input readOnly value={state.data.url} data-testid="comped-invite-link" onFocus={(e) => e.currentTarget.select()} /> : null}
        <div className="flex gap-3">
          <Button asChild variant="outline"><Link href={`/admin/workspaces/${state.data?.workspaceId}`}>View workspace</Link></Button>
          <Button asChild variant="ghost"><Link href="/admin/accounts/new">Create another</Link></Button>
        </div>
      </div>
    );
  }
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="ownerEmail" label="Owner email" type="email" required defaultValue={state.values?.ownerEmail} errors={fe.ownerEmail} />
        <Field name="workspaceName" label="Workspace name" required defaultValue={state.values?.workspaceName} errors={fe.workspaceName} />
      </div>
      <CompFields plans={plans} errors={fe} />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="w-fit">{pending ? "Creating…" : "Create free account"}</Button>
    </form>
  );
}
