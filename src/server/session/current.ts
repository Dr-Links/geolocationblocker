import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";

/**
 * Resolves the signed-in user and their active workspace.
 * Phase 0: first membership. Phase 1 adds workspace switching + a tenant-scoped DB client.
 */
export async function requireUserContext() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, platformRole: true, disabledAt: true },
  });
  if (!user || user.disabledAt) redirect("/login");

  const membership = await db.membership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    include: { workspace: { include: { subscription: { include: { plan: true } } } } },
  });

  return { user, membership, workspace: membership?.workspace ?? null };
}
