import type { ConnectArgs } from "../types";
import { validatePost } from "../validation";
import { httpJson, type FetchLike } from "../oauth";
import { PublishError, type AccountCredentials, type ConnectedProfile, type PublishInput, type SocialPublisher, type TokenSet } from "../types";

/**
 * Meta Graph API: one app (META_APP_ID/SECRET) serves both Facebook Pages and
 * Instagram professional accounts (linked to a Page). Connecting returns every
 * Page (FACEBOOK) or every linked IG account (INSTAGRAM) the user manages.
 * Page tokens derived from a long-lived user token don't expire.
 * Instagram and Facebook media publishing pull from PUBLIC URLs (needs S3/R2).
 * NOTE: endpoints follow Graph API docs as known at build time; verify on first live use.
 */
const VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const SCOPES = {
  FACEBOOK: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
  INSTAGRAM: ["pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_content_publish", "business_management"],
};

type Page = { id: string; name: string; access_token: string; picture?: { data?: { url?: string } }; instagram_business_account?: { id: string; username?: string; profile_picture_url?: string } };

export class MetaPublisher implements SocialPublisher {
  readonly isMock = false;
  constructor(
    readonly platform: "FACEBOOK" | "INSTAGRAM",
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly pollMs = 5_000,
  ) {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    const q = new URLSearchParams({ client_id: this.appId, redirect_uri: redirectUri, state, response_type: "code", scope: SCOPES[this.platform].join(",") });
    return `https://www.facebook.com/${VERSION}/dialog/oauth?${q}`;
  }

  async connect({ code, redirectUri }: ConnectArgs): Promise<ConnectedProfile[]> {
    const short = await httpJson<{ access_token: string }>(this.platform, this.fetchImpl, `${GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: this.appId, client_secret: this.appSecret, redirect_uri: redirectUri, code })}`);
    // Exchange for a long-lived user token so derived Page tokens don't expire.
    const long = await httpJson<{ access_token: string }>(this.platform, this.fetchImpl, `${GRAPH}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: this.appId, client_secret: this.appSecret, fb_exchange_token: short.access_token })}`);
    const pages = await httpJson<{ data: Page[] }>(this.platform, this.fetchImpl, `${GRAPH}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}", access_token: long.access_token })}`);
    const scopes = SCOPES[this.platform];
    if (this.platform === "FACEBOOK") {
      return pages.data.map((p) => ({ platform: "FACEBOOK" as const, externalId: p.id, displayName: p.name, handle: p.name, avatarUrl: p.picture?.data?.url, accessToken: p.access_token, refreshToken: null, expiresAt: null, scopes }));
    }
    const ig = pages.data.filter((p) => p.instagram_business_account);
    if (!ig.length) throw new PublishError("No Instagram professional account is linked to your Facebook Pages.", "INSTAGRAM", { retryable: false, code: "no_ig_account" });
    return ig.map((p) => ({
      platform: "INSTAGRAM" as const,
      externalId: p.instagram_business_account!.id,
      displayName: p.instagram_business_account!.username ?? p.name,
      handle: p.instagram_business_account!.username ? `@${p.instagram_business_account!.username}` : null,
      avatarUrl: p.instagram_business_account!.profile_picture_url,
      accessToken: p.access_token, // the linked Page's token publishes for its IG account
      refreshToken: null,
      expiresAt: null,
      scopes,
    }));
  }

  async refreshToken(account: AccountCredentials): Promise<TokenSet> {
    // Page tokens from a long-lived user token don't expire; nothing to refresh.
    return { accessToken: account.accessToken, refreshToken: null, expiresAt: null };
  }

  validateMedia(post: PublishInput) {
    return validatePost(this.platform, post, { publicUrlsAvailable: post.media.every((m) => !!m.publicUrl) });
  }

