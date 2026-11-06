import type { NextAuthConfig } from "next-auth";
import type { PlatformRole } from "@prisma/client";

/**
 * Edge-safe Auth.js config (no Prisma / bcrypt) — used by middleware.
 * Providers that need the DB are added in src/auth.ts.
 */
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const isLoggedIn = !!auth?.user;
      if (pathname.startsWith("/admin")) return auth?.user?.platformRole === "SUPER_ADMIN";
      if (pathname.startsWith("/dashboard")) return isLoggedIn;
      if (isLoggedIn && (pathname === "/login" || pathname === "/signup")) {
        return Response.redirect(new URL("/dashboard", request.nextUrl));
      }
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.platformRole = (user as { platformRole?: PlatformRole }).platformRole ?? "USER";
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      session.user.platformRole = (token.platformRole as PlatformRole) ?? "USER";
      return session;
    },
  },
} satisfies NextAuthConfig;
