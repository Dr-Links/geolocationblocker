import type { ConnectArgs } from "../types";
import { validatePost } from "../validation";
import { expiresAt, httpJson, type FetchLike } from "../oauth";
import { PublishError, type AccountCredentials, type ConnectedProfile, type PublishInput, type SocialPublisher, type TokenSet } from "../types";

/**
 * LinkedIn member posting: OpenID Connect sign-in + w_member_social, versioned
 * REST Posts/Images APIs. LINKEDIN_API_VERSION (YYYYMM) is configurable because
 * LinkedIn retires versions roughly yearly.
 * NOTE: endpoints follow LinkedIn's docs as known at build time; verify on first live use.
 */
const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const API = "https://api.linkedin.com";
const SCOPES = ["openid", "profile", "w_member_social"];

export class LinkedInPublisher implements SocialPublisher {
  readonly platform = "LINKEDIN" as const;
  readonly isMock = false;
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly version = process.env.LINKEDIN_API_VERSION || "202510",
  ) {}

  private rest(token: string) {
    return { Authorization: `Bearer ${token}`, "LinkedIn-Version": this.version, "X-Restli-Protocol-Version": "2.0.0" };
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    const q = new URLSearchParams({ response_type: "code", client_id: this.clientId, redirect_uri: redirectUri, scope: SCOPES.join(" "), state });
    return `${AUTH_URL}?${q}`;
  }

  private async token(form: Record<string, string>): Promise<TokenSet> {
    const t = await httpJson<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>("LINKEDIN", this.fetchImpl, TOKEN_URL, {
      method: "POST",
      form: { ...form, client_id: this.clientId, client_secret: this.clientSecret },
    });
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresAt(t.expires_in), scopes: t.scope?.split(/[ ,]/) };
  }

  async connect({ code, redirectUri }: ConnectArgs): Promise<ConnectedProfile[]> {
    const tokens = await this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const me = await httpJson<{ sub: string; name: string; picture?: string }>("LINKEDIN", this.fetchImpl, `${API}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    return [{ platform: "LINKEDIN", externalId: me.sub, displayName: me.name, handle: me.name, avatarUrl: me.picture, ...tokens }];
  }

  async refreshToken(account: AccountCredentials): Promise<TokenSet> {
    // Refresh tokens are only issued to approved partner apps; others must reconnect (~60 days).
    if (!account.refreshToken) throw new PublishError("LinkedIn access expired; reconnect the account", "LINKEDIN", { retryable: false, authExpired: true });
    return this.token({ grant_type: "refresh_token", refresh_token: account.refreshToken });
  }

  validateMedia(post: PublishInput) {
    return validatePost("LINKEDIN", post);
  }

  async publish(post: PublishInput, account: AccountCredentials) {
    const v = this.validateMedia(post);
    if (!v.ok) throw new PublishError(v.errors[0]!.message, "LINKEDIN", { retryable: false, code: "validation" });
    const author = `urn:li:person:${account.externalId}`;
    const headers = this.rest(account.accessToken);

    const mediaUrns: string[] = [];
    for (const m of post.media) {
      const kind = m.kind === "IMAGE" ? "images" : "videos";
      const bytes = await m.load();
      const init = await httpJson<{ value: { uploadUrl?: string; image?: string; video?: string; uploadInstructions?: { uploadUrl: string }[] } }>(
        "LINKEDIN", this.fetchImpl, `${API}/rest/${kind}?action=initializeUpload`,
        { method: "POST", headers, json: { initializeUploadRequest: m.kind === "IMAGE" ? { owner: author } : { owner: author, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } } },
      );
      const uploadUrl = init.value.uploadUrl ?? init.value.uploadInstructions?.[0]?.uploadUrl;
      const urn = init.value.image ?? init.value.video;
      if (!uploadUrl || !urn) throw new PublishError("LinkedIn didn't return an upload URL", "LINKEDIN", { retryable: true });
      const put = await this.fetchImpl(uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${account.accessToken}` }, body: new Uint8Array(bytes) });
      if (!put.ok) throw new PublishError(`LinkedIn upload failed (${put.status})`, "LINKEDIN", { retryable: put.status >= 500 });
      mediaUrns.push(urn);
    }

    const content = mediaUrns.length === 1 ? { media: { id: mediaUrns[0] } } : mediaUrns.length > 1 ? { multiImage: { images: mediaUrns.map((id) => ({ id })) } } : undefined;
    const res = await this.fetchImpl(`${API}/rest/posts`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ author, commentary: post.text, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false, ...(content ? { content } : {}) }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new PublishError(`LINKEDIN: ${detail.slice(0, 300) || res.status}`, "LINKEDIN", { retryable: res.status === 429 || res.status >= 500, authExpired: res.status === 401, status: res.status });
    }
    const id = res.headers.get("x-restli-id") ?? "";
    return { externalPostId: id, url: id ? `https://www.linkedin.com/feed/update/${id}/` : null };
  }

  async checkHealth(account: AccountCredentials) {
    try {
      await httpJson("LINKEDIN", this.fetchImpl, `${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${account.accessToken}` } });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
