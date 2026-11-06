import { z } from "zod";
import { emailSchema } from "./auth";

const timezones = new Set(Intl.supportedValuesOf("timeZone").concat("UTC"));

export const timezoneSchema = z.string().refine((tz) => timezones.has(tz), "Choose a valid timezone");

export const workspaceNameSchema = z.string().trim().min(2, "Workspace name is required").max(80);

export const createWorkspaceSchema = z.object({
  name: workspaceNameSchema,
  timezone: timezoneSchema.default("UTC"),
});

export const updateWorkspaceSchema = z.object({
  name: workspaceNameSchema,
  timezone: timezoneSchema,
});

export const workspaceRoleSchema = z.enum(["WORKSPACE_ADMIN", "MEMBER"]);

export const inviteSchema = z.object({
  email: emailSchema,
  role: workspaceRoleSchema.default("MEMBER"),
});

export const idSchema = z.string().min(8).max(64).regex(/^[a-z0-9_-]+$/i, "Invalid id");
