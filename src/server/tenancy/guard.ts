import { ForbiddenError } from "@/server/errors";
import { can, type Permission } from "./permissions";
import type { TenantContext } from "./types";

/**
 * Permissions a SUPER_ADMIN may NOT exercise while impersonating a workspace:
 * spending the customer's money and handling the customer's own API keys.
 */
export const BLOCKED_WHILE_IMPERSONATING: Permission[] = ["billing.manage", "settings.ai"];

export function assertCan(ctx: Pick<TenantContext, "role"> & { impersonatorId?: string | null }, permission: Permission) {
  if (ctx.impersonatorId && BLOCKED_WHILE_IMPERSONATING.includes(permission)) {
    throw new ForbiddenError("Not allowed while impersonating. Ask a workspace admin to do this.");
  }
  if (!can(ctx.role, permission)) throw new ForbiddenError();
}
