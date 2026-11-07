import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "@/lib/logger";

/**
 * Object storage for generated/uploaded media.
 *  - S3Storage: AWS S3 or Cloudflare R2 (S3_BUCKET + keys set).
 *  - LocalStorage (default): files under STORAGE_LOCAL_DIR (./.data/media).
 * The app always serves media through /api/media/[id], which checks tenant
 * access first; S3 then redirects to a short-lived signed URL.
 */
export interface Storage {
  readonly name: "s3" | "local";
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Buffer; contentType?: string }>;
  size(key: string): Promise<number>;
  /** Short-lived URL a browser (or a social platform) can fetch directly; null when not supported. */
  signedUrl(key: string, expiresInSec?: number): Promise<string | null>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-zA-Z0-9/_.-]+$/;
function assertKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.startsWith("/")) throw new Error(`Unsafe storage key: ${key}`);
}

export class LocalStorage implements Storage {
  readonly name = "local" as const;
  constructor(private readonly root = path.resolve(process.env.STORAGE_LOCAL_DIR || ".data/media")) {}
  private file(key: string) {
    assertKey(key);
    return path.join(this.root, key);
  }
  async put(key: string, body: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body);
  }
  async get(key: string) {
    return { body: await readFile(this.file(key)) };
  }
  async size(key: string) {
    return (await stat(this.file(key))).size;
  }
  async signedUrl() {
    return null;
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
}

export class S3Storage implements Storage {
  readonly name = "s3" as const;
  private readonly client: S3Client;
  constructor(private readonly bucket: string) {
    this.client = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT, // R2/MinIO
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    assertKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    assertKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { body: Buffer.from(await res.Body!.transformToByteArray()), contentType: res.ContentType };
  }
  async size(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: "bytes=0-0" }));
    return Number(res.ContentRange?.split("/")[1] ?? 0);
  }
  async signedUrl(key: string, expiresInSec = 900) {
    assertKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSec });
  }
  async delete(key: string) {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let storage: Storage | undefined;

export function getStorage(): Storage {
  if (!storage) {
    const bucket = process.env.S3_BUCKET?.trim();
    storage = bucket && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY ? new S3Storage(bucket) : new LocalStorage();
    logger.info({ storage: storage.name }, "media storage selected");
  }
  return storage;
}

export function setStorageForTests(s: Storage | undefined) {
  storage = s;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
export const extFor = (mime: string) => EXT[mime] ?? "bin";

/** workspaces/<ws>/<yyyy>/<mm>/<assetId>.<ext>; tenant-prefixed so bucket policies can scope by workspace too. */
export function mediaKey(workspaceId: string, assetId: string, mime: string, now = new Date()) {
  return `workspaces/${workspaceId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${assetId}.${extFor(mime)}`;
}
