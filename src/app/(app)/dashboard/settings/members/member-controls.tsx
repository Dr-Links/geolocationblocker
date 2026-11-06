"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/forms/field";
import type { ActionState } from "@/server/action-state";
import { changeRoleAction, inviteMemberAction, removeMemberAction, revokeInviteAction } from "../actions";

export function RoleSelect({ membershipId, role }: { membershipId: string; role: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(changeRoleAction, {});
  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="membershipId" value={membershipId} />
      <NativeSelect name="role" defaultValue={role} disabled={pending} aria-label="Role"
        onChange={(e) => e.currentTarget.form?.requestSubmit()} className="h-8 w-36">
        <option value="WORKSPACE_ADMIN">Admin</option>
        <option value="MEMBER">Member</option>
      </NativeSelect>
      <FormMessage state={state} />
    </form>
  );
}

export function RemoveMemberButton({ membershipId, isSelf }: { membershipId: string; isSelf: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(removeMemberAction, {});
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(isSelf ? "Leave this workspace?" : "Remove this member?")) e.preventDefault();
      }}
      className="grid gap-1"
    >
      <input type="hidden" name="membershipId" value={membershipId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>{isSelf ? "Leave" : "Remove"}</Button>
      <FormMessage state={state} />
    </form>
  );
}

export function RevokeInviteButton({ invitationId }: { invitationId: string }) {
  const [, action, pending] = useActionState<ActionState, FormData>(revokeInviteAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="invitationId" value={invitationId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>Revoke</Button>
    </form>
  );
}

export function InviteForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(inviteMemberAction, {});
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3">
      <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="grid flex-1 gap-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input id="invite-email" name="email" type="email" required placeholder="teammate@company.com" defaultValue={state.ok ? "" : state.values?.email} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="invite-role">Role</Label>
          <NativeSelect id="invite-role" name="role" defaultValue="MEMBER" className="sm:w-36">
            <option value="MEMBER">Member</option>
            <option value="WORKSPACE_ADMIN">Admin</option>
          </NativeSelect>
        </div>
        <Button type="submit" disabled={pending}>{pending ? "Inviting…" : "Send invite"}</Button>
      </form>
      {state.fieldErrors?.email ? <p className="text-sm text-destructive">{state.fieldErrors.email[0]}</p> : null}
      <FormMessage state={state} />
      {state.data?.url ? (
        <div className="grid gap-2 rounded-md border bg-muted/40 p-3 text-sm">
          <p>No email provider is configured yet, so share this one-time link directly (expires in 7 days):</p>
          <div className="flex gap-2">
            <Input readOnly value={state.data.url} data-testid="invite-link" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={async () => {
              await navigator.clipboard.writeText(state.data!.url!);
              setCopied(true);
            }}>{copied ? "Copied" : "Copy"}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
