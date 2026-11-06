"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";
import { safeRedirectPath } from "@/lib/redirect";
import { signInSchema, signUpSchema, signUpWithInviteSchema } from "@/lib/validation/auth";
import { toActionState, type ActionState } from "@/server/action-state";
import { RateLimitError } from "@/server/errors";
import { enforceRateLimit, envLimit } from "@/server/rate-limit";
import { clientIp } from "@/server/request";
import { recordAudit } from "@/server/services/audit";
import { EmailTakenError, registerUser } from "@/server/services/users";
import { clearActiveWorkspace, setActiveWorkspace } from "@/server/tenancy/active-workspace";

export type FormState = ActionState;

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const raw = { email: String(formData.get("email") ?? ""), password: String(formData.get("password") ?? "") };
  const values = { email: raw.email };
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors, values };

  try {
    const ip = await clientIp();
    const limit = envLimit("RATE_LIMIT_LOGIN_PER_15M", 10);
    // Per-account (stops password guessing on one account) and per-IP (stops spraying).
    await enforceRateLimit(`login:email:${parsed.data.email}`, limit, 15 * 60);
    await enforceRateLimit(`login:ip:${ip}`, limit * 5, 15 * 60);
  } catch (err) {
    if (err instanceof RateLimitError) {
      await recordAudit({ action: "auth.rate_limited", metadata: { email: parsed.data.email } });
      return { error: err.message, values };
    }
    throw err;
  }

  try {
    await signIn("credentials", { ...parsed.data, redirectTo: safeRedirectPath(formData.get("callbackUrl")) });
  } catch (err) {
    if (err instanceof AuthError) return { error: "Invalid email or password", values };
    throw err; // NEXT_REDIRECT on success
  }
  return {};
}

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const inviteToken = String(formData.get("inviteToken") ?? "") || undefined;
  const raw = {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    workspaceName: String(formData.get("workspaceName") ?? ""),
  };
  const values = { name: raw.name, email: raw.email, workspaceName: raw.workspaceName };
  const parsed = (inviteToken ? signUpWithInviteSchema : signUpSchema).safeParse(raw);
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors, values };

  let workspaceId: string;
  try {
    await enforceRateLimit(`signup:ip:${await clientIp()}`, envLimit("RATE_LIMIT_SIGNUP_PER_HOUR", 5), 60 * 60);
    const { workspace } = inviteToken
      ? await registerUser({ ...parsed.data, inviteToken })
      : await registerUser({ ...(parsed.data as typeof parsed.data & { workspaceName: string }) });
    workspaceId = workspace.id;
  } catch (err) {
    if (err instanceof EmailTakenError) return { fieldErrors: { email: [err.message] }, values };
    return toActionState(err, values);
  }

  await setActiveWorkspace(workspaceId);
  await signIn("credentials", { email: parsed.data.email, password: parsed.data.password, redirectTo: "/dashboard" });
  return {};
}

export async function signInWithProviderAction(formData: FormData) {
  await signIn(String(formData.get("provider")), { redirectTo: "/dashboard" });
}

export async function signOutAction() {
  await clearActiveWorkspace();
  await signOut({ redirectTo: "/login" });
}
