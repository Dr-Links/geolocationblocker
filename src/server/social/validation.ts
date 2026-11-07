import { PLATFORM_RULES } from "@/lib/platforms";
import type { PublishInput, SocialPlatform, ValidationIssue, ValidationResult } from "./types";

/**
 * Per-platform content rules. Pure, so the composer preview (Phase 5), the
 * mock publisher and the real publishers all validate identically.
 * Limits follow each platform's published constraints for API publishing.
 */

interface Spec {
  maxImages: number;
  maxVideos: number;
  mixMedia: boolean;
  requiresMedia: "none" | "any" | "video";
  imageMimes: string[];
  videoMimes: string[];
  maxImageBytes: number;
  maxVideoBytes: number;
  videoSec: [number, number];
  /** width/height bounds for images (and videos where enforced). */
  imageAspect?: [number, number];
  videoAspect?: [number, number];
  needsPublicUrl: boolean;
}

const MB = 1024 * 1024;
const IMG_COMMON = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MP4_MOV = ["video/mp4", "video/quicktime"];

export const SPECS: Record<SocialPlatform, Spec> = {
  X: { maxImages: 4, maxVideos: 1, mixMedia: false, requiresMedia: "none", imageMimes: IMG_COMMON, videoMimes: MP4_MOV, maxImageBytes: 5 * MB, maxVideoBytes: 512 * MB, videoSec: [0.5, 140], needsPublicUrl: false },
  INSTAGRAM: { maxImages: 10, maxVideos: 10, mixMedia: true, requiresMedia: "any", imageMimes: ["image/jpeg"], videoMimes: MP4_MOV, maxImageBytes: 8 * MB, maxVideoBytes: 300 * MB, videoSec: [3, 90], imageAspect: [0.8, 1.91], videoAspect: [0.01, 10], needsPublicUrl: true },
  FACEBOOK: { maxImages: 10, maxVideos: 1, mixMedia: false, requiresMedia: "none", imageMimes: IMG_COMMON, videoMimes: MP4_MOV, maxImageBytes: 10 * MB, maxVideoBytes: 1024 * MB, videoSec: [1, 240 * 60], needsPublicUrl: true },
  LINKEDIN: { maxImages: 20, maxVideos: 1, mixMedia: false, requiresMedia: "none", imageMimes: ["image/jpeg", "image/png", "image/gif"], videoMimes: ["video/mp4"], maxImageBytes: 36 * MB, maxVideoBytes: 500 * MB, videoSec: [3, 600], needsPublicUrl: false },
  TIKTOK: { maxImages: 0, maxVideos: 1, mixMedia: false, requiresMedia: "video", imageMimes: [], videoMimes: ["video/mp4", "video/quicktime", "video/webm"], maxImageBytes: 0, maxVideoBytes: 4096 * MB, videoSec: [3, 600], needsPublicUrl: false },
  YOUTUBE: { maxImages: 0, maxVideos: 1, mixMedia: false, requiresMedia: "video", imageMimes: [], videoMimes: ["video/mp4", "video/quicktime", "video/webm"], maxImageBytes: 0, maxVideoBytes: 256 * 1024 * MB, videoSec: [1, 12 * 3600], needsPublicUrl: false },
};

