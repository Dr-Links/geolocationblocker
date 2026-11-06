import { describe, expect, it } from "vitest";
import { can, PERMISSIONS } from "@/server/tenancy/permissions";
import { assertCan } from "@/server/tenancy/guard";
import { ForbiddenError } from "@/server/errors";

describe("permission matrix", () => {
  it("WORKSPACE_ADMIN has every workspace permission", () => {
    for (const p of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) expect(can("WORKSPACE_ADMIN", p)).toBe(true);
  });

  it("MEMBER can create content but not manage members, billing, accounts or settings", () => {
    expect(can("MEMBER", "content.create")).toBe(true);
    expect(can("MEMBER", "content.publish")).toBe(true);
    for (const p of ["members.manage", "billing.manage", "accounts.manage", "workspace.update", "settings.ai"] as const) {
      expect(can("MEMBER", p)).toBe(false);
    }
  });

  it("assertCan throws ForbiddenError", () => {
    expect(() => assertCan({ role: "MEMBER" }, "billing.manage")).toThrow(ForbiddenError);
    expect(() => assertCan({ role: "WORKSPACE_ADMIN" }, "billing.manage")).not.toThrow();
  });
});
