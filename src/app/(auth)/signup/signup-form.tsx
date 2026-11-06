"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { signUpAction, type FormState } from "../actions";
import { Field } from "../field";

export function SignUpForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(signUpAction, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <Field name="name" label="Your name" autoComplete="name" required defaultValue={state.values?.name} errors={fe.name} />
      <Field name="email" label="Email" type="email" autoComplete="email" required defaultValue={state.values?.email} errors={fe.email} />
      <Field name="password" label="Password" type="password" autoComplete="new-password" required errors={fe.password} />
      <Field name="workspaceName" label="Workspace name" placeholder="Acme Inc." required
        defaultValue={state.values?.workspaceName} errors={fe.workspaceName} />
      {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={pending}>{pending ? "Creating account…" : "Create account"}</Button>
    </form>
  );
}
