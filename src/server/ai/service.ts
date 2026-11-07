import { randomBytes } from "node:crypto";
import type { GenerationType, Prisma } from "@prisma/client";
import { z } from "zod";
import { systemDb, withTenantTx } from "@/lib/db";
import { logger } from "@/lib/logger";
import { QUEUES, getQueue } from "@/lib/queues";
import { creditsRemaining, getEntitlements, getUsage } from "@/server/billing/entitlements";
import { ConflictError, LimitExceededError, NotFoundError } from "@/server/errors";
import { enforceRateLimit, envLimit } from "@/server/rate-limit";
import { getStorage, mediaKey } from "@/server/storage";
import { getCreditCosts } from "@/server/settings";
import { assertCan } from "@/server/tenancy/guard";
import type { TenantContext } from "@/server/tenancy/types";
import { PROVIDERS, supports } from "./catalog";
import { getWorkspaceKeys } from "./credentials";
import { ContentRefusedError, ProviderError } from "./errors";
import { modelIdSchema, parsePreferences } from "./preferences";
import { planCandidates, runChain, type Attempt, type Candidate } from "./router";
import { ASPECT_RATIOS, type GenerationOptions, type MediaResult } from "./types";

/**
 * GenerationService — the single entry point the app uses for AI generation.
 *   requestGeneration(): validate, gate (plan/credits/rate limit), record, enqueue  [web]
 *   processGeneration(): route to a provider, store output, settle credits         [worker]
 */

export const generationInputSchema = z.object({
  type: z.enum(["TEXT", "IMAGE", "VIDEO"]),
  prompt: z
    .string()
    .transform((s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim())
    .pipe(z.string().min(3, "Describe what you want (at least 3 characters)").max(4000, "Keep the prompt under 4000 characters")),
  provider: z.enum(["AUTO", "MOCK", "ANTHROPIC", "OPENAI", "GOOGLE", "HUGGINGFACE"]).optional(),
  model: modelIdSchema.optional().transform((v) => v || undefined),
  options: z
    .object({
      tone: z.string().trim().max(40).optional(),
      platform: z.string().trim().max(20).optional(),
      variants: z.coerce.number().int().min(1).max(3).optional(),
      aspectRatio: z.enum(ASPECT_RATIOS).optional(),
      durationSec: z.coerce.number().int().min(2).max(20).optional(),
    })
    .default({}),
});
export type GenerationInput = z.input<typeof generationInputSchema>;

async function planFor(workspaceId: string, type: GenerationType, provider: string | undefined, model: string | undefined) {
  return withTenantTx(workspaceId, async (tx) => {
    const [ws, ent, byokKeys] = await Promise.all([
      tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { aiPreferences: true } }),
      getEntitlements(tx, workspaceId),
      getWorkspaceKeys(tx, workspaceId),
    ]);
    const pref = parsePreferences(ws.aiPreferences)[type];
    const preferred = (provider && provider !== "AUTO" ? provider : pref.provider) as Candidate["provider"] | "AUTO";
    if (preferred !== "AUTO" && !supports(preferred, type)) throw new ConflictError(`${PROVIDERS[preferred].label} can't generate ${type.toLowerCase()}`);
    const candidates = await planCandidates({
      type,
      preferred,
      model: provider && provider !== "AUTO" ? model : (model ?? pref.model),
      byokKeys,
      byokAllowed: ent.features.byok,
    });
    const usage = await getUsage(tx, workspaceId, ent);
    return { candidates, ent, creditsLeft: creditsRemaining(ent, usage) };
  });
}

