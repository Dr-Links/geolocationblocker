import { NextResponse } from "next/server";
import { apiHandler } from "@/server/api";
import { getGeneration, toPublicGeneration } from "@/server/ai/service";
import { getTenantContext } from "@/server/tenancy/context";

export const dynamic = "force-dynamic";

/** Poll a generation's status (composer). Tenant-scoped via RLS. */
export const GET = apiHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const ctx = await getTenantContext();
  return NextResponse.json(toPublicGeneration(await getGeneration(ctx, id)), { headers: { "Cache-Control": "no-store" } });
});
