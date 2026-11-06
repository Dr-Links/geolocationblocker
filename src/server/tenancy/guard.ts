import { ForbiddenError } from "@/server/errors";
import { can, type Permission } from "./permissions";
import type { TenantContext } from "./types";

export function assertCan(ctx: Pick<TenantContext, "role">, permission: Permission) {
  if (!can(ctx.role, permission)) throw new ForbiddenError();
}
