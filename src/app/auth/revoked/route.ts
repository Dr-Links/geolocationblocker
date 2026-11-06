import { NextResponse, type NextRequest } from "next/server";

/**
 * Where the server sends a request whose JWT is still cryptographically valid
 * but has been revoked (user disabled / sessionVersion bumped). Clears the
 * Auth.js session cookies (incl. chunked ones) so middleware stops treating
 * the browser as signed in, then goes to /login. Prevents a redirect loop.
 */
export function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/login?reason=signed-out", req.nextUrl));
  for (const { name } of req.cookies.getAll()) {
    if (/^(__Secure-|__Host-)?authjs\.session-token/.test(name) || name === "pp_ws") {
      res.cookies.set(name, "", { maxAge: 0, path: "/", secure: name.startsWith("__") });
    }
  }
  return res;
}
