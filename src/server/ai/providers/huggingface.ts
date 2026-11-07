import { InferenceClient } from "@huggingface/inference";
import { ProviderError, toProviderError } from "../errors";
import { aspectToSize, captionPrompt, imagePrompt, parseVariants } from "../prompts";
import type { CallContext, GenerationOptions, ImageGenerator, MediaResult, TextGenerator, TextResult, VideoGenerator } from "../types";

/**
 * Hugging Face Inference Providers (official @huggingface/inference SDK) for
 * open models. Model ids are Hub repo ids; the SDK routes to a provider.
 */

export type HfClientFactory = (token: string) => Pick<InferenceClient, "chatCompletion" | "textToImage" | "textToVideo">;
const defaultFactory: HfClientFactory = (token) => new InferenceClient(token);

export class HuggingFaceTextGenerator implements TextGenerator {
  readonly provider = "HUGGINGFACE" as const;
  readonly type = "TEXT" as const;
  constructor(private readonly makeClient: HfClientFactory = defaultFactory) {}

  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<TextResult> {
    const { system, user, n, maxChars } = captionPrompt(prompt, opts);
    try {
      const res = await this.makeClient(ctx.apiKey).chatCompletion(
        {
          model: ctx.model,
          max_tokens: 1500,
          messages: [
            { role: "system", content: `${system}\nRespond ONLY with JSON: {"variants": ["..."]}` },
            { role: "user", content: user },
          ],
        },
        { signal: ctx.signal },
      );
      const variants = parseVariants(String(res.choices?.[0]?.message?.content ?? ""), n, maxChars);
      if (!variants.length) throw new ProviderError("Hugging Face returned no usable text", "HUGGINGFACE", { retryable: true, code: "empty" });
      return { kind: "text", variants };
    } catch (err) {
      throw toProviderError("HUGGINGFACE", err);
    }
  }
}

export class HuggingFaceImageGenerator implements ImageGenerator {
  readonly provider = "HUGGINGFACE" as const;
  readonly type = "IMAGE" as const;
  constructor(private readonly makeClient: HfClientFactory = defaultFactory) {}

  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<MediaResult> {
    const { width, height } = aspectToSize(opts.aspectRatio, 1024);
    try {
      const blob = await this.makeClient(ctx.apiKey).textToImage(
        { model: ctx.model, inputs: imagePrompt(prompt), parameters: { width: Math.round(width / 8) * 8, height: Math.round(height / 8) * 8 } },
        { outputType: "blob", signal: ctx.signal },
      );
      return { kind: "image", bytes: Buffer.from(await blob.arrayBuffer()), mimeType: blob.type || "image/jpeg", width, height };
    } catch (err) {
      throw toProviderError("HUGGINGFACE", err);
    }
  }
}

export class HuggingFaceVideoGenerator implements VideoGenerator {
  readonly provider = "HUGGINGFACE" as const;
  readonly type = "VIDEO" as const;
  constructor(private readonly makeClient: HfClientFactory = defaultFactory) {}

  async generate(prompt: string, _opts: GenerationOptions, ctx: CallContext): Promise<MediaResult> {
    try {
      const blob = await this.makeClient(ctx.apiKey).textToVideo({ model: ctx.model, inputs: prompt }, { signal: ctx.signal });
      return { kind: "video", bytes: Buffer.from(await blob.arrayBuffer()), mimeType: blob.type || "video/mp4" };
    } catch (err) {
      throw toProviderError("HUGGINGFACE", err);
    }
  }
}
