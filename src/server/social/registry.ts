import type { SocialPlatform } from "@prisma/client";
import { LinkedInPublisher } from "./publishers/linkedin";
import { MetaPublisher } from "./publishers/meta";
import { MockPublisher } from "./publishers/mock";
import { TikTokPublisher } from "./publishers/tiktok";
import { XPublisher } from "./publishers/x";
import { YouTubePublisher } from "./publishers/youtube";
import type { SocialPublisher } from "./types";

/**
 * Picks the publisher for a platform. Real adapters activate only when their
 * app credentials are in env; otherwise the MockPublisher is used.
 * Accounts connected through the mock (isMock) always stay on the mock.
 */

const env = (k: string) => process.env[k]?.trim() || undefined;

export function realPublisher(platform: SocialPlatform): SocialPublisher | null {
  switch (platform) {
    case "X":
      return env("X_CLIENT_ID") && env("X_CLIENT_SECRET") ? new XPublisher(env("X_CLIENT_ID")!, env("X_CLIENT_SECRET")!) : null;
    case "FACEBOOK":
    case "INSTAGRAM":
      return env("META_APP_ID") && env("META_APP_SECRET") ? new MetaPublisher(platform, env("META_APP_ID")!, env("META_APP_SECRET")!) : null;
    case "LINKEDIN":
      return env("LINKEDIN_CLIENT_ID") && env("LINKEDIN_CLIENT_SECRET") ? new LinkedInPublisher(env("LINKEDIN_CLIENT_ID")!, env("LINKEDIN_CLIENT_SECRET")!) : null;
    case "TIKTOK":
      return env("TIKTOK_CLIENT_KEY") && env("TIKTOK_CLIENT_SECRET") ? new TikTokPublisher(env("TIKTOK_CLIENT_KEY")!, env("TIKTOK_CLIENT_SECRET")!) : null;
    case "YOUTUBE":
      return env("YOUTUBE_CLIENT_ID") && env("YOUTUBE_CLIENT_SECRET") ? new YouTubePublisher(env("YOUTUBE_CLIENT_ID")!, env("YOUTUBE_CLIENT_SECRET")!) : null;
  }
}

let overrides: Partial<Record<SocialPlatform, SocialPublisher>> = {};

/** Publisher for NEW connections on this platform. */
export function publisherForConnect(platform: SocialPlatform): SocialPublisher {
  return overrides[platform] ?? realPublisher(platform) ?? new MockPublisher(platform);
}

/** Publisher for an existing account (mock accounts never switch to a real API). */
export function publisherForAccount(account: { platform: SocialPlatform; isMock: boolean }): SocialPublisher {
  if (account.isMock) return new MockPublisher(account.platform);
  const real = overrides[account.platform] ?? realPublisher(account.platform);
  if (!real) throw new Error(`${account.platform} app credentials are no longer configured`);
  return real;
}

/** Test-only. */
export function overridePublisher(platform: SocialPlatform, p: SocialPublisher | undefined) {
  if (p) overrides[platform] = p;
  else overrides = {};
}
