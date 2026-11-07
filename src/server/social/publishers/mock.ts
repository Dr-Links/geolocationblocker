import type { ConnectArgs } from "../types";
import { randomBytes } from "node:crypto";
import type { SocialPlatform } from "@prisma/client";
import { signToken, verifyToken } from "@/lib/signed-token";
import { PLATFORM_RULES } from "@/lib/platforms";
import { validatePost } from "../validation";
import { PublishError, type AccountCredentials, type ConnectedProfile, type PublishInput, type SocialPublisher, type TokenSet } from "../types";

/**
 * Default publisher when a platform's app credentials aren't configured.
 * "Connecting" sends the user to a local consent screen (/connect/mock), then
 * through the SAME callback + token storage path as a real OAuth provider.
 * Text hooks for testing: "[mock:fail]" → transient error, "[mock:reject]" → permanent.
 */

export const MOCK_CODE_PURPOSE = "mock-oauth-code";
const TOKEN_TTL_SEC = 60 * 60; // short, so refresh is exercised

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mockDelay = () => Number(process.env.MOCK_PUBLISH_DELAY_MS ?? 300);

export class MockPublisher implements SocialPublisher {
  readonly isMock = true;
  constructor(readonly platform: SocialPlatform) {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const q = new URLSearchParams({ platform: this.platform, state, redirect_uri: redirectUri });
    return `${appUrl}/connect/mock?${q}`;
  }

  async connect({ code }: ConnectArgs): Promise<ConnectedProfile[]> {
    const payload = verifyToken<{ p: SocialPlatform; h: string }>(code, MOCK_CODE_PURPOSE);
    if (!payload || payload.p !== this.platform) throw new PublishError("Invalid or expired authorization code", this.platform, { retryable: false, code: "invalid_grant" });
    const handle = payload.h.replace(/^@/, "");
    return [
      {
        platform: this.platform,
        externalId: `mock-${this.platform.toLowerCase()}-${handle.toLowerCase()}`,
        displayName: handle,
        handle: this.platform === "LINKEDIN" || this.platform === "FACEBOOK" ? handle : `@${handle}`,
        accessToken: `mock_at_${randomBytes(12).toString("hex")}`,
        refreshToken: `mock_rt_${randomBytes(12).toString("hex")}`,
        expiresAt: new Date(Date.now() + TOKEN_TTL_SEC * 1000),
        scopes: ["mock.publish"],
      },
    ];
  }

  async refreshToken(account: AccountCredentials): Promise<TokenSet> {
    if (!account.refreshToken || account.refreshToken.includes("revoked")) {
      throw new PublishError("Refresh token revoked", this.platform, { retryable: false, authExpired: true, code: "invalid_grant" });
    }
    return { accessToken: `mock_at_${randomBytes(12).toString("hex")}`, refreshToken: account.refreshToken, expiresAt: new Date(Date.now() + TOKEN_TTL_SEC * 1000) };
  }

  validateMedia(post: PublishInput) {
    return validatePost(this.platform, post, { publicUrlsAvailable: true });
  }

  async publish(post: PublishInput, account: AccountCredentials) {
    const v = this.validateMedia(post);
    if (!v.ok) throw new PublishError(v.errors[0]!.message, this.platform, { retryable: false, code: "validation" });
    await sleep(mockDelay());
    if (post.text.includes("[mock:fail]")) throw new PublishError(`${PLATFORM_RULES[this.platform].label} is temporarily unavailable (simulated)`, this.platform, { retryable: true, status: 503 });
    if (post.text.includes("[mock:reject]")) throw new PublishError("Post rejected by the platform (simulated)", this.platform, { retryable: false, status: 400 });
    if (account.accessToken.includes("expired")) throw new PublishError("Access token expired", this.platform, { retryable: false, authExpired: true, status: 401 });
    const id = `mock_${randomBytes(6).toString("hex")}`;
    const handle = (account.handle ?? account.externalId).replace(/^@/, "");
    return { externalPostId: id, url: `https://mock.social/${this.platform.toLowerCase()}/${encodeURIComponent(handle)}/${id}` };
  }

  async checkHealth(account: AccountCredentials) {
    return account.accessToken.includes("expired") ? { ok: false, error: "Access token expired" } : { ok: true };
  }
}

/** Code the mock consent screen hands back to the callback. */
export function mockAuthCode(platform: SocialPlatform, handle: string) {
  return signToken({ p: platform, h: handle }, MOCK_CODE_PURPOSE, 10 * 60);
}
