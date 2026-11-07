import type { NextAuthConfig } from "next-auth";
import type { PlatformRole } from "@prisma/client";

type Gatekeeper = { user?: { platformRole?: PlatformRole } } | null;

/**
 * Coarse route gate used by middleware, based only on the JWT: returns a
 * redirect, or null to let the request through.
 */
export function gate(auth: Gatekeeper, url: URL): Response | null {
  const { pathname } = url;
  const isLoggedIn = !!auth?.user;
  const toLogin = () => {
    const login = new URL("/login", url);
    login.searchParams.set("callbackUrl", pathname + url.search);
    return Response.redirect(login);
  };
  if (pathname.startsWith("/admin")) {
    if (!isLoggedIn) return toLogin();
    if (auth!.user!.platformRole !== "SUPER_ADMIN") return Response.redirect(new URL("/dashboard", url));
    return null;
  }
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/onboarding")) return isLoggedIn ? null : toLogin();
  if (isLoggedIn && (pathname === "/login" || pathname === "/signup")) return Response.redirect(new URL("/dashboard", url));
  return null;
}

/**
 * Edge-safe Auth.js config (no Prisma / bcrypt), used by middleware.
 *
 * Middleware is only a coarse first gate based on the JWT. The authoritative
 * checks (disabled user, revoked session, current role, membership) happen
 * server-side against the DB in src/server/tenancy/context.ts.
 */
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        const u = user as { platformRole?: PlatformRole; sessionVersion?: number };
        token.sub = user.id;
        token.platformRole = u.platformRole ?? "USER";
        token.sv = u.sessionVersion ?? 0;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      session.user.platformRole = (token.platformRole as PlatformRole) ?? "USER";
      session.user.sessionVersion = (token.sv as number) ?? 0;
      return session;
    },
  },
} satisfies NextAuthConfig;
