import type { ConnectArgs } from "../types";
import { validatePost } from "../validation";
import { expiresAt, httpJson, type FetchLike } from "../oauth";
import { PublishError, type AccountCredentials, type ConnectedProfile, type PublishInput, type SocialPublisher, type TokenSet } from "../types";

/**
 * YouTube Data API v3 (Google OAuth 2.0, offline access), resumable upload.
 * Unverified Google Cloud projects upload as private until the app passes audit.
 * NOTE: endpoints follow Google's docs as known at build time; verify on first live use.
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];

export class YouTubePublisher implements SocialPublisher {
  readonly platform = "YOUTUBE" as const;
  readonly isMock = false;
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  authorizeUrl({ state, redirectUri, codeChallenge }: { state: string; redirectUri: string; codeChallenge: string }) {
    const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "), state, access_type: "offline", prompt: "consent", include_granted_scopes: "true", code_challenge: codeChallenge, code_challenge_method: "S256" });
    return `${AUTH_URL}?${q}`;
  }

  private async token(form: Record<string, string>): Promise<TokenSet> {
    const t = await httpJson<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>("YOUTUBE", this.fetchImpl, TOKEN_URL, {
      method: "POST",
      form: { ...form, client_id: this.clientId, client_secret: this.clientSecret },
    });
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresAt(t.expires_in), scopes: t.scope?.split(" ") };
  }

  async connect({ code, redirectUri, codeVerifier }: ConnectArgs): Promise<ConnectedProfile[]> {
    const tokens = await this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier });
    const ch = await httpJson<{ items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url?: string } } } }[] }>("YOUTUBE", this.fetchImpl, `${API}/channels?part=snippet&mine=true`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!ch.items?.length) throw new PublishError("This Google account has no YouTube channel.", "YOUTUBE", { retryable: false, code: "no_channel" });
    return ch.items.map((c) => ({ platform: "YOUTUBE" as const, externalId: c.id, displayName: c.snippet.title, handle: c.snippet.customUrl ?? null, avatarUrl: c.snippet.thumbnails?.default?.url, ...tokens }));
  }

  async refreshToken(account: AccountCredentials): Promise<TokenSet> {
    if (!account.refreshToken) throw new PublishError("No refresh token; reconnect YouTube", "YOUTUBE", { retryable: false, authExpired: true });
    const t = await this.token({ grant_type: "refresh_token", refresh_token: account.refreshToken });
    return { ...t, refreshToken: t.refreshToken ?? account.refreshToken }; // Google omits it on refresh
  }

  validateMedia(post: PublishInput) {
    return validatePost("YOUTUBE", post);
  }

  async publish(post: PublishInput, account: AccountCredentials) {
    const v = this.validateMedia(post);
    if (!v.ok) throw new PublishError(v.errors[0]!.message, "YOUTUBE", { retryable: false, code: "validation" });
    const video = post.media[0]!;
    const bytes = await video.load();
    const [firstLine, ...rest] = post.text.split("\n");
    const title = (post.title ?? firstLine ?? "").trim().slice(0, 100);
    const auth = { Authorization: `Bearer ${account.accessToken}` };

    const start = await this.fetchImpl(`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": video.mimeType, "X-Upload-Content-Length": String(bytes.length) },
      body: JSON.stringify({ snippet: { title, description: post.title ? post.text : rest.join("\n").trim() }, status: { privacyStatus: process.env.YOUTUBE_PRIVACY_STATUS || "public", selfDeclaredMadeForKids: false } }),
    });
    const location = start.headers.get("location");
    if (!start.ok || !location) throw new PublishError(`YouTube upload init failed (${start.status})`, "YOUTUBE", { retryable: start.status >= 500 || start.status === 429, authExpired: start.status === 401, status: start.status });
    const up = await httpJson<{ id: string }>("YOUTUBE", this.fetchImpl, location, { method: "PUT", headers: { "Content-Type": video.mimeType }, body: new Uint8Array(bytes) });
    return { externalPostId: up.id, url: `https://www.youtube.com/watch?v=${up.id}` };
  }

  async checkHealth(account: AccountCredentials) {
    try {
      await httpJson("YOUTUBE", this.fetchImpl, `${API}/channels?part=id&mine=true`, { headers: { Authorization: `Bearer ${account.accessToken}` } });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
