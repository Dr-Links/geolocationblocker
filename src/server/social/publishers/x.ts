import type { ConnectArgs } from "../types";
import { validatePost } from "../validation";
import { expiresAt, httpJson, type FetchLike } from "../oauth";
import { PublishError, type AccountCredentials, type ConnectedProfile, type PublishInput, type PublishMedia, type SocialPublisher, type TokenSet } from "../types";

/**
 * X (Twitter) API v2 with OAuth 2.0 Authorization Code + PKCE.
 * Requires X_CLIENT_ID / X_CLIENT_SECRET (confidential client).
 * NOTE: endpoints follow X's v2 docs as known at build time; verify on first live use.
 */
const AUTH_URL = "https://x.com/i/oauth2/authorize";
const API = "https://api.x.com/2";
const SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];
const CHUNK = 4 * 1024 * 1024;

export class XPublisher implements SocialPublisher {
  readonly platform = "X" as const;
  readonly isMock = false;
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private basicAuth() {
    return `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
  }

  authorizeUrl({ state, redirectUri, codeChallenge }: { state: string; redirectUri: string; codeChallenge: string }) {
    const q = new URLSearchParams({ response_type: "code", client_id: this.clientId, redirect_uri: redirectUri, scope: SCOPES.join(" "), state, code_challenge: codeChallenge, code_challenge_method: "S256" });
    return `${AUTH_URL}?${q}`;
  }

  private async token(form: Record<string, string>) {
    const t = await httpJson<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>("X", this.fetchImpl, `${API}/oauth2/token`, {
      method: "POST",
      headers: { Authorization: this.basicAuth() },
      form,
    });
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresAt(t.expires_in), scopes: t.scope?.split(" ") };
  }

  async connect({ code, redirectUri, codeVerifier }: ConnectArgs): Promise<ConnectedProfile[]> {
    const tokens = await this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: this.clientId });
    const me = await httpJson<{ data: { id: string; name: string; username: string; profile_image_url?: string } }>("X", this.fetchImpl, `${API}/users/me?user.fields=profile_image_url`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    return [{ platform: "X", externalId: me.data.id, displayName: me.data.name, handle: `@${me.data.username}`, avatarUrl: me.data.profile_image_url, ...tokens }];
  }

  async refreshToken(account: AccountCredentials): Promise<TokenSet> {
    if (!account.refreshToken) throw new PublishError("No refresh token; reconnect the account", "X", { retryable: false, authExpired: true });
    return this.token({ grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: this.clientId });
  }

  validateMedia(post: PublishInput) {
    return validatePost("X", post);
  }

  private async uploadMedia(m: PublishMedia, token: string): Promise<string> {
    const auth = { Authorization: `Bearer ${token}` };
    const bytes = await m.load();
    if (m.kind === "IMAGE") {
      const form = new FormData();
      form.set("media", new Blob([new Uint8Array(bytes)], { type: m.mimeType }));
      form.set("media_category", "tweet_image");
      const r = await httpJson<{ data: { id: string } }>("X", this.fetchImpl, `${API}/media/upload`, { method: "POST", headers: auth, body: form });
      return r.data.id;
    }
    const init = await httpJson<{ data: { id: string } }>("X", this.fetchImpl, `${API}/media/upload/initialize`, {
      method: "POST",
      headers: auth,
      json: { media_type: m.mimeType, total_bytes: bytes.length, media_category: "tweet_video" },
    });
    const id = init.data.id;
    for (let i = 0, seg = 0; i < bytes.length; i += CHUNK, seg++) {
      const form = new FormData();
      form.set("media", new Blob([new Uint8Array(bytes.subarray(i, i + CHUNK))]));
      form.set("segment_index", String(seg));
      await httpJson("X", this.fetchImpl, `${API}/media/upload/${id}/append`, { method: "POST", headers: auth, body: form });
    }
    let fin = await httpJson<{ data: { processing_info?: { state: string; check_after_secs?: number; error?: { message?: string } } } }>(
      "X", this.fetchImpl, `${API}/media/upload/${id}/finalize`, { method: "POST", headers: auth },
    );
    for (let tries = 0; fin.data.processing_info && ["pending", "in_progress"].includes(fin.data.processing_info.state); tries++) {
      if (tries > 60) throw new PublishError("X video processing timed out", "X", { retryable: true });
      await new Promise((r) => setTimeout(r, (fin.data.processing_info?.check_after_secs ?? 2) * 1000));
      fin = await httpJson("X", this.fetchImpl, `${API}/media/upload?command=STATUS&media_id=${id}`, { headers: auth });
    }
    if (fin.data.processing_info?.state === "failed") throw new PublishError(`X rejected the video: ${fin.data.processing_info.error?.message ?? "processing failed"}`, "X", { retryable: false });
    return id;
  }

  async publish(post: PublishInput, account: AccountCredentials) {
    const v = this.validateMedia(post);
    if (!v.ok) throw new PublishError(v.errors[0]!.message, "X", { retryable: false, code: "validation" });
    const mediaIds: string[] = [];
    for (const m of post.media) mediaIds.push(await this.uploadMedia(m, account.accessToken));
    const r = await httpJson<{ data: { id: string } }>("X", this.fetchImpl, `${API}/tweets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.accessToken}` },
      json: { text: post.text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) },
    });
    const handle = account.handle?.replace(/^@/, "");
    return { externalPostId: r.data.id, url: handle ? `https://x.com/${handle}/status/${r.data.id}` : null };
  }

  async checkHealth(account: AccountCredentials) {
    try {
      await httpJson("X", this.fetchImpl, `${API}/users/me`, { headers: { Authorization: `Bearer ${account.accessToken}` } });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
