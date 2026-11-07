import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig, gate } from "@/auth.config";
import { buildCsp } from "@/lib/csp";

const { auth } = NextAuth(authConfig);

/**
 * Runs on every page request:
 *  1. coarse auth gate from the JWT (authoritative checks happen server-side);
 *  2. a per-request CSP nonce, passed to Next.js via the request header so it
 *     can stamp its own scripts, and set on the response.
 */
export default auth((req) => {
  const blocked = gate(req.auth, req.nextUrl);
  if (blocked) return blocked;

  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development" });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("content-security-policy", csp);
  if (process.env.NODE_ENV === "production" && process.env.APP_URL?.startsWith("https://")) {
    res.headers.set("strict-transport-security", "max-age=63072000; includeSubDomains");
  }
  return res;
});

export const config = {
  // Pages only: skip API routes, Next.js assets and static files.
  matcher: [{ source: "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|txt)$).*)" }],
};
