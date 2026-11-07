import { PLATFORM_RULES, isPlatform } from "@/lib/platforms";
import type { GenerationOptions } from "./types";

/** Shared caption prompt so every text provider gets identical instructions. */
export function captionPrompt(brief: string, opts: GenerationOptions) {
  const n = clampVariants(opts.variants);
  const rules = isPlatform(opts.platform) ? PLATFORM_RULES[opts.platform] : null;
  const system = [
    "You write social media post copy for brands and creators.",
    "Write copy that is ready to publish: no preamble, no explanations, no quotation marks around the post.",
    rules
      ? `The post is for ${rules.label}. Stay under ${Math.min(rules.maxChars, 2000)} characters and use ${rules.recommendedHashtags[0]}-${rules.recommendedHashtags[1]} relevant hashtags.`
      : "Keep it concise (under 280 characters works everywhere) and add 1-3 relevant hashtags.",
    opts.tone ? `Tone: ${opts.tone}.` : "",
    `Return ${n} distinct option${n === 1 ? "" : "s"}.`,
  ]
    .filter(Boolean)
    .join("\n");
  const user = `Brief:\n${brief}`;
  return { system, user, n, maxChars: rules?.maxChars ?? 2200 };
}

export function clampVariants(v: number | undefined) {
  return Math.min(3, Math.max(1, Math.floor(v ?? 1)));
}

/** JSON schema shared by providers that support structured output. */
export const VARIANTS_SCHEMA = {
  type: "object",
  properties: { variants: { type: "array", items: { type: "string" } } },
  required: ["variants"],
  additionalProperties: false,
} as const;

/** Parse `{ "variants": [...] }` (or fall back to plain text), enforce count and length. */
export function parseVariants(raw: string, n: number, maxChars: number): string[] {
  let list: string[] = [];
  const trimmed = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const parsed = JSON.parse(trimmed) as { variants?: unknown };
    if (Array.isArray(parsed.variants)) list = parsed.variants.filter((v): v is string => typeof v === "string");
  } catch {
    list = trimmed ? [trimmed] : [];
  }
  return list
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, n)
    .map((v) => (v.length > maxChars ? `${v.slice(0, maxChars - 1).trimEnd()}…` : v));
}

export function imagePrompt(prompt: string) {
  return `${prompt.trim()}\n\nHigh quality image suitable for a social media post. No text, watermarks or logos unless explicitly requested.`;
}

export function aspectToSize(aspect: string | undefined, base = 1080) {
  switch (aspect) {
    case "9:16":
      return { width: Math.round((base * 9) / 16), height: base, orientation: "portrait" as const };
    case "16:9":
      return { width: base, height: Math.round((base * 9) / 16), orientation: "landscape" as const };
    case "4:5":
      return { width: Math.round((base * 4) / 5), height: base, orientation: "portrait" as const };
    default:
      return { width: base, height: base, orientation: "square" as const };
  }
}
