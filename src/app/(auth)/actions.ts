"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";
import { safeRedirectPath } from "@/lib/redirect";
import { signInSchema, signUpSchema } from "@/lib/validation/auth";
import { EmailTakenError, registerUser } from "@/server/services/users";

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  values?: Record<string, string>;
}

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = { email: String(formData.get("email") ?? ""), password: String(formData.get("password") ?? "") };
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors, values: { email: raw.email } };

  try {
    await signIn("credentials", {
      ...parsed.data,
      redirectTo: safeRedirectPath(formData.get("callbackUrl")),
    });
  } catch (err) {
    if (err instanceof AuthError) return { error: "Invalid email or password", values: { email: raw.email } };
    throw err; // NEXT_REDIRECT on success
  }
  return {};
}

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    workspaceName: String(formData.get("workspaceName") ?? ""),
  };
  const values = { name: raw.name, email: raw.email, workspaceName: raw.workspaceName };
  const parsed = signUpSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors, values };

  try {
    await registerUser(parsed.data);
  } catch (err) {
    if (err instanceof EmailTakenError) return { fieldErrors: { email: [err.message] }, values };
    throw err;
  }

  await signIn("credentials", { email: parsed.data.email, password: parsed.data.password, redirectTo: "/dashboard" });
  return {};
}

export async function signInWithProviderAction(formData: FormData) {
  await signIn(String(formData.get("provider")), { redirectTo: "/dashboard" });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
