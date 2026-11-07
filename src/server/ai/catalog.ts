import type { AiProvider, GenerationType } from "@prisma/client";

/**
 * Which provider supports which content type, default models, and the env var
 * holding the platform key. Models are free-form strings: workspaces may pick
 * any model id the provider accepts; these are just suggestions and defaults.
 */

export interface ProviderInfo {
  id: AiProvider;
  label: string;
  envKey?: string;
  /** Suggested models per supported type; the first is the default. */
  models: Partial<Record<GenerationType, string[]>>;
  /** Shown in the UI for capabilities that may need extra account access. */
  notes?: Partial<Record<GenerationType, string>>;
}

export const PROVIDERS: Record<AiProvider, ProviderInfo> = {
  MOCK: {
    id: "MOCK",
    label: "Mock (no API key)",
    models: { TEXT: ["mock-text"], IMAGE: ["mock-image"], VIDEO: ["mock-video"] },
  },
  ANTHROPIC: {
    id: "ANTHROPIC",
    label: "Anthropic (Claude)",
    envKey: "ANTHROPIC_API_KEY",
    models: { TEXT: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
  },
  OPENAI: {
    id: "OPENAI",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    models: { TEXT: ["gpt-5.5"], IMAGE: ["gpt-image-1", "gpt-image-1-mini"], VIDEO: ["sora-2", "sora-2-pro"] },
    notes: { VIDEO: "Sora access depends on your OpenAI organization." },
  },
  GOOGLE: {
    id: "GOOGLE",
    label: "Google (Gemini / Imagen / Veo)",
    envKey: "GOOGLE_AI_API_KEY",
    models: { TEXT: ["gemini-3.8-flash"], IMAGE: ["imagen-4.0-generate-001"], VIDEO: ["veo-2.0-generate-001"] },
    notes: { VIDEO: "Veo is a paid-tier Gemini API feature." },
  },
  HUGGINGFACE: {
    id: "HUGGINGFACE",
    label: "Hugging Face Inference",
    envKey: "HUGGINGFACE_API_TOKEN",
    models: {
      TEXT: ["meta-llama/Llama-3.3-70B-Instruct"],
      IMAGE: ["black-forest-labs/FLUX.1-schnell"],
      VIDEO: ["Wan-AI/Wan2.1-T2V-14B"],
    },
    notes: { VIDEO: "Experimental: availability depends on Inference Providers." },
  },
};

export const REAL_PROVIDERS: AiProvider[] = ["ANTHROPIC", "OPENAI", "GOOGLE", "HUGGINGFACE"];

export function supports(provider: AiProvider, type: GenerationType) {
  return !!PROVIDERS[provider].models[type]?.length;
}

export function defaultModel(provider: AiProvider, type: GenerationType): string {
  const m = PROVIDERS[provider].models[type]?.[0];
  if (!m) throw new Error(`${provider} does not support ${type}`);
  return m;
}

export function providersFor(type: GenerationType): AiProvider[] {
  return (Object.keys(PROVIDERS) as AiProvider[]).filter((p) => supports(p, type));
}

/** Default credit cost per generation type (admin can change in Admin → AI). */
export const DEFAULT_CREDIT_COSTS: Record<GenerationType, number> = { TEXT: 1, IMAGE: 5, VIDEO: 25 };
