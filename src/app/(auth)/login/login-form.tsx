"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/forms/field";
import { signInAction, type FormState } from "../actions";

export function LoginForm({ callbackUrl }: { callbackUrl?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signInAction, {});
  return (
    <form action={action} className="grid gap-4" noValidate>
      {callbackUrl ? <input type="hidden" name="callbackUrl" value={callbackUrl} /> : null}
      <Field name="email" label="Email" type="email" autoComplete="email" required
        defaultValue={state.values?.email} errors={state.fieldErrors?.email} />
      <Field name="password" label="Password" type="password" autoComplete="current-password" required
        errors={state.fieldErrors?.password} />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>{pending ? "Signing in…" : "Log in"}</Button>
    </form>
  );
}
