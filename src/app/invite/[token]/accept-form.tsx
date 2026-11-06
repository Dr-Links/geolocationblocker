"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/forms/field";
import { acceptInviteAction } from "@/app/workspace-actions";
import type { ActionState } from "@/server/action-state";

export function AcceptInviteForm({ token, workspaceName }: { token: string; workspaceName: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(acceptInviteAction, {});
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="token" value={token} />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>{pending ? "Joining…" : `Join ${workspaceName}`}</Button>
    </form>
  );
}
