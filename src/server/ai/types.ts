import type { AiProvider, GenerationType } from "@prisma/client";

/**
 * Provider-agnostic generation contracts. The app only ever talks to
 * GenerationService → router → these interfaces; each provider's SDK quirks
 * stay inside its adapter file.
 */

export type { AiProvider, GenerationType };

export const ASPECT_RATIOS = ["1:1", "4:5", "9:16", "16:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export interface GenerationOptions {
  /** Per-generation override of the workspace's default model. */
  model?: string;
  /** TEXT: voice of the copy, e.g. "friendly", "professional". */
  tone?: string;
  /** TEXT: platform to write for, e.g. "X", "INSTAGRAM"; shapes length and hashtags. */
  platform?: string;
  /** TEXT: number of alternative captions to return (1-3). */
  variants?: number;
  /** IMAGE/VIDEO. */
  aspectRatio?: AspectRatio;
  /** VIDEO: requested length in seconds. */
  durationSec?: number;
}

export interface CallContext {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}

export interface TextResult {
  kind: "text";
  variants: string[];
}

export interface MediaResult {
  kind: "image" | "video";
  bytes: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface TextGenerator {
  readonly provider: AiProvider;
  readonly type: "TEXT";
  generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<TextResult>;
}

export interface ImageGenerator {
  readonly provider: AiProvider;
  readonly type: "IMAGE";
  generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<MediaResult>;
}

export interface VideoGenerator {
  readonly provider: AiProvider;
  readonly type: "VIDEO";
  generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<MediaResult>;
}

export type AnyGenerator = TextGenerator | ImageGenerator | VideoGenerator;
export type GenerationResult = TextResult | MediaResult;
