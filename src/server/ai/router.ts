import type { AiProvider, GenerationType, Prisma } from "@prisma/client";
import { logger } from "@/lib/logger";
import { chargeGeneration, refundGeneration } from "@/server/billing/entitlements";
import { LimitExceededError } from "@/server/errors";
import { REAL_PROVIDERS, defaultModel, supports } from "./catalog";
import { getPlatformKey } from "./credentials";
import { ProviderError, toProviderError } from "./errors";
import { getGenerator } from "./registry";
import type { GenerationOptions, GenerationResult } from "./types";

/**
 * Provider router: decides WHICH provider/model/key serves a generation and in
 * what order to fall back. The UI and services never call a provider directly.
 *
 * Chain order:
 *   1. the requested provider (per-generation override) or the workspace default
 *   2. other providers the platform/workspace has keys for (fallbacks, default models)
 *   3. MOCK when nothing real is configured, when MOCK was chosen, or when
 *      AI_FALLBACK_TO_MOCK=true
 * Keys: the workspace's own key (BYOK, if the plan allows) wins over the platform key.
 * Credits: charged only when a PLATFORM key (or the mock) serves the request.
 */

export interface Candidate {
  provider: AiProvider;
  model: string;
  apiKey: string;
  byok: boolean;
}

export interface PlanInput {
  type: GenerationType;
  preferred: AiProvider | "AUTO";
  model?: string;
  byokKeys: Partial<Record<AiProvider, string>>;
  byokAllowed: boolean;
}

export async function planCandidates(input: PlanInput): Promise<Candidate[]> {
  const { type } = input;
  const keyFor = async (p: AiProvider): Promise<{ key: string; byok: boolean } | null> => {
    if (p === "MOCK") return { key: "mock", byok: false };
    const own = input.byokAllowed ? input.byokKeys[p] : undefined;
    if (own) return { key: own, byok: true };
    const platform = await getPlatformKey(p);
    return platform ? { key: platform.key, byok: false } : null;
  };

  const order: AiProvider[] = [];
  if (input.preferred !== "AUTO" && supports(input.preferred, type)) order.push(input.preferred);
  if (input.preferred !== "MOCK") for (const p of REAL_PROVIDERS) if (supports(p, type) && !order.includes(p)) order.push(p);

  const out: Candidate[] = [];
  for (const p of order) {
    const k = await keyFor(p);
    if (!k) continue;
    const model = p === order[0] && input.model ? input.model : defaultModel(p, type);
    out.push({ provider: p, model, apiKey: k.key, byok: k.byok });
  }
  const real = out.filter((c) => c.provider !== "MOCK");
  if (!out.some((c) => c.provider === "MOCK") && (real.length === 0 || process.env.AI_FALLBACK_TO_MOCK === "true")) {
    out.push({ provider: "MOCK", model: defaultModel("MOCK", type), apiKey: "mock", byok: false });
  }
  return out;
}

export interface Attempt {
  provider: AiProvider;
  model: string;
  byok: boolean;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface ChainResult {
  result: GenerationResult;
  served: Candidate;
  attempts: Attempt[];
  creditsCharged: number;
}

const TIMEOUTS: Record<GenerationType, number> = { TEXT: 90_000, IMAGE: 180_000, VIDEO: 20 * 60_000 };

/**
 * Try candidates in order. Retryable provider errors fall through to the next
 * candidate; refusals and invalid requests stop the chain. Credits are charged
 * once (idempotent per generation) before the first platform-key attempt and
 * refunded if the request fails or ends up served by a BYOK key.
 */
export async function runChain(args: {
  workspaceId: string;
  generationRequestId: string;
  type: GenerationType;
  prompt: string;
  options: GenerationOptions;
  candidates: Candidate[];
  creditCost: number;
}): Promise<ChainResult> {
  const attempts: Attempt[] = [];
  let charged = 0;
  let lastError: ProviderError | LimitExceededError | undefined;

  // Charging/refunding is idempotent per generation (net ledger sum), so job retries are safe.
  const refund = async (why: string) => {
    await refundGeneration(args.workspaceId, args.generationRequestId, why);
    charged = 0;
  };

  for (const c of args.candidates) {
    if (!c.byok && charged === 0 && args.creditCost > 0) {
      try {
        charged = (await chargeGeneration(args.workspaceId, args.generationRequestId, args.creditCost)).charged;
      } catch (err) {
        if (err instanceof LimitExceededError) {
          lastError = err;
          attempts.push({ provider: c.provider, model: c.model, byok: c.byok, ok: false, error: "insufficient credits", ms: 0 });
          continue; // a later BYOK candidate may still serve it
        }
        throw err;
      }
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUTS[args.type]);
    try {
      const gen = getGenerator(c.provider, args.type);
      const result = await gen.generate(args.prompt, args.options, { apiKey: c.apiKey, model: c.model, signal: controller.signal });
      attempts.push({ provider: c.provider, model: c.model, byok: c.byok, ok: true, ms: Date.now() - started });
      if (c.byok) await refund("served by workspace key");
      return { result, served: c, attempts, creditsCharged: charged };
    } catch (err) {
      const pe = toProviderError(c.provider, err);
      attempts.push({ provider: c.provider, model: c.model, byok: c.byok, ok: false, error: pe.message.slice(0, 300), ms: Date.now() - started });
      logger.warn({ provider: c.provider, model: c.model, code: pe.code, retryable: pe.retryable }, "generation attempt failed");
      lastError = pe;
      if (!pe.retryable) break;
    } finally {
      clearTimeout(timer);
    }
  }

  await refund("generation failed");
  const err = lastError ?? new ProviderError("No AI provider is available for this request", "MOCK", { retryable: false, code: "no_provider" });
  throw Object.assign(err, { attempts });
}

export type AttemptLog = Prisma.InputJsonValue;
