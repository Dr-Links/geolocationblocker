import { NextResponse, type NextRequest } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { logger } from "@/lib/logger";
import { AppError } from "@/server/errors";
import { OAUTH_COOKIE, completeConnect } from "@/server/social/accounts";
import { PublishError } from "@/server/social/types";
import { getTenantContext } from "@/server/tenancy/context";

export const dynamic = "force-dynamic";

/** OAuth redirect target for every platform (and the mock consent screen). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const q = req.nextUrl.searchParams;
  const back = new URL("/dashboard/accounts", req.nextUrl);
  try {
    const ctx = await getTenantContext();
    const r = await completeConnect(ctx, platform, { code: q.get("code"), state: q.get("state"), error: q.get("error"), cookie: req.cookies.get(OAUTH_COOKIE)?.value });
    back.searchParams.set("connected", r.connected.join(", "));
    if (r.skipped.length) back.searchParams.set("skipped", r.skipped.join(", "));
  } catch (err) {
    unstable_rethrow(err); // let Next.js redirects (e.g. to /login) through
    const known = err instanceof AppError || err instanceof PublishError;
    if (!known) logger.error({ err, platform }, "social connect callback failed");
    back.searchParams.set("error", known ? (err as Error).message : "Couldn't connect the account. Please try again.");
  }
  const res = NextResponse.redirect(back);
  res.cookies.set(OAUTH_COOKIE, "", { path: "/api/social", maxAge: 0 });
  return res;
}
