"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/forms/field";
import type { ActionState } from "@/server/action-state";
import { mockPayAction } from "../actions";

export function MockPayForm({ token, amount }: { token: string; amount: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(mockPayAction, {});
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="t" value={token} />
      <Field name="card" label="Card number" defaultValue="4242 4242 4242 4242" inputMode="numeric" autoComplete="off"
        hint="Test cards: 4242 4242 4242 4242 succeeds · 4000 0000 0000 0002 is declined" />
      <div className="grid grid-cols-2 gap-3">
        <Field name="exp" label="Expiry" defaultValue="12 / 34" />
        <Field name="cvc" label="CVC" defaultValue="123" />
      </div>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>{pending ? "Processing…" : `Pay ${amount}`}</Button>
    </form>
  );
}
