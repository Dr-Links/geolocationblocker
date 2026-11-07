import Anthropic from "@anthropic-ai/sdk";
import { ContentRefusedError, ProviderError, toProviderError } from "../errors";
import { VARIANTS_SCHEMA, captionPrompt, parseVariants } from "../prompts";
import type { CallContext, GenerationOptions, TextGenerator, TextResult } from "../types";

/**
 * Claude caption writer (official SDK). Uses structured output so variants come
 * back as validated JSON, and server-side refusal fallbacks on models that
 * support them (the request is re-run on a fallback model inside the same call).
 */

// Models that accept `fallbacks: "default"` (Claude API). Others are sent without it.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export type AnthropicClientFactory = (apiKey: string) => Pick<Anthropic, "beta">;
const defaultFactory: AnthropicClientFactory = (apiKey) => new Anthropic({ apiKey, maxRetries: 1, timeout: 90_000 });

export class AnthropicTextGenerator implements TextGenerator {
  readonly provider = "ANTHROPIC" as const;
  readonly type = "TEXT" as const;
  constructor(private readonly makeClient: AnthropicClientFactory = defaultFactory) {}

  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<TextResult> {
    const { system, user, n, maxChars } = captionPrompt(prompt, opts);
    const client = this.makeClient(ctx.apiKey);
    const withFallbacks = FALLBACK_MODELS.has(ctx.model);
    try {
      const res = await client.beta.messages.create(
        {
          model: ctx.model,
          max_tokens: 4000,
          system,
          messages: [{ role: "user", content: user }],
          // Captions are a light task: low effort keeps latency and cost down.
          output_config: { effort: "low", format: { type: "json_schema", schema: VARIANTS_SCHEMA } },
          ...(withFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: ctx.signal },
      );
      if (res.stop_reason === "refusal") {
        const details = (res as { stop_details?: { category?: string | null } }).stop_details;
        throw new ContentRefusedError("ANTHROPIC", details?.category ?? undefined);
      }
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const variants = parseVariants(text, n, maxChars);
      if (!variants.length) {
        throw new ProviderError(`Claude returned no usable text (stop_reason: ${res.stop_reason})`, "ANTHROPIC", { retryable: true, code: "empty" });
      }
      return { kind: "text", variants };
    } catch (err) {
      throw toProviderError("ANTHROPIC", err);
    }
  }
}
