import { NextResponse } from "next/server";
import { getGeneration, toPublicGeneration } from "@/server/ai/service";
import { NotFoundError } from "@/server/errors";
import { getTenantContext } from "@/server/tenancy/context";

export const dynamic = "force-dynamic";

/** Poll a generation's status (composer). Tenant-scoped via RLS. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getTenantContext();
  try {
    return NextResponse.json(toPublicGeneration(await getGeneration(ctx, id)), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof NotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw err;
  }
}
