import { GoogleGenAI } from "@google/genai";
import { ContentRefusedError, ProviderError, toProviderError } from "../errors";
import { VARIANTS_SCHEMA, aspectToSize, captionPrompt, imagePrompt, parseVariants } from "../prompts";
import type { CallContext, GenerationOptions, ImageGenerator, MediaResult, TextGenerator, TextResult, VideoGenerator } from "../types";

/** Google adapters (official @google/genai SDK): Gemini text, Imagen images, Veo video. */

export type GoogleClientFactory = (apiKey: string) => Pick<GoogleGenAI, "models" | "operations">;
const defaultFactory: GoogleClientFactory = (apiKey) => new GoogleGenAI({ apiKey });

/** Imagen/Veo accept a fixed set of aspect ratios. */
function googleAspect(aspect: string | undefined, allowed: string[]) {
  const a = aspect ?? "1:1";
  if (allowed.includes(a)) return a;
  return aspectToSize(a).orientation === "portrait" ? (allowed.includes("3:4") ? "3:4" : "9:16") : allowed[0]!;
}

export class GoogleTextGenerator implements TextGenerator {
  readonly provider = "GOOGLE" as const;
  readonly type = "TEXT" as const;
  constructor(private readonly makeClient: GoogleClientFactory = defaultFactory) {}

  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<TextResult> {
    const { system, user, n, maxChars } = captionPrompt(prompt, opts);
    try {
      const res = await this.makeClient(ctx.apiKey).models.generateContent({
        model: ctx.model,
        contents: user,
        config: { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: VARIANTS_SCHEMA, abortSignal: ctx.signal },
      });
      const blocked = res.promptFeedback?.blockReason ?? (res.candidates?.[0]?.finishReason === "SAFETY" ? "SAFETY" : undefined);
      if (blocked) throw new ContentRefusedError("GOOGLE", String(blocked));
      const variants = parseVariants(res.text ?? "", n, maxChars);
      if (!variants.length) throw new ProviderError("Gemini returned no usable text", "GOOGLE", { retryable: true, code: "empty" });
      return { kind: "text", variants };
    } catch (err) {
      throw toProviderError("GOOGLE", err);
    }
  }
}

export class GoogleImageGenerator implements ImageGenerator {
  readonly provider = "GOOGLE" as const;
  readonly type = "IMAGE" as const;
  constructor(private readonly makeClient: GoogleClientFactory = defaultFactory) {}

  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<MediaResult> {
    const aspectRatio = googleAspect(opts.aspectRatio, ["1:1", "3:4", "4:3", "9:16", "16:9"]);
    try {
      const res = await this.makeClient(ctx.apiKey).models.generateImages({
        model: ctx.model,
        prompt: imagePrompt(prompt),
        config: { numberOfImages: 1, aspectRatio, outputMimeType: "image/png", abortSignal: ctx.signal },
      });
      const img = res.generatedImages?.[0];
      if (!img?.image?.imageBytes) {
        if (img?.raiFilteredReason) throw new ContentRefusedError("GOOGLE", img.raiFilteredReason);
        throw new ProviderError("Imagen returned no image", "GOOGLE", { retryable: true, code: "empty" });
      }
      return { kind: "image", bytes: Buffer.from(img.image.imageBytes, "base64"), mimeType: img.image.mimeType ?? "image/png" };
    } catch (err) {
      throw toProviderError("GOOGLE", err);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GoogleVideoGenerator implements VideoGenerator {
  readonly provider = "GOOGLE" as const;
  readonly type = "VIDEO" as const;
  constructor(
    private readonly makeClient: GoogleClientFactory = defaultFactory,
    private readonly pollMs = 10_000,
    private readonly timeoutMs = 10 * 60_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<MediaResult> {
    const aspectRatio = googleAspect(opts.aspectRatio, ["16:9", "9:16"]);
    const client = this.makeClient(ctx.apiKey);
    try {
      let op = await client.models.generateVideos({
        model: ctx.model,
        prompt,
        config: { numberOfVideos: 1, aspectRatio, durationSeconds: Math.min(8, Math.max(5, opts.durationSec ?? 5)), abortSignal: ctx.signal },
      });
      const deadline = Date.now() + this.timeoutMs;
      while (!op.done) {
        if (Date.now() > deadline) throw new ProviderError("Veo generation timed out", "GOOGLE", { retryable: true, code: "timeout" });
        await sleep(this.pollMs);
        op = await client.operations.getVideosOperation({ operation: op });
      }
      if (op.error) throw new ProviderError(`Veo generation failed: ${JSON.stringify(op.error).slice(0, 200)}`, "GOOGLE", { retryable: false, code: "video_failed" });
      const video = op.response?.generatedVideos?.[0]?.video;
      if (!video) {
        if (op.response?.raiMediaFilteredCount) throw new ContentRefusedError("GOOGLE", "filtered");
        throw new ProviderError("Veo returned no video", "GOOGLE", { retryable: true, code: "empty" });
      }
      let bytes: Buffer;
      if (video.videoBytes) bytes = Buffer.from(video.videoBytes, "base64");
      else if (video.uri) {
        // Gemini API file URIs require the API key.
        const res = await this.fetchImpl(video.uri, { headers: { "x-goog-api-key": ctx.apiKey }, signal: ctx.signal });
        if (!res.ok) throw new ProviderError(`Veo download failed (${res.status})`, "GOOGLE", { retryable: res.status >= 500, status: res.status });
        bytes = Buffer.from(await res.arrayBuffer());
      } else throw new ProviderError("Veo returned no video data", "GOOGLE", { retryable: true, code: "empty" });
      return { kind: "video", bytes, mimeType: video.mimeType ?? "video/mp4" };
    } catch (err) {
      throw toProviderError("GOOGLE", err);
    }
  }
}