const count = (s: string) => [...s].length; // code points, closer to platform counting than .length
const hashtags = (s: string) => (s.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
const fmtMb = (b: number) => `${Math.round(b / MB)} MB`;

export function validatePost(platform: SocialPlatform, post: PublishInput, opts: { publicUrlsAvailable?: boolean } = {}): ValidationResult {
  const rules = PLATFORM_RULES[platform];
  const spec = SPECS[platform];
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const label = rules.label;

  const text = post.text ?? "";
  const len = count(text);
  if (len > rules.maxChars) errors.push({ code: "text_too_long", message: `${label} allows ${rules.maxChars.toLocaleString("en-US")} characters; this post has ${len.toLocaleString("en-US")}.` });
  if (!text.trim() && post.media.length === 0) errors.push({ code: "empty", message: "Add some text or media." });
  const tags = hashtags(text);
  if (tags > rules.recommendedHashtags[1]) warnings.push({ code: "many_hashtags", message: `${tags} hashtags; ${label} posts usually do best with ${rules.recommendedHashtags[0]}-${rules.recommendedHashtags[1]}.` });

  const images = post.media.filter((m) => m.kind === "IMAGE");
  const videos = post.media.filter((m) => m.kind === "VIDEO");

  if (spec.requiresMedia === "video" && videos.length === 0) errors.push({ code: "video_required", message: `${label} posts need a video.` });
  if (spec.requiresMedia === "any" && post.media.length === 0) errors.push({ code: "media_required", message: `${label} posts need at least one image or video.` });
  if (images.length > spec.maxImages) errors.push({ code: "too_many_images", message: spec.maxImages === 0 ? `${label} doesn't support image posts here.` : `${label} allows up to ${spec.maxImages} images.` });
  if (videos.length > spec.maxVideos) errors.push({ code: "too_many_videos", message: `${label} allows ${spec.maxVideos === 1 ? "one video" : `up to ${spec.maxVideos} videos`} per post.` });
  if (!spec.mixMedia && images.length && videos.length) errors.push({ code: "mixed_media", message: `${label} can't mix images and videos in one post.` });
  if (platform === "INSTAGRAM" && post.media.length > 10) errors.push({ code: "carousel_too_big", message: "Instagram carousels have at most 10 items." });

  for (const m of images) {
    if (spec.imageMimes.length && !spec.imageMimes.includes(m.mimeType)) {
      errors.push({ code: "image_format", message: `${label} needs ${spec.imageMimes.map((x) => x.split("/")[1]!.toUpperCase()).join("/")} images (got ${m.mimeType}).` });
    }
    if (m.sizeBytes && spec.maxImageBytes && m.sizeBytes > spec.maxImageBytes) errors.push({ code: "image_too_large", message: `Images on ${label} must be under ${fmtMb(spec.maxImageBytes)}.` });
    if (spec.imageAspect && m.width && m.height) {
      const r = m.width / m.height;
      if (r < spec.imageAspect[0] - 0.005 || r > spec.imageAspect[1] + 0.005) {
        errors.push({ code: "image_aspect", message: `${label} feed images must be between 4:5 and 1.91:1 (this one is ${m.width}×${m.height}).` });
      }
    }
  }
  for (const m of videos) {
    if (!spec.videoMimes.includes(m.mimeType)) errors.push({ code: "video_format", message: `${label} needs ${spec.videoMimes.map((x) => x.split("/")[1]).join("/")} video (got ${m.mimeType}).` });
    if (m.sizeBytes && m.sizeBytes > spec.maxVideoBytes) errors.push({ code: "video_too_large", message: `Videos on ${label} must be under ${fmtMb(spec.maxVideoBytes)}.` });
    if (m.durationMs != null) {
      const sec = m.durationMs / 1000;
      if (sec < spec.videoSec[0] || sec > spec.videoSec[1]) errors.push({ code: "video_duration", message: `${label} videos must be ${spec.videoSec[0]}-${spec.videoSec[1]} seconds (this one is ${sec.toFixed(1)}s).` });
    } else warnings.push({ code: "video_duration_unknown", message: "Couldn't read the video length; the platform may reject it." });
    if (m.width && m.height && (platform === "TIKTOK" || (platform === "YOUTUBE" && (m.durationMs ?? 0) <= 60_000)) && m.width > m.height) {
      warnings.push({ code: "video_orientation", message: `${label} favours vertical (9:16) video.` });
    }
  }

  if (spec.needsPublicUrl && post.media.length && opts.publicUrlsAvailable === false) {
    errors.push({ code: "needs_public_media", message: `${label} fetches media from a public URL. Configure S3/R2 storage to publish media here.` });
  }
  if (platform === "YOUTUBE") {
    const title = (post.title ?? text.split("\n")[0] ?? "").trim();
    if (!title) errors.push({ code: "title_required", message: "YouTube needs a title (the first line of the text is used)." });
    else if (count(title) > 100) errors.push({ code: "title_too_long", message: "YouTube titles are at most 100 characters (first line of the text)." });
  }

  return { ok: errors.length === 0, errors, warnings };
}
