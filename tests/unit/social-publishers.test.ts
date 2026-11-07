import { describe, expect, it, vi } from "vitest";
import { httpJson, pkcePair } from "@/server/social/oauth";
import { LinkedInPublisher } from "@/server/social/publishers/linkedin";
import { MetaPublisher } from "@/server/social/publishers/meta";
import { MockPublisher, mockAuthCode } from "@/server/social/publishers/mock";
import { TikTokPublisher } from "@/server/social/publishers/tiktok";
import { XPublisher } from "@/server/social/publishers/x";
import { YouTubePublisher } from "@/server/social/publishers/youtube";
import { PublishError, type PublishMedia } from "@/server/social/types";
import { createHash } from "node:crypto";

process.env.MOCK_PUBLISH_DELAY_MS = "0";

type Route = { match: (url: string, init?: RequestInit) => boolean; res: () => Response };
/** Scripted fetch: first matching route wins; records every call. */
function fakeFetch(routes: Route[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = routes.find((x) => x.match(u, init));
    if (!r) throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${u}`);
    return r.res();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const on = (method: string, frag: string) => (url: string, init?: RequestInit) => (init?.method ?? "GET") === method && url.includes(frag);

const image: PublishMedia = { id: "m1", kind: "IMAGE", mimeType: "image/jpeg", width: 1080, height: 1080, sizeBytes: 10, publicUrl: "https://cdn.example/m1.jpg", load: async () => Buffer.from("jpeg") };
const video: PublishMedia = { id: "m2", kind: "VIDEO", mimeType: "video/mp4", width: 1080, height: 1920, durationMs: 10_000, sizeBytes: 10, publicUrl: "https://cdn.example/m2.mp4", load: async () => Buffer.from("mp4data") };
const account = { externalId: "ext-1", handle: "@brand", accessToken: "at-123", refreshToken: "rt-456" };

describe("oauth helpers", () => {
  it("pkce: S256 challenge matches verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });
  it("httpJson maps 401 → authExpired, 429/5xx → retryable, 400 → permanent", async () => {
    for (const [status, retryable, authExpired] of [[401, false, true], [429, true, false], [503, true, false], [400, false, false]] as const) {
      const { fetch } = fakeFetch([{ match: () => true, res: json({ error: { message: "nope" } }, status) }]);
      const err = (await httpJson("X", fetch, "https://api/x").catch((e: unknown) => e)) as PublishError;
      expect(err).toBeInstanceOf(PublishError);
      expect([err.retryable, !!err.opts.authExpired]).toEqual([retryable, authExpired]);
      expect(err.message).toContain("nope");
    }
  });
});

describe("MockPublisher", () => {
  const mock = new MockPublisher("X");
  it("connects with a signed code and refreshes", async () => {
    const [p] = await mock.connect({ code: mockAuthCode("X", "acme"), redirectUri: "", codeVerifier: "" });
    expect(p).toMatchObject({ platform: "X", handle: "@acme", externalId: "mock-x-acme" });
    expect(p!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    await expect(mock.connect({ code: mockAuthCode("INSTAGRAM", "acme"), redirectUri: "", codeVerifier: "" })).rejects.toThrow(/Invalid/);
    await expect(mock.connect({ code: "forged", redirectUri: "", codeVerifier: "" })).rejects.toThrow();
    expect((await mock.refreshToken(account)).accessToken).toMatch(/^mock_at_/);
    await expect(mock.refreshToken({ ...account, refreshToken: "revoked" })).rejects.toMatchObject({ opts: { authExpired: true } });
  });
  it("publishes, validates, and simulates failures", async () => {
    expect((await mock.publish({ text: "hello", media: [] }, account)).url).toContain("mock.social/x/brand/");
    await expect(mock.publish({ text: "x".repeat(300), media: [] }, account)).rejects.toMatchObject({ retryable: false });
    await expect(mock.publish({ text: "hi [mock:fail]", media: [] }, account)).rejects.toMatchObject({ retryable: true });
    await expect(mock.publish({ text: "hi [mock:reject]", media: [] }, account)).rejects.toMatchObject({ retryable: false });
  });
});

describe("XPublisher", () => {
  it("authorize URL uses PKCE S256 and the needed scopes", () => {
    const u = new URL(new XPublisher("cid", "secret").authorizeUrl({ state: "st", redirectUri: "https://app/cb", codeChallenge: "ch" }));
    expect(u.origin + u.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "cid", state: "st", code_challenge: "ch", code_challenge_method: "S256", redirect_uri: "https://app/cb" });
    expect(u.searchParams.get("scope")).toContain("tweet.write");
    expect(u.searchParams.get("scope")).toContain("offline.access");
  });
  it("connect exchanges code with Basic auth + verifier, then reads the profile", async () => {
    const { fetch, calls } = fakeFetch([
      { match: on("POST", "/2/oauth2/token"), res: json({ access_token: "AT", refresh_token: "RT", expires_in: 7200, scope: "tweet.read tweet.write" }) },
      { match: on("GET", "/2/users/me"), res: json({ data: { id: "42", name: "Acme", username: "acme" } }) },
    ]);
    const [p] = await new XPublisher("cid", "secret", fetch).connect({ code: "c", redirectUri: "https://app/cb", codeVerifier: "ver" });
    expect(p).toMatchObject({ externalId: "42", handle: "@acme", accessToken: "AT", refreshToken: "RT" });
    expect(new Headers(calls[0]!.init!.headers).get("Authorization")).toBe(`Basic ${Buffer.from("cid:secret").toString("base64")}`);
    expect(String(calls[0]!.init!.body)).toContain("code_verifier=ver");
  });
  it("publish uploads the image then posts the tweet with media ids", async () => {
    const { fetch, calls } = fakeFetch([
      { match: on("POST", "/2/media/upload"), res: json({ data: { id: "MEDIA1" } }) },
      { match: on("POST", "/2/tweets"), res: json({ data: { id: "T1" } }) },
    ]);
    const r = await new XPublisher("c", "s", fetch).publish({ text: "hello", media: [image] }, account);
    expect(r).toEqual({ externalPostId: "T1", url: "https://x.com/brand/status/T1" });
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ text: "hello", media: { media_ids: ["MEDIA1"] } });
  });
});

describe("LinkedInPublisher", () => {
  it("posts with versioned REST headers and reads x-restli-id", async () => {
    const { fetch, calls } = fakeFetch([
      { match: on("POST", "/rest/images?action=initializeUpload"), res: json({ value: { uploadUrl: "https://upload.li/1", image: "urn:li:image:9" } }) },
      { match: on("PUT", "upload.li"), res: () => new Response(null, { status: 201 }) },
      { match: on("POST", "/rest/posts"), res: () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7" } }) },
    ]);
    const r = await new LinkedInPublisher("c", "s", fetch, "202510").publish({ text: "Hi LinkedIn", media: [image] }, account);
    expect(r.externalPostId).toBe("urn:li:share:7");
    const post = calls.find((c) => c.url.endsWith("/rest/posts"))!;
    const h = new Headers(post.init!.headers);
    expect([h.get("LinkedIn-Version"), h.get("X-Restli-Protocol-Version")]).toEqual(["202510", "2.0.0"]);
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ author: "urn:li:person:ext-1", commentary: "Hi LinkedIn", lifecycleState: "PUBLISHED", content: { media: { id: "urn:li:image:9" } } });
  });
  it("without a refresh token, refresh asks to reconnect", async () => {
    await expect(new LinkedInPublisher("c", "s").refreshToken({ ...account, refreshToken: null })).rejects.toMatchObject({ opts: { authExpired: true } });
  });
});

describe("MetaPublisher", () => {
  it("Facebook connect returns each Page with its page token (long-lived exchange first)", async () => {
    const { fetch, calls } = fakeFetch([
      { match: (u) => u.includes("/oauth/access_token") && u.includes("code="), res: json({ access_token: "short" }) },
      { match: (u) => u.includes("fb_exchange_token"), res: json({ access_token: "long" }) },
      { match: (u) => u.includes("/me/accounts"), res: json({ data: [{ id: "P1", name: "Acme Page", access_token: "PT1" }, { id: "P2", name: "Other", access_token: "PT2" }] }) },
    ]);
    const pages = await new MetaPublisher("FACEBOOK", "app", "sec", fetch).connect({ code: "c", redirectUri: "https://app/cb", codeVerifier: "" });
    expect(pages.map((p) => [p.externalId, p.accessToken])).toEqual([["P1", "PT1"], ["P2", "PT2"]]);
    expect(calls[2]!.url).toContain("access_token=long");
  });
  it("Instagram connect requires a linked professional account", async () => {
    const { fetch } = fakeFetch([
      { match: (u) => u.includes("/oauth/access_token"), res: json({ access_token: "t" }) },
      { match: (u) => u.includes("/me/accounts"), res: json({ data: [{ id: "P1", name: "No IG", access_token: "PT" }] }) },
    ]);
    await expect(new MetaPublisher("INSTAGRAM", "a", "s", fetch).connect({ code: "c", redirectUri: "", codeVerifier: "" })).rejects.toThrow(/No Instagram professional account/);
  });
  it("Instagram reel: create container → poll FINISHED → media_publish", async () => {
    let polls = 0;
    const { fetch, calls } = fakeFetch([
      { match: on("POST", "/ig-1/media_publish"), res: json({ id: "IGPOST" }) },
      { match: on("POST", "/ig-1/media"), res: json({ id: "CONT" }) },
      { match: (u) => u.includes("/CONT?fields=status_code"), res: () => json({ status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" })() },
      { match: (u) => u.includes("/IGPOST?fields=permalink"), res: json({ permalink: "https://instagram.com/p/x" }) },
    ]);
    const r = await new MetaPublisher("INSTAGRAM", "a", "s", fetch, 1).publish({ text: "Reel!", media: [video] }, { ...account, externalId: "ig-1" });
    expect(r).toEqual({ externalPostId: "IGPOST", url: "https://instagram.com/p/x" });
    const create = calls.find((c) => c.url.endsWith("/ig-1/media"))!;
    expect(String(create.init!.body)).toContain("media_type=REELS");
    expect(String(create.init!.body)).toContain(encodeURIComponent("https://cdn.example/m2.mp4"));
  });
  it("refuses media without public URLs (local storage)", async () => {
    await expect(new MetaPublisher("INSTAGRAM", "a", "s").publish({ text: "x", media: [{ ...image, publicUrl: null }] }, account)).rejects.toThrow(/public URL/);
  });
});

describe("TikTokPublisher", () => {
  it("init FILE_UPLOAD → PUT bytes → poll status", async () => {
    const { fetch, calls } = fakeFetch([
      { match: on("POST", "/post/publish/video/init/"), res: json({ data: { publish_id: "PUB", upload_url: "https://up.tiktok/1" } }) },
      { match: on("PUT", "up.tiktok"), res: () => new Response(null, { status: 201 }) },
      { match: on("POST", "/post/publish/status/fetch/"), res: json({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["777"] } }) },
    ]);
    const r = await new TikTokPublisher("k", "s", fetch, 1).publish({ text: "tt", media: [video] }, account);
    expect(r).toEqual({ externalPostId: "777", url: "https://www.tiktok.com/@brand/video/777" });
    const init = JSON.parse(String(calls[0]!.init!.body));
    expect(init).toMatchObject({ post_info: { privacy_level: "SELF_ONLY" }, source_info: { source: "FILE_UPLOAD", video_size: 7, total_chunk_count: 1 } });
    expect(new Headers(calls[1]!.init!.headers).get("Content-Range")).toBe("bytes 0-6/7");
  });
});

describe("YouTubePublisher", () => {
  it("resumable upload: metadata POST → PUT bytes to the session URL", async () => {
    const { fetch, calls } = fakeFetch([
      { match: on("POST", "uploadType=resumable"), res: () => new Response(null, { status: 200, headers: { location: "https://upload.yt/session1" } }) },
      { match: on("PUT", "upload.yt/session1"), res: json({ id: "VID1" }) },
    ]);
    const r = await new YouTubePublisher("c", "s", fetch).publish({ text: "My title\nThe description", media: [video] }, account);
    expect(r).toEqual({ externalPostId: "VID1", url: "https://www.youtube.com/watch?v=VID1" });
    expect(JSON.parse(String(calls[0]!.init!.body)).snippet).toEqual({ title: "My title", description: "The description" });
  });
  it("authorize requests offline access + consent (to get a refresh token)", () => {
    const u = new URL(new YouTubePublisher("c", "s").authorizeUrl({ state: "s", redirectUri: "r", codeChallenge: "ch" }));
    expect([u.searchParams.get("access_type"), u.searchParams.get("prompt")]).toEqual(["offline", "consent"]);
  });
  it("refresh keeps the old refresh token when Google omits it", async () => {
    const { fetch } = fakeFetch([{ match: on("POST", "oauth2.googleapis.com/token"), res: json({ access_token: "NEW", expires_in: 3600 }) }]);
    expect(await new YouTubePublisher("c", "s", fetch).refreshToken(account)).toMatchObject({ accessToken: "NEW", refreshToken: "rt-456" });
  });
});
