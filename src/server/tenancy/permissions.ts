import type { WorkspaceRole } from "@prisma/client";

/**
 * Workspace-level permission matrix. SUPER_ADMIN is handled separately
 * (platform scope); it does not implicitly grant workspace permissions
 * except through explicit impersonation (Phase 6).
 */
export const PERMISSIONS = {
  "workspace.view": ["WORKSPACE_ADMIN", "MEMBER"],
  "workspace.update": ["WORKSPACE_ADMIN"],
  "members.view": ["WORKSPACE_ADMIN", "MEMBER"],
  "members.manage": ["WORKSPACE_ADMIN"],
  "billing.manage": ["WORKSPACE_ADMIN"],
  "accounts.manage": ["WORKSPACE_ADMIN"],
  "settings.ai": ["WORKSPACE_ADMIN"],
  "content.create": ["WORKSPACE_ADMIN", "MEMBER"],
  "content.publish": ["WORKSPACE_ADMIN", "MEMBER"],
} as const satisfies Record<string, readonly WorkspaceRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: WorkspaceRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly WorkspaceRole[]).includes(role);
}