export async function requestGeneration(ctx: TenantContext, input: GenerationInput) {
  assertCan(ctx, "content.create");
  const data = generationInputSchema.parse(input);
  await enforceRateLimit(`gen:ws:${ctx.workspaceId}`, envLimit("RATE_LIMIT_GENERATIONS_PER_MIN", 20), 60);

  const { candidates, ent, creditsLeft } = await planFor(ctx.workspaceId, data.type, data.provider, data.model);
  if (data.type === "VIDEO" && !ent.features.video) {
    throw new LimitExceededError("AI video generation isn't included in your plan. Upgrade to use it.", "video");
  }
  if (data.provider && data.provider !== "AUTO" && candidates[0]?.provider !== data.provider) {
    throw new ConflictError(`${PROVIDERS[data.provider].label} isn't available right now (no API key configured).`);
  }
  const first = candidates[0];
  if (!first) throw new ConflictError("No AI provider is available for this content type.");

  const cost = (await getCreditCosts())[data.type];
  // Fail fast in the UI; the worker re-checks atomically when it charges.
  if (!first.byok && cost > creditsLeft && !candidates.some((c) => c.byok)) {
    throw new LimitExceededError(`Not enough AI credits: ${creditsLeft} left this period, ${cost} needed. Upgrade or add your own API key.`, "monthlyCredits");
  }

  const request = await ctx.db.generationRequest.create({
    data: {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      type: data.type,
      prompt: data.prompt,
      provider: first.provider,
      model: first.model,
      options: { ...data.options, requestedProvider: data.provider ?? "AUTO", requestedModel: data.model ?? null } as Prisma.InputJsonValue,
      status: "QUEUED",
    },
  });

  await enqueueGeneration(request.id);
  return request;
}

export async function enqueueGeneration(id: string) {
  await getQueue(QUEUES.generation).add(
    "generate",
    { id },
    { jobId: id, attempts: 3, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
  );
}

/** User-safe error text (never leak keys/stack traces). */
function publicError(err: unknown): string {
  if (err instanceof ContentRefusedError || err instanceof LimitExceededError) return err.message;
  if (err instanceof ProviderError) return err.code === "no_provider" ? err.message : "The AI provider couldn't complete this request. Please try again.";
  return "Generation failed unexpectedly. Please try again.";
}

/**
 * Worker entry point. Idempotent: finished requests are skipped, and credit
 * charges are net-per-generation, so BullMQ retries can't double charge.
 * Throws only for infrastructure errors (DB/storage), so BullMQ retries those.
 */
export async function processGeneration(id: string) {
  const req = await systemDb.generationRequest.findUnique({ where: { id } });
  if (!req) throw new NotFoundError(`GenerationRequest ${id} not found`);
  if (req.status === "SUCCEEDED" || req.status === "FAILED") return req;

  await systemDb.generationRequest.update({ where: { id }, data: { status: "RUNNING", startedAt: new Date() } });
  const opts = (req.options ?? {}) as GenerationOptions & { requestedProvider?: string; requestedModel?: string | null };
  const cost = (await getCreditCosts())[req.type];

  let chain;
  try {
    const { candidates } = await planFor(req.workspaceId, req.type, opts.requestedProvider, opts.requestedModel ?? undefined);
    chain = await runChain({ workspaceId: req.workspaceId, generationRequestId: id, type: req.type, prompt: req.prompt, options: opts, candidates, creditCost: cost });
  } catch (err) {
    const attempts = ((err as { attempts?: Attempt[] }).attempts ?? []) as unknown as Prisma.InputJsonValue;
    logger.warn({ generationId: id, err: (err as Error).message }, "generation failed");
    return systemDb.generationRequest.update({
      where: { id },
      data: { status: "FAILED", error: publicError(err), attemptLog: attempts, completedAt: new Date(), creditsCharged: 0 },
    });
  }

  const { result, served, attempts, creditsCharged } = chain;
  const first = attempts[0];
  let output: Prisma.InputJsonValue;
  try {
    if (result.kind === "text") {
      output = { variants: result.variants };
    } else {
      const asset = await storeMedia(req.workspaceId, req.userId, id, result);
      output = { mediaAssetId: asset.id, mimeType: asset.mimeType, width: asset.width, height: asset.height, durationMs: asset.durationMs };
    }
  } catch (err) {
    // Storage failed after a successful generation: keep the charge state as-is and let BullMQ retry.
    await systemDb.generationRequest.update({ where: { id }, data: { status: "QUEUED" } });
    throw err;
  }

  const done = await systemDb.generationRequest.update({
    where: { id },
    data: {
      status: "SUCCEEDED",
      provider: served.provider,
      model: served.model,
      usedByok: served.byok,
      fallbackFrom: first && first.provider !== served.provider ? first.provider : null,
      creditsCharged,
      output,
      attemptLog: attempts as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });
  logger.info({ generationId: id, provider: served.provider, model: served.model, byok: served.byok, creditsCharged }, "generation succeeded");
  return done;
}

async function storeMedia(workspaceId: string, userId: string | null, generationRequestId: string, media: MediaResult) {
  const id = `ma_${randomBytes(10).toString("hex")}`;
  const key = mediaKey(workspaceId, id, media.mimeType);
  await getStorage().put(key, media.bytes, media.mimeType);
  return withTenantTx(workspaceId, (tx) =>
    tx.mediaAsset.create({
      data: {
        id,
        workspaceId,
        createdById: userId,
        kind: media.kind === "image" ? "IMAGE" : "VIDEO",
        source: "GENERATED",
        storageKey: key,
        mimeType: media.mimeType,
        sizeBytes: media.bytes.length,
        width: media.width,
        height: media.height,
        durationMs: media.durationMs,
        generationRequestId,
      },
    }),
  );
}

export async function getGeneration(ctx: TenantContext, id: string) {
  const g = await ctx.db.generationRequest.findUnique({ where: { id } });
  if (!g) throw new NotFoundError("Generation not found");
  return g;
}

export async function listRecentGenerations(ctx: TenantContext, take = 12) {
  return ctx.db.generationRequest.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: "desc" }, take });
}

