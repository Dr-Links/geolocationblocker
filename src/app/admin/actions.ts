"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { idSchema } from "@/lib/validation/workspace";
import { forceSignOut, setPlatformRole, setUserDisabled, setWorkspaceSuspended, startImpersonation } from "@/server/admin/management";
import { toActionState, type ActionState } from "@/server/action-state";
import { compWorkspace, createCompedAccount, removeComp } from "@/server/billing/comp";
import { FEATURE_KEYS, LIMIT_KEYS, type CompOverrides } from "@/server/billing/limits";
import { createPlan, syncPlansToProvider, updatePlan, type PlanInput } from "@/server/billing/plans";
import { requireSuperAdmin } from "@/server/tenancy/context";

// Every action re-checks SUPER_ADMIN against the DB; never trust the page that rendered the form.

function planFromForm(f: FormData): PlanInput {
  const dollars = String(f.get("price") ?? "0").replace(/[$,\s]/g, "");
  return {
    key: String(f.get("key") ?? ""),
    name: String(f.get("name") ?? ""),
    description: String(f.get("description") ?? ""),
    priceCents: Math.round(Number(dollars) * 100),
    currency: String(f.get("currency") ?? "usd") as PlanInput["currency"],
    interval: String(f.get("interval") ?? "MONTH") as PlanInput["interval"],
    maxPostsPerMonth: Number(f.get("maxPostsPerMonth")),
    monthlyCredits: Number(f.get("monthlyCredits")),
    maxSocialAccounts: Number(f.get("maxSocialAccounts")),
    maxMembers: Number(f.get("maxMembers")),
    features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, f.get(`feature_${k}`) === "on"])) as PlanInput["features"],
    isActive: f.get("isActive") === "on",
    isPublic: f.get("isPublic") === "on",
    sortOrder: Number(f.get("sortOrder") ?? 0),
  };
}

const formValues = (f: FormData) => Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]));

export async function createPlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let id: string;
  try {
    const admin = await requireSuperAdmin();
    id = (await createPlan(admin.id, planFromForm(formData))).id;
  } catch (err) {
    return toActionState(err, formValues(formData));
  }
  revalidatePath("/admin/plans");
  redirect(`/admin/plans/${id}?saved=created`);
}

export async function updatePlanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    const { repriced, grandfathered } = await updatePlan(admin.id, idSchema.parse(formData.get("planId")), planFromForm(formData));
    revalidatePath("/admin/plans");
    return {
      ok: true,
      message: repriced
        ? `Saved. New price is live for new checkouts; ${grandfathered} existing subscriber${grandfathered === 1 ? "" : "s"} keep${grandfathered === 1 ? "s" : ""} their current price.`
        : "Saved. Limit and feature changes apply to every workspace on this plan immediately.",
    };
  } catch (err) {
    return toActionState(err, formValues(formData));
  }
}

export async function syncPlansAction(_prev: ActionState): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    const synced = await syncPlansToProvider(admin.id);
    revalidatePath("/admin/plans");
    return { ok: true, message: synced.length ? `Created provider prices for: ${synced.join(", ")}` : "Everything is already in sync." };
  } catch (err) {
    return toActionState(err);
  }
}

function overridesFromForm(f: FormData): CompOverrides {
  const limits: Record<string, number> = {};
  for (const k of LIMIT_KEYS) {
    const raw = String(f.get(`ov_${k}`) ?? "").trim();
    if (raw !== "") limits[k] = Number(raw);
  }
  const features: Record<string, boolean> = {};
  for (const k of FEATURE_KEYS) {
    const v = String(f.get(`ovf_${k}`) ?? "inherit");
    if (v === "on" || v === "off") features[k] = v === "on";
  }
  return { limits, features };
}

export async function compWorkspaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    const expires = String(formData.get("expiresAt") ?? "");
    await compWorkspace(admin.id, idSchema.parse(formData.get("workspaceId")), {
      planId: String(formData.get("planId") ?? ""),
      overrides: overridesFromForm(formData),
      reason: String(formData.get("reason") ?? ""),
      expiresAt: expires ? new Date(`${expires}T23:59:59Z`) : null,
      cancelPaidSubscription: formData.get("cancelPaid") === "on",
    });
  } catch (err) {
    return toActionState(err, formValues(formData));
  }
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Workspace comped." };
}

export async function removeCompAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let workspaceId: string;
  try {
    const admin = await requireSuperAdmin();
    workspaceId = idSchema.parse(formData.get("workspaceId"));
    await removeComp(admin.id, workspaceId, String(formData.get("reason") ?? "") || undefined);
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/admin", "layout");
  // The "remove comp" card disappears once the comp is gone, so report success at page level.
  redirect(`/admin/workspaces/${workspaceId}?notice=uncomped`);
}

export async function createCompedAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    const expires = String(formData.get("expiresAt") ?? "");
    const res = await createCompedAccount(admin.id, {
      ownerEmail: String(formData.get("ownerEmail") ?? ""),
      workspaceName: String(formData.get("workspaceName") ?? ""),
      planId: String(formData.get("planId") ?? ""),
      overrides: overridesFromForm(formData),
      reason: String(formData.get("reason") ?? ""),
      expiresAt: expires ? new Date(`${expires}T23:59:59Z`) : null,
    });
    revalidatePath("/admin", "layout");
    return {
      ok: true,
      message: res.existingUser
        ? `Created "${res.workspace.name}". The user already had an account and is now its admin.`
        : `Created "${res.workspace.name}". Send the owner this link to set up their login:`,
      data: { workspaceId: res.workspace.id, ...(res.inviteUrl ? { url: res.inviteUrl } : {}) },
    };
  } catch (err) {
    return toActionState(err, formValues(formData));
  }
}

// ─── Phase 6: platform management ──────────────────────────────────────────


export async function suspendWorkspaceAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const admin = await requireSuperAdmin();
    id = idSchema.parse(f.get("workspaceId"));
    await setWorkspaceSuspended(admin.id, id, f.get("suspend") === "true", String(f.get("reason") ?? "") || undefined);
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/admin", "layout");
  redirect(`/admin/workspaces/${id}?notice=${f.get("suspend") === "true" ? "suspended" : "unsuspended"}`);
}

export async function impersonateAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    await startImpersonation(admin.id, idSchema.parse(f.get("workspaceId")), String(f.get("reason") ?? ""));
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

export async function userDisabledAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    await setUserDisabled(admin.id, idSchema.parse(f.get("userId")), f.get("disable") === "true", String(f.get("reason") ?? "") || undefined);
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/admin", "layout");
  return { ok: true, message: f.get("disable") === "true" ? "User disabled and signed out everywhere." : "User re-enabled." };
}

export async function forceSignOutAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    await forceSignOut(admin.id, idSchema.parse(f.get("userId")));
  } catch (err) {
    return toActionState(err);
  }
  return { ok: true, message: "All of this user's sessions were signed out." };
}

export async function platformRoleAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  try {
    const admin = await requireSuperAdmin();
    await setPlatformRole(admin.id, idSchema.parse(f.get("userId")), f.get("role") === "SUPER_ADMIN" ? "SUPER_ADMIN" : "USER");
  } catch (err) {
    return toActionState(err);
  }
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Role updated. They'll need to sign in again." };
}
