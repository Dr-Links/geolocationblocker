import type { AiProvider, GenerationType } from "@prisma/client";
import { AnthropicTextGenerator } from "./providers/anthropic";
import { GoogleImageGenerator, GoogleTextGenerator, GoogleVideoGenerator } from "./providers/google";
import { HuggingFaceImageGenerator, HuggingFaceTextGenerator, HuggingFaceVideoGenerator } from "./providers/huggingface";
import { MockImageGenerator, MockTextGenerator, MockVideoGenerator } from "./providers/mock";
import { OpenAIImageGenerator, OpenAITextGenerator, OpenAIVideoGenerator } from "./providers/openai";
import type { AnyGenerator } from "./types";

type Registry = Partial<Record<AiProvider, Partial<Record<GenerationType, AnyGenerator>>>>;

function build(): Registry {
  return {
    MOCK: { TEXT: new MockTextGenerator(), IMAGE: new MockImageGenerator(), VIDEO: new MockVideoGenerator() },
    ANTHROPIC: { TEXT: new AnthropicTextGenerator() },
    OPENAI: { TEXT: new OpenAITextGenerator(), IMAGE: new OpenAIImageGenerator(), VIDEO: new OpenAIVideoGenerator() },
    GOOGLE: { TEXT: new GoogleTextGenerator(), IMAGE: new GoogleImageGenerator(), VIDEO: new GoogleVideoGenerator() },
    HUGGINGFACE: { TEXT: new HuggingFaceTextGenerator(), IMAGE: new HuggingFaceImageGenerator(), VIDEO: new HuggingFaceVideoGenerator() },
  };
}

let registry: Registry = build();

export function getGenerator(provider: AiProvider, type: GenerationType): AnyGenerator {
  const g = registry[provider]?.[type];
  if (!g) throw new Error(`No ${type} generator for ${provider}`);
  return g;
}

/** Test-only: replace generators (e.g. a fake real provider). */
export function overrideGenerator(provider: AiProvider, type: GenerationType, gen: AnyGenerator | undefined) {
  registry = { ...registry, [provider]: { ...registry[provider], [type]: gen } };
  if (!gen) registry = build();
}
