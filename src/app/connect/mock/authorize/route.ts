import { NextResponse, type NextRequest } from "next/server";
import { platformSchema, redirectUriFor } from "@/server/social/accounts";
import { mockAuthCode } from "@/server/social/publishers/mock";
import { getSessionUser } from "@/server/tenancy/context";

export const dynamic = "force-dynamic";

/**
 * Simulated consent submit. A plain form POST + 303 (not a server-action
 * redirect) so the browser does a real top-level navigation to the OAuth
 * callback, exactly like a real provider. Only ever redirects to OUR callback.
 */
export async function POST(req: NextRequest) {
  const appOrigin = new URL(process.env.APP_URL ?? req.nextUrl.origin).origin;
  const origin = req.headers.get("origin");
  if (origin && origin !== appOrigin) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  if (!(await getSessionUser())) return NextResponse.redirect(new URL("/login", req.nextUrl), 303);

  const f = await req.formData();
  const parsed = platformSchema.safeParse(String(f.get("platform") ?? ""));
  if (!parsed.success) return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  const target = new URL(redirectUriFor(parsed.data));
  if (f.get("decision") !== "allow") target.searchParams.set("error", "access_denied");
  else {
    const handle = String(f.get("handle") ?? "").trim().replace(/[^\w.@-]/g, "").slice(0, 30) || "my_brand";
    target.searchParams.set("code", mockAuthCode(parsed.data, handle));
  }
  target.searchParams.set("state", String(f.get("state") ?? "").slice(0, 200));
  return NextResponse.redirect(target, 303);
}
