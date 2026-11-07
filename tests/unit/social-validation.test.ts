import { describe, expect, it } from "vitest";
import { validatePost } from "@/server/social/validation";
import type { PublishMedia } from "@/server/social/types";

const img = (over: Partial<PublishMedia> = {}): PublishMedia => ({ id: "i", kind: "IMAGE", mimeType: "image/jpeg", width: 1080, height: 1080, sizeBytes: 200_000, load: async () => Buffer.alloc(0), ...over });
const vid = (over: Partial<PublishMedia> = {}): PublishMedia => ({ id: "v", kind: "VIDEO", mimeType: "video/mp4", width: 1080, height: 1920, durationMs: 15_000, sizeBytes: 5_000_000, load: async () => Buffer.alloc(0), ...over });
const codes = (r: ReturnType<typeof validatePost>) => r.errors.map((e) => e.code);

describe("validatePost", () => {
  it("X: 280 chars, ≤4 images, no mixing, one video", () => {
    expect(validatePost("X", { text: "hi", media: [] }).ok).toBe(true);
    expect(codes(validatePost("X", { text: "x".repeat(281), media: [] }))).toContain("text_too_long");
    expect(codes(validatePost("X", { text: "hi", media: [img(), img(), img(), img(), img()] }))).toContain("too_many_images");
    expect(codes(validatePost("X", { text: "hi", media: [img(), vid()] }))).toContain("mixed_media");
    expect(codes(validatePost("X", { text: "hi", media: [vid({ durationMs: 200_000 })] }))).toContain("video_duration");
  });

  it("counts emoji as single characters", () => {
    expect(validatePost("X", { text: "😀".repeat(280), media: [] }).ok).toBe(true);
  });

  it("Instagram: needs media, JPEG images, 4:5–1.91:1 aspect, carousel ≤10, public URLs", () => {
    expect(codes(validatePost("INSTAGRAM", { text: "hi", media: [] }))).toContain("media_required");
    expect(codes(validatePost("INSTAGRAM", { text: "hi", media: [img({ mimeType: "image/png" })] }))).toContain("image_format");
    expect(codes(validatePost("INSTAGRAM", { text: "hi", media: [img({ width: 1080, height: 1920 })] }))).toContain("image_aspect");
    expect(validatePost("INSTAGRAM", { text: "hi", media: [img({ width: 1080, height: 1350 })] }).ok).toBe(true);
    expect(codes(validatePost("INSTAGRAM", { text: "hi", media: Array.from({ length: 11 }, () => img()) }))).toContain("carousel_too_big");
    expect(codes(validatePost("INSTAGRAM", { text: "hi", media: [img()] }, { publicUrlsAvailable: false }))).toContain("needs_public_media");
  });

  it("TikTok and YouTube require exactly one video; YouTube needs a ≤100 char title", () => {
    expect(codes(validatePost("TIKTOK", { text: "hi", media: [img()] }))).toEqual(expect.arrayContaining(["video_required", "too_many_images"]));
    expect(validatePost("TIKTOK", { text: "hi", media: [vid()] }).ok).toBe(true);
    expect(validatePost("TIKTOK", { text: "hi", media: [vid({ width: 1920, height: 1080 })] }).warnings.map((w) => w.code)).toContain("video_orientation");
    expect(codes(validatePost("YOUTUBE", { text: "x".repeat(120), media: [vid()] }))).toContain("title_too_long");
    expect(validatePost("YOUTUBE", { text: "My title\nDescription", media: [vid()] }).ok).toBe(true);
  });

  it("LinkedIn 3000 chars; Facebook text-only is fine; empty posts are rejected", () => {
    expect(codes(validatePost("LINKEDIN", { text: "x".repeat(3001), media: [] }))).toContain("text_too_long");
    expect(validatePost("FACEBOOK", { text: "Hello", media: [] }).ok).toBe(true);
    expect(codes(validatePost("FACEBOOK", { text: "  ", media: [] }))).toContain("empty");
  });

  it("warns on too many hashtags and unknown video length", () => {
    const r = validatePost("X", { text: "#a #b #c #d", media: [vid({ durationMs: null })] });
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["many_hashtags", "video_duration_unknown"]));
  });
});
