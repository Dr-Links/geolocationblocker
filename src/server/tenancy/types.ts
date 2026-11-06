import type { PlatformRole, WorkspaceRole } from "@prisma/client";
import type { TenantDb } from "@/lib/db";

/** Everything a request needs to act inside one workspace. Built only by getTenantContext(). */
export interface TenantContext {
  userId: string;
  platformRole: PlatformRole;
  workspaceId: string;
  role: WorkspaceRole;
  db: TenantDb;
}
