import { z } from "zod";
import type { GenerationType } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { recordAudit } from "@/server/services/audit";
import { DEFAULT_CREDIT_COSTS } from "@/server/ai/catalog";

/** Admin-editable platform settings (global, not tenant data). */

const creditCostsSchema = z.object({
  TEXT: z.coerce.number().int().min(0).max(100_000),
  IMAGE: z.coerce.number().int().min(0).max(100_000),
  VIDEO: z.coerce.number().int().min(0).max(100_000),
});
export type CreditCosts = Record<GenerationType, number>;

const KEY = "ai.creditCosts";

export async function getCreditCosts(): Promise<CreditCosts> {
  const row = await systemDb.platformSetting.findUnique({ where: { key: KEY } });
  const parsed = creditCostsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : { ...DEFAULT_CREDIT_COSTS };
}

export async function setCreditCosts(adminId: string, input: unknown) {
  const value = creditCostsSchema.parse(input);
  const before = await getCreditCosts();
  await systemDb.platformSetting.upsert({ where: { key: KEY }, update: { value, updatedById: adminId }, create: { key: KEY, value, updatedById: adminId } });
  await recordAudit({ action: "admin.settings.credit_costs", actorId: adminId, metadata: { before, after: value } });
  return value;
}
