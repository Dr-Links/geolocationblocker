import { NextResponse, type NextRequest } from "next/server";
import { apiHandler } from "@/server/api";
import { ConflictError, ForbiddenError } from "@/server/errors";
import { maxUploadRequestBytes, uploadMedia } from "@/server/media/upload";
import { getTenantContext } from "@/server/tenancy/context";

export const dynamic = "force-dynamic";

/**
 * Upload one image/video (multipart field "file"). A route handler rather than
 * a Server Action because Server Action bodies are capped at 1 MB. Route
 * handlers don't get Next.js's built-in Origin check, so it's done here
 * (session cookies are SameSite=Lax too, which already blocks cross-site POSTs).
 */
export const POST = apiHandler(async (req: NextRequest) => {
  const appOrigin = new URL(process.env.APP_URL ?? req.nextUrl.origin).origin;
  const origin = req.headers.get("origin");
  if (!origin || origin !== appOrigin) throw new ForbiddenError("Bad origin");

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxUploadRequestBytes()) throw new ConflictError("That file is too large.");

  const ctx = await getTenantContext();
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ConflictError("Choose a file to upload.");
  const asset = await uploadMedia(ctx, { bytes: Buffer.from(await file.arrayBuffer()), name: file.name, altText: String(form.get("altText") ?? "") });
  return NextResponse.json(
    { id: asset.id, kind: asset.kind, mimeType: asset.mimeType, width: asset.width, height: asset.height, durationMs: asset.durationMs, sizeBytes: asset.sizeBytes },
    { status: 201 },
  );
});
