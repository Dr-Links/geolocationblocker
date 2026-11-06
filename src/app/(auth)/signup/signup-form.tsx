"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/forms/field";
import { signUpAction, type FormState } from "../actions";

export function SignUpForm({ invite }: { invite?: { token: string; email: string; workspaceName: string } }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signUpAction, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      {invite ? <input type="hidden" name="inviteToken" value={invite.token} /> : null}
      <Field name="name" label="Your name" autoComplete="name" required defaultValue={state.values?.name} errors={fe.name} />
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        readOnly={!!invite}
        defaultValue={invite?.email ?? state.values?.email}
        errors={fe.email}
      />
      <Field name="password" label="Password" type="password" autoComplete="new-password" required errors={fe.password} />
      {invite ? null : (
        <Field name="workspaceName" label="Workspace name" placeholder="Acme Inc." required
          defaultValue={state.values?.workspaceName} errors={fe.workspaceName} />
      )}
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Creating account…" : invite ? `Create account & join ${invite.workspaceName}` : "Create account"}
      </Button>
    </form>
  );
}
