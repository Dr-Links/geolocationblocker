import { randomBytes } from "node:crypto";
import { withTenantTx } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ConflictError } from "@/server/errors";
import { enforceRateLimit, envLimit } from "@/server/rate-limit";
import { auditActor, recordAudit } from "@/server/services/audit";
import { getStorage, mediaKey } from "@/server/storage";
import { assertCan } from "@/server/tenancy/guard";
import type { TenantContext } from "@/server/tenancy/types";
import { sniffMedia } from "./sniff";

const MB = 1024 * 1024;
export const uploadLimits = () => ({
  imageBytes: envLimit("MEDIA_MAX_IMAGE_MB", 10) * MB,
  videoBytes: envLimit("MEDIA_MAX_VIDEO_MB", 200) * MB,
});

/** Max request size accepted before reading the body (largest allowed file + multipart overhead). */
export const maxUploadRequestBytes = () => uploadLimits().videoBytes + MB;

const fmtMb = (n: number) => `${Math.round(n / MB)} MB`;

/**
 * Store a user-uploaded image or video for the workspace. The file type comes
 * from the bytes; size limits are per kind; the object key is tenant-prefixed
 * and server-generated (the original file name is never used as a path).
 */
export async function uploadMedia(ctx: TenantContext, file: { bytes: Buffer; name?: string; altText?: string }) {
  assertCan(ctx, "content.create");
  await enforceRateLimit(`upload:${ctx.workspaceId}`, envLimit("RATE_LIMIT_UPLOADS_PER_HOUR", 120), 3600);
  if (!file.bytes.length) throw new ConflictError("That file is empty.");

  const info = sniffMedia(file.bytes);
  if (!info) throw new ConflictError("Unsupported file. Upload a JPEG, PNG, GIF or WebP image, or an MP4/MOV video.");
  const limits = uploadLimits();
  const max = info.kind === "IMAGE" ? limits.imageBytes : limits.videoBytes;
  if (file.bytes.length > max) throw new ConflictError(`${info.kind === "IMAGE" ? "Images" : "Videos"} can be at most ${fmtMb(max)}.`);

  const id = `ma_${randomBytes(10).toString("hex")}`;
  const key = mediaKey(ctx.workspaceId, id, info.mimeType);
  await getStorage().put(key, file.bytes, info.mimeType);
  try {
    return await withTenantTx(ctx.workspaceId, async (tx) => {
      const asset = await tx.mediaAsset.create({
        data: {
          id,
          workspaceId: ctx.workspaceId,
          createdById: ctx.userId,
          kind: info.kind,
          source: "UPLOAD",
          storageKey: key,
          mimeType: info.mimeType,
          sizeBytes: file.bytes.length,
          width: info.width,
          height: info.height,
          durationMs: info.durationMs,
          altText: file.altText?.trim().slice(0, 500) || null,
        },
      });
      await recordAudit(
        { action: "media.upload", ...auditActor(ctx), targetType: "MediaAsset", targetId: id, metadata: { kind: info.kind, mimeType: info.mimeType, sizeBytes: file.bytes.length } },
        tx,
      );
      return asset;
    });
  } catch (err) {
    // Don't leave an orphaned object if the DB write failed.
    await getStorage().delete(key).catch((e) => logger.warn({ err: e, key }, "failed to clean up orphaned upload"));
    throw err;
  }
}
