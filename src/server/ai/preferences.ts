import type { GenerationType } from "@prisma/client";
import { z } from "zod";
import { withTenantTx } from "@/lib/db";
import { auditActor, recordAudit } from "@/server/services/audit";
import { assertCan } from "@/server/tenancy/guard";
import type { TenantContext } from "@/server/tenancy/types";
import { supports } from "./catalog";

/**
 * Per-workspace default provider + model for each content type, stored in
 * Workspace.aiPreferences. "AUTO" = first provider the platform has a key for.
 */

export const modelIdSchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^[A-Za-z0-9._:/@-]*$/, "Model ids contain only letters, numbers and . _ : / @ -");

const prefSchema = z.object({
  provider: z.enum(["AUTO", "MOCK", "ANTHROPIC", "OPENAI", "GOOGLE", "HUGGINGFACE"]).default("AUTO"),
  model: modelIdSchema.optional().transform((v) => v || undefined),
});
export type TypePreference = z.infer<typeof prefSchema>;
export type AiPreferences = Record<GenerationType, TypePreference>;

const TYPES: GenerationType[] = ["TEXT", "IMAGE", "VIDEO"];

export function parsePreferences(json: unknown): AiPreferences {
  const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  return Object.fromEntries(
    TYPES.map((t) => {
      const p = prefSchema.safeParse(obj[t] ?? {});
      const pref = p.success ? p.data : { provider: "AUTO" as const };
      // A provider that can't do this type (e.g. Anthropic video) degrades to AUTO.
      if (pref.provider !== "AUTO" && !supports(pref.provider, t)) return [t, { provider: "AUTO" as const }];
      return [t, pref];
    }),
  ) as AiPreferences;
}

export async function updatePreferences(ctx: TenantContext, input: Partial<Record<GenerationType, unknown>>) {
  assertCan(ctx, "settings.ai");
  const next = Object.fromEntries(
    TYPES.map((t) => {
      const pref = prefSchema.parse(input[t] ?? {});
      if (pref.provider !== "AUTO" && !supports(pref.provider, t)) throw new Error(`${pref.provider} can't generate ${t.toLowerCase()}`);
      return [t, pref];
    }),
  );
  await withTenantTx(ctx.workspaceId, async (tx) => {
    const before = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { aiPreferences: true } });
    await tx.workspace.update({ where: { id: ctx.workspaceId }, data: { aiPreferences: next } });
    await recordAudit({ action: "ai.preferences.update", ...auditActor(ctx), metadata: { before: before.aiPreferences ?? {}, after: next } }, tx);
  });
  return next as AiPreferences;
}
