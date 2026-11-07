import OpenAI from "openai";
import { ContentRefusedError, ProviderError, toProviderError } from "../errors";
import { VARIANTS_SCHEMA, aspectToSize, captionPrompt, imagePrompt, parseVariants } from "../prompts";
import type { CallContext, GenerationOptions, ImageGenerator, MediaResult, TextGenerator, TextResult, VideoGenerator } from "../types";

/** OpenAI adapters (official SDK): Responses API for text, Images API, Videos API (Sora). */

export type OpenAIClientFactory = (apiKey: string) => Pick<OpenAI, "responses" | "images" | "videos">;
const defaultFactory: OpenAIClientFactory = (apiKey) => new OpenAI({ apiKey, maxRetries: 1, timeout: 120_000 });

const isPolicyError = (err: unknown) => {
  const e = err as { status?: number; code?: string };
  return e?.status === 400 && (e.code === "content_policy_violation" || e.code === "moderation_blocked");
};

export class OpenAITextGenerator implements TextGenerator {
  readonly provider = "OPENAI" as const;
  readonly type = "TEXT" as const;
  constructor(private readonly makeClient: OpenAIClientFactory = defaultFactory) {}

  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<TextResult> {
    const { system, user, n, maxChars } = captionPrompt(prompt, opts);
    try {
      const res = await this.makeClient(ctx.apiKey).responses.create(
        {
          model: ctx.model,
          instructions: system,
          input: user,
          text: { format: { type: "json_schema", name: "captions", schema: VARIANTS_SCHEMA as unknown as Record<string, unknown>, strict: true } },
        },
        { signal: ctx.signal },
      );
      const variants = parseVariants(res.output_text ?? "", n, maxChars);
      if (!variants.length) throw new ProviderError("OpenAI returned no usable text", "OPENAI", { retryable: true, code: "empty" });
      return { kind: "text", variants };
    } catch (err) {
      if (isPolicyError(err)) throw new ContentRefusedError("OPENAI");
      throw toProviderError("OPENAI", err);
    }
  }
}

function openAiImageSize(aspect: string | undefined): "1024x1024" | "1024x1536" | "1536x1024" {
  const { orientation } = aspectToSize(aspect);
  return orientation === "portrait" ? "1024x1536" : orientation === "landscape" ? "1536x1024" : "1024x1024";
}

export class OpenAIImageGenerator implements ImageGenerator {
  readonly provider = "OPENAI" as const;
  readonly type = "IMAGE" as const;
  constructor(private readonly makeClient: OpenAIClientFactory = defaultFactory) {}

  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<MediaResult> {
    const size = openAiImageSize(opts.aspectRatio);
    try {
      const res = await this.makeClient(ctx.apiKey).images.generate(
        { model: ctx.model, prompt: imagePrompt(prompt), size, n: 1 },
        { signal: ctx.signal },
      );
      const b64 = res.data?.[0]?.b64_json;
      if (!b64) throw new ProviderError("OpenAI returned no image data", "OPENAI", { retryable: true, code: "empty" });
      const [w, h] = size.split("x").map(Number);
      return { kind: "image", bytes: Buffer.from(b64, "base64"), mimeType: "image/png", width: w, height: h };
    } catch (err) {
      if (isPolicyError(err)) throw new ContentRefusedError("OPENAI");
      throw toProviderError("OPENAI", err);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAIVideoGenerator implements VideoGenerator {
  readonly provider = "OPENAI" as const;
  readonly type = "VIDEO" as const;
  constructor(
    private readonly makeClient: OpenAIClientFactory = defaultFactory,
    private readonly pollMs = 5_000,
    private readonly timeoutMs = 10 * 60_000,
  ) {}

  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<MediaResult> {
    const vertical = aspectToSize(opts.aspectRatio).orientation === "portrait";
    const seconds = (opts.durationSec ?? 4) >= 10 ? "12" : (opts.durationSec ?? 4) >= 6 ? "8" : "4";
    const client = this.makeClient(ctx.apiKey);
    try {
      let video = await client.videos.create(
        { model: ctx.model, prompt, seconds, size: vertical ? "720x1280" : "1280x720" },
        { signal: ctx.signal },
      );
      const deadline = Date.now() + this.timeoutMs;
      while (video.status === "queued" || video.status === "in_progress") {
        if (Date.now() > deadline) throw new ProviderError("Sora generation timed out", "OPENAI", { retryable: true, code: "timeout" });
        if (ctx.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        await sleep(this.pollMs);
        video = await client.videos.retrieve(video.id);
      }
      if (video.status !== "completed") {
        const msg = (video as { error?: { message?: string } }).error?.message ?? video.status;
        throw new ProviderError(`Sora generation failed: ${msg}`, "OPENAI", { retryable: false, code: "video_failed" });
      }
      const content = await client.videos.downloadContent(video.id);
      const bytes = Buffer.from(await content.arrayBuffer());
      return { kind: "video", bytes, mimeType: "video/mp4", width: vertical ? 720 : 1280, height: vertical ? 1280 : 720, durationMs: Number(seconds) * 1000 };
    } catch (err) {
      if (isPolicyError(err)) throw new ContentRefusedError("OPENAI");
      throw toProviderError("OPENAI", err);
    }
  }
}
