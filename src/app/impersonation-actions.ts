"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { stopImpersonation } from "@/server/admin/management";
import { readImpersonation } from "@/server/tenancy/impersonation";
import { requireSuperAdmin } from "@/server/tenancy/context";

export async function stopImpersonationAction() {
  const admin = await requireSuperAdmin();
  const imp = await readImpersonation(admin.id);
  await stopImpersonation(admin.id, imp?.w ?? null);
  revalidatePath("/", "layout");
  redirect(imp ? `/admin/workspaces/${imp.w}` : "/admin");
}
