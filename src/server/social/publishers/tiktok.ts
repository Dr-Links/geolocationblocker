import type { ConnectArgs } from "../types";
import { validatePost } from "../validation";
import { expiresAt, httpJson, type FetchLike } from "../oauth";
import { PublishError, type AccountCredentials, type ConnectedProfile, type PublishInput, type SocialPublisher, type TokenSet } from "../types";

/**
 * TikTok Content Posting API (Direct Post, FILE_UPLOAD). Unaudited apps can
 * only post privately (SELF_ONLY): set TIKTOK_PRIVACY_LEVEL after audit.
 * NOTE: endpoints follow TikTok's docs as known at build time; verify on first live use.
 */
const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com/v2";
const SCOPES = ["user.info.basic", "video.publish"];

type Envelope<T> = { data: T; error?: { code: string; message?: string } };

export class TikTokPublisher implements SocialPublisher {
  readonly platform = "TIKTOK" as const;
  readonly isMock = false;
  constructor(
    private readonly clientKey: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly pollMs = 5_000,
  ) {}

  authorizeUrl({ state, redirectUri, codeChallenge }: { state: string; redirectUri: string; codeChallenge: string }) {
    const q = new URLSearchParams({ client_key: this.clientKey, response_type: "code", scope: SCOPES.join(","), redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: "S256" });
    return `${AUTH_URL}?${q}`;
  }

  private async token(form: Record<string, string>): Promise<TokenSet & { openId: string }> {
    const t = await httpJson<{ access_token: string; refresh_token: string; expires_in: number; open_id: string; scope: string }>("TIKTOK", this.fetchImpl, `${API}/oauth/token/`, {
      method: "POST",
      form: { ...form, client_key: this.clientKey, client_secret: this.clientSecret },
    });
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresAt(t.expires_in), scopes: t.scope?.split(","), openId: t.open_id };
  }

  async connect({ code, redirectUri, codeVerifier }: ConnectArgs): Promise<ConnectedProfile[]> {
    const { openId, ...tokens } = await this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier });
    const me = await httpJson<Envelope<{ user: { open_id: string; display_name: string; avatar_url?: string; username?: string } }>>("TIKTOK", this.fetchImpl, `${API}/user/info/?fields=open_id,display_name,avatar_url,username`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const u = me.data.user;
    return [{ platform: "TIKTOK", externalId: u.open_id || openId, displayName: u.display_name, handle: u.username ? `@${u.username}` : null, avatarUrl: u.avatar_url, ...tokens }];
  }

  async refreshToken(account: AccountCredentials): Promise<TokenSet> {
    if (!account.refreshToken) throw new PublishError("No refresh token; reconnect TikTok", "TIKTOK", { retryable: false, authExpired: true });
    const { openId: _o, ...t } = await this.token({ grant_type: "refresh_token", refresh_token: account.refreshToken });
    void _o;
    return t;
  }

  validateMedia(post: PublishInput) {
    return validatePost("TIKTOK", post);
  }

  async publish(post: PublishInput, account: AccountCredentials) {
    const v = this.validateMedia(post);
    if (!v.ok) throw new PublishError(v.errors[0]!.message, "TIKTOK", { retryable: false, code: "validation" });
    const video = post.media[0]!;
    const bytes = await video.load();
    const auth = { Authorization: `Bearer ${account.accessToken}` };
    const init = await httpJson<Envelope<{ publish_id: string; upload_url: string }>>("TIKTOK", this.fetchImpl, `${API}/post/publish/video/init/`, {
      method: "POST",
      headers: auth,
      json: {
        post_info: { title: post.text.slice(0, 2200), privacy_level: process.env.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY", disable_comment: false },
        source_info: { source: "FILE_UPLOAD", video_size: bytes.length, chunk_size: bytes.length, total_chunk_count: 1 },
      },
    });
    const put = await this.fetchImpl(init.data.upload_url, {
      method: "PUT",
      headers: { "Content-Type": video.mimeType, "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
      body: new Uint8Array(bytes),
    });
    if (!put.ok) throw new PublishError(`TikTok upload failed (${put.status})`, "TIKTOK", { retryable: put.status >= 500 });

    for (let i = 0; i < 120; i++) {
      const s = await httpJson<Envelope<{ status: string; fail_reason?: string; publicaly_available_post_id?: string[] }>>("TIKTOK", this.fetchImpl, `${API}/post/publish/status/fetch/`, {
        method: "POST",
        headers: auth,
        json: { publish_id: init.data.publish_id },
      });
      if (s.data.status === "PUBLISH_COMPLETE") {
        const postId = s.data.publicaly_available_post_id?.[0];
        return { externalPostId: postId ?? init.data.publish_id, url: postId && account.handle ? `https://www.tiktok.com/${account.handle}/video/${postId}` : null };
      }
      if (s.data.status === "FAILED") throw new PublishError(`TikTok rejected the post: ${s.data.fail_reason ?? "unknown"}`, "TIKTOK", { retryable: false });
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    throw new PublishError("TikTok processing timed out", "TIKTOK", { retryable: true });
  }

  async checkHealth(account: AccountCredentials) {
    try {
      await httpJson("TIKTOK", this.fetchImpl, `${API}/user/info/?fields=open_id`, { headers: { Authorization: `Bearer ${account.accessToken}` } });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
