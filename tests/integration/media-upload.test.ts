import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, systemDb, tenantDb } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { placeholderPng } from "@/server/ai/providers/mock";
import { ConflictError } from "@/server/errors";
import { uploadMedia } from "@/server/media/upload";
import { savePost } from "@/server/scheduling/posts";
import { getStorage } from "@/server/storage";
import { cleanupTestData, ctxFor, makeTenant } from "./fixtures";

const png = placeholderPng("upload", 1080, 1080);
const mp4 = readFileSync(path.join(__dirname, "../../src/server/ai/assets/mock-vertical.mp4"));

beforeAll(cleanupTestData);
afterAll(async () => {
  await cleanupTestData();
  await db.$disconnect();
});

describe("media upload", () => {
  it("stores an image with metadata from its bytes, tenant-scoped and audited", async () => {
    const A = await makeTenant("up-a");
    const B = await makeTenant("up-b");
    const ctx = ctxFor(A.admin.id, A.workspace.id, "MEMBER");
    const asset = await uploadMedia(ctx, { bytes: png, name: "../../etc/passwd.png", altText: "  a sunset " });

    expect(asset).toMatchObject({ kind: "IMAGE", source: "UPLOAD", mimeType: "image/png", width: 1080, height: 1080, sizeBytes: png.length, altText: "a sunset" });
    // The key is server-generated and tenant-prefixed; the client's file name is ignored.
    expect(asset.storageKey).toMatch(new RegExp(`^workspaces/${A.workspace.id}/\\d{4}/\\d{2}/ma_[a-f0-9]+\\.png$`));
    expect((await getStorage().get(asset.storageKey)).body.equals(png)).toBe(true);

    expect(await tenantDb(B.workspace.id).mediaAsset.findUnique({ where: { id: asset.id } })).toBeNull();
    expect(await systemDb.auditLog.findFirst({ where: { action: "media.upload", targetId: asset.id } })).toBeTruthy();

    // Attachable to a post like generated media.
    const post = await savePost(ctx, { content: "with upload", accountIds: [A.account.id], mediaAssetIds: [asset.id] });
    expect(await tenantDb(A.workspace.id).postMedia.count({ where: { postId: post.id } })).toBe(1);
    // …but not to another workspace's post.
    const ctxB = ctxFor(B.admin.id, B.workspace.id, "WORKSPACE_ADMIN");
    await expect(savePost(ctxB, { content: "steal", accountIds: [B.account.id], mediaAssetIds: [asset.id] })).rejects.toThrow();
  });

  it("reads video dimensions and duration", async () => {
    const t = await makeTenant("up-video");
    const v = await uploadMedia(ctxFor(t.admin.id, t.workspace.id, "WORKSPACE_ADMIN"), { bytes: mp4 });
    expect(v).toMatchObject({ kind: "VIDEO", mimeType: "video/mp4", width: 540, height: 960, durationMs: 4000 });
  });

  it("rejects disguised, empty and oversized files without storing anything", async () => {
    const t = await makeTenant("up-reject");
    const ctx = ctxFor(t.admin.id, t.workspace.id, "WORKSPACE_ADMIN");
    await expect(uploadMedia(ctx, { bytes: Buffer.from("<svg><script>alert(1)</script></svg>"), name: "cat.png" })).rejects.toThrow(/Unsupported file/);
    await expect(uploadMedia(ctx, { bytes: Buffer.alloc(0) })).rejects.toBeInstanceOf(ConflictError);

    process.env.MEDIA_MAX_IMAGE_MB = "0.001"; // ~1 KB
    try {
      await expect(uploadMedia(ctx, { bytes: png })).rejects.toThrow(/Images can be at most/);
    } finally {
      delete process.env.MEDIA_MAX_IMAGE_MB;
    }
    expect(await tenantDb(t.workspace.id).mediaAsset.count({ where: { createdById: t.admin.id } })).toBe(0); // the fixture asset has no creator
  });

  it("is rate-limited per workspace", async () => {
    const t = await makeTenant("up-rl");
    const ctx = ctxFor(t.admin.id, t.workspace.id, "WORKSPACE_ADMIN");
    process.env.RATE_LIMIT_UPLOADS_PER_HOUR = "2";
    try {
      await uploadMedia(ctx, { bytes: png });
      await uploadMedia(ctx, { bytes: png });
      await expect(uploadMedia(ctx, { bytes: png })).rejects.toThrow(/Too many/);
    } finally {
      delete process.env.RATE_LIMIT_UPLOADS_PER_HOUR;
      await getRedis().del(`rl:upload:${t.workspace.id}`);
    }
  });
});
