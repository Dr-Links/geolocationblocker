import type { NextAuthConfig } from "next-auth";
import type { PlatformRole } from "@prisma/client";

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
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const isLoggedIn = !!auth?.user;
      if (pathname.startsWith("/admin")) {
        if (!isLoggedIn) return false;
        if (auth.user.platformRole !== "SUPER_ADMIN") return Response.redirect(new URL("/dashboard", request.nextUrl));
        return true;
      }
      if (pathname.startsWith("/dashboard") || pathname.startsWith("/onboarding")) return isLoggedIn;
      if (isLoggedIn && (pathname === "/login" || pathname === "/signup")) {
        return Response.redirect(new URL("/dashboard", request.nextUrl));
      }
      return true;
    },
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
