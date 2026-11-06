import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db, systemDb, tenantDb } from "@/lib/db";
import { ForbiddenError } from "@/server/errors";
import { assertCan } from "./guard";
import type { Permission } from "./permissions";
import type { TenantContext } from "./types";

export const ACTIVE_WORKSPACE_COOKIE = "pp_ws";

/**
 * The signed-in user, re-read from the DB on every request (authoritative,
 * unlike the JWT). Returns null if signed out, disabled, or the session was
 * revoked by bumping `sessionVersion`.
 */
export const getSessionUser = cache(async () => {
  const session = await auth();
  if (!session?.user?.id) return null;
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, image: true, platformRole: true, disabledAt: true, sessionVersion: true },
  });
  if (!user || user.disabledAt) return null;
  if ((session.user.sessionVersion ?? 0) !== user.sessionVersion) return null;
  return user;
});

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getSessionUser>>>;

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    // A JWT that exists but was rejected (disabled/revoked) must be cleared,
    // or middleware would bounce /login back to /dashboard forever.
    const session = await auth();
    redirect(session?.user ? "/auth/revoked" : "/login");
  }
  return user;
}

export async function requireSuperAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.platformRole !== "SUPER_ADMIN") redirect("/dashboard");
  return user;
}

/** All workspaces the user belongs to (cross-tenant by nature → system read, filtered by userId). */
export const listMyWorkspaces = cache(async (userId: string) => {
  const rows = await systemDb.membership.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { role: true, workspace: { select: { id: true, name: true, slug: true, suspendedAt: true } } },
  });
  return rows.map((r) => ({ ...r.workspace, role: r.role }));
});

/**
 * Resolve the active workspace for this request: cookie → verified membership,
 * else the user's first workspace. No memberships → onboarding.
 */
export const getTenantContext = cache(async (): Promise<TenantContext & { user: SessionUser }> => {
  const user = await requireUser();
  const workspaces = await listMyWorkspaces(user.id);
  if (workspaces.length === 0) redirect("/onboarding");

  const wanted = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const active = workspaces.find((w) => w.id === wanted) ?? workspaces[0]!;

  if (active.suspendedAt && user.platformRole !== "SUPER_ADMIN") redirect("/suspended");

  return {
    user,
    userId: user.id,
    platformRole: user.platformRole,
    workspaceId: active.id,
    role: active.role,
    db: tenantDb(active.id),
  };
});

/** Tenant context that additionally requires a permission (throws ForbiddenError). */
export async function requireTenant(permission?: Permission) {
  const ctx = await getTenantContext();
  if (permission) assertCan(ctx, permission);
  return ctx;
}

export { ForbiddenError };