  private async waitForContainer(id: string, token: string) {
    for (let i = 0; i < 60; i++) {
      const s = await httpJson<{ status_code: string; status?: string }>("INSTAGRAM", this.fetchImpl, `${GRAPH}/${id}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
      if (s.status_code === "FINISHED") return;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new PublishError(`Instagram couldn't process the media (${s.status ?? s.status_code})`, "INSTAGRAM", { retryable: false });
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    throw new PublishError("Instagram media processing timed out", "INSTAGRAM", { retryable: true });
  }

  async publish(post: PublishInput, account: AccountCredentials) {
    const v = this.validateMedia(post);
    if (!v.ok) throw new PublishError(v.errors[0]!.message, this.platform, { retryable: false, code: "validation" });
    const token = account.accessToken;
    const call = <T>(path: string, form: Record<string, string>) => httpJson<T>(this.platform, this.fetchImpl, `${GRAPH}/${path}`, { method: "POST", form: { ...form, access_token: token } });

    if (this.platform === "FACEBOOK") {
      const [m] = post.media;
      if (post.media.length > 1) {
        // Multi-photo: upload unpublished photos, then attach them to a feed post.
        const ids = [];
        for (const p of post.media) ids.push((await call<{ id: string }>(`${account.externalId}/photos`, { url: p.publicUrl!, published: "false" })).id);
        const r = await call<{ id: string }>(`${account.externalId}/feed`, { message: post.text, ...Object.fromEntries(ids.map((id, i) => [`attached_media[${i}]`, JSON.stringify({ media_fbid: id })])) });
        return { externalPostId: r.id, url: `https://www.facebook.com/${r.id}` };
      }
      if (m?.kind === "IMAGE") {
        const r = await call<{ id: string; post_id?: string }>(`${account.externalId}/photos`, { url: m.publicUrl!, caption: post.text });
        return { externalPostId: r.post_id ?? r.id, url: `https://www.facebook.com/${r.post_id ?? r.id}` };
      }
      if (m?.kind === "VIDEO") {
        const r = await call<{ id: string }>(`${account.externalId}/videos`, { file_url: m.publicUrl!, description: post.text });
        return { externalPostId: r.id, url: `https://www.facebook.com/${r.id}` };
      }
      const r = await call<{ id: string }>(`${account.externalId}/feed`, { message: post.text });
      return { externalPostId: r.id, url: `https://www.facebook.com/${r.id}` };
    }

    // Instagram: create container(s) → wait for processing → publish.
    const ig = account.externalId;
    let creationId: string;
    if (post.media.length === 1) {
      const m = post.media[0]!;
      const c = await call<{ id: string }>(`${ig}/media`, m.kind === "IMAGE" ? { image_url: m.publicUrl!, caption: post.text } : { media_type: "REELS", video_url: m.publicUrl!, caption: post.text });
      if (m.kind === "VIDEO") await this.waitForContainer(c.id, token);
      creationId = c.id;
    } else {
      const children = [];
      for (const m of post.media) {
        const c = await call<{ id: string }>(`${ig}/media`, m.kind === "IMAGE" ? { image_url: m.publicUrl!, is_carousel_item: "true" } : { media_type: "VIDEO", video_url: m.publicUrl!, is_carousel_item: "true" });
        if (m.kind === "VIDEO") await this.waitForContainer(c.id, token);
        children.push(c.id);
      }
      creationId = (await call<{ id: string }>(`${ig}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: post.text })).id;
    }
    const published = await call<{ id: string }>(`${ig}/media_publish`, { creation_id: creationId });
    const info = await httpJson<{ permalink?: string }>("INSTAGRAM", this.fetchImpl, `${GRAPH}/${published.id}?fields=permalink&access_token=${encodeURIComponent(token)}`).catch(() => ({ permalink: undefined }));
    return { externalPostId: published.id, url: info.permalink ?? null };
  }

  async checkHealth(account: AccountCredentials) {
    try {
      await httpJson(this.platform, this.fetchImpl, `${GRAPH}/${account.externalId}?fields=id&access_token=${encodeURIComponent(account.accessToken)}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
