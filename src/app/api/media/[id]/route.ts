import { NextResponse, type NextRequest } from "next/server";
import { getStorage } from "@/server/storage";
import { getTenantContext } from "@/server/tenancy/context";

export const dynamic = "force-dynamic";

/**
 * Serve a media asset to members of its workspace. RLS on ctx.db means an id
 * from another workspace simply isn't found. Supports Range for video seeking.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getTenantContext();
  const asset = await ctx.db.mediaAsset.findUnique({ where: { id } });
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const storage = getStorage();
  const signed = await storage.signedUrl(asset.storageKey, 900);
  if (signed) return NextResponse.redirect(signed, 302);

  const { body } = await storage.get(asset.storageKey);
  const headers: Record<string, string> = {
    "Content-Type": asset.mimeType,
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `inline; filename="${asset.id}"`,
  };
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const size = body.length;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return new NextResponse(new Uint8Array(body.subarray(start, end + 1)), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new NextResponse(new Uint8Array(body), { headers: { ...headers, "Content-Length": String(body.length) } });
}
