import { NextResponse, type NextRequest } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { logger } from "@/lib/logger";
import { AppError } from "@/server/errors";
import { OAUTH_COOKIE, startConnect } from "@/server/social/accounts";
import { getTenantContext } from "@/server/tenancy/context";

export const dynamic = "force-dynamic";

/** Begin OAuth: bind state + PKCE to this user/workspace in a signed cookie, then redirect to the platform. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const ctx = await getTenantContext();
  const back = new URL("/dashboard/accounts", req.nextUrl);
  try {
    const { url, cookie } = await startConnect(ctx, platform);
    const res = NextResponse.redirect(url);
    // Lax: sent on the platform's top-level redirect back to our callback.
    res.cookies.set(OAUTH_COOKIE, cookie, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/social", maxAge: 600 });
    return res;
  } catch (err) {
    unstable_rethrow(err); // let Next.js redirects (e.g. to /login) through
    if (!(err instanceof AppError)) logger.error({ err, platform }, "social connect start failed");
    back.searchParams.set("error", err instanceof AppError ? err.message : "Couldn't start the connection");
    return NextResponse.redirect(back);
  }
}
