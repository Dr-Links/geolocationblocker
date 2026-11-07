import type { SocialPlatform } from "@prisma/client";

/** Per-platform content rules (used for AI prompts now, previews/validation in Phases 4-5). */
export interface PlatformRules {
  label: string;
  maxChars: number;
  recommendedHashtags: [number, number];
  aspectRatios: string[];
  maxVideoSec: number;
}

export const PLATFORM_RULES: Record<SocialPlatform, PlatformRules> = {
  X: { label: "X", maxChars: 280, recommendedHashtags: [0, 2], aspectRatios: ["16:9", "1:1"], maxVideoSec: 140 },
  INSTAGRAM: { label: "Instagram", maxChars: 2200, recommendedHashtags: [3, 10], aspectRatios: ["1:1", "4:5", "9:16"], maxVideoSec: 90 },
  FACEBOOK: { label: "Facebook", maxChars: 63206, recommendedHashtags: [0, 3], aspectRatios: ["1:1", "4:5", "16:9"], maxVideoSec: 240 },
  LINKEDIN: { label: "LinkedIn", maxChars: 3000, recommendedHashtags: [1, 5], aspectRatios: ["1:1", "16:9"], maxVideoSec: 600 },
  TIKTOK: { label: "TikTok", maxChars: 2200, recommendedHashtags: [2, 6], aspectRatios: ["9:16"], maxVideoSec: 180 },
  YOUTUBE: { label: "YouTube", maxChars: 5000, recommendedHashtags: [0, 3], aspectRatios: ["16:9", "9:16"], maxVideoSec: 60 },
};

export const PLATFORM_KEYS = Object.keys(PLATFORM_RULES) as SocialPlatform[];

export function isPlatform(v: string | undefined | null): v is SocialPlatform {
  return !!v && v in PLATFORM_RULES;
}