/** Client-facing projection (no prompt internals beyond what the user typed). */
export function toPublicGeneration(g: Awaited<ReturnType<typeof getGeneration>>) {
  return {
    id: g.id,
    type: g.type,
    status: g.status,
    prompt: g.prompt,
    provider: g.provider,
    model: g.model,
    usedByok: g.usedByok,
    fallbackFrom: g.fallbackFrom,
    creditsCharged: g.creditsCharged,
    error: g.error,
    output: g.output as { variants?: string[]; mediaAssetId?: string; mimeType?: string } | null,
    createdAt: g.createdAt.toISOString(),
  };
}
export type PublicGeneration = ReturnType<typeof toPublicGeneration>;

/** What the composer can offer this workspace: providers with a usable key (plus the mock). */
export async function getComposerOptions(ctx: TenantContext) {
  const types: GenerationType[] = ["TEXT", "IMAGE", "VIDEO"];
  const result = await withTenantTx(ctx.workspaceId, async (tx) => {
    const [ws, ent, byokKeys] = await Promise.all([
      tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { aiPreferences: true } }),
      getEntitlements(tx, ctx.workspaceId),
      getWorkspaceKeys(tx, ctx.workspaceId),
    ]);
    const usage = await getUsage(tx, ctx.workspaceId, ent);
    return { prefs: parsePreferences(ws.aiPreferences), ent, byokKeys, creditsLeft: creditsRemaining(ent, usage) };
  });
  const costs = await getCreditCosts();
  const perType = await Promise.all(
    types.map(async (type) => {
      const cands = await planCandidates({ type, preferred: "AUTO", byokKeys: result.byokKeys, byokAllowed: result.ent.features.byok });
      const providers = cands.map((c) => ({ provider: c.provider, label: PROVIDERS[c.provider].label, byok: c.byok, models: PROVIDERS[c.provider].models[type] ?? [] }));
      if (!providers.some((p) => p.provider === "MOCK")) providers.push({ provider: "MOCK", label: PROVIDERS.MOCK.label, byok: false, models: ["mock"] });
      return [type, { providers, cost: costs[type], preference: result.prefs[type], allowed: type !== "VIDEO" || result.ent.features.video }] as const;
    }),
  );
  return {
    types: Object.fromEntries(perType) as Record<GenerationType, { providers: { provider: string; label: string; byok: boolean; models: string[] }[]; cost: number; preference: { provider: string; model?: string }; allowed: boolean }>,
    creditsLeft: Number.isFinite(result.creditsLeft) ? result.creditsLeft : null,
  };
}
