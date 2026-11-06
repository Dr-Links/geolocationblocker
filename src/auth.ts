import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";
import { authConfig } from "@/auth.config";
import { verifyCredentials } from "@/server/services/users";
import { logger } from "@/lib/logger";

const providers: Provider[] = [
  Credentials({
    credentials: { email: { label: "Email" }, password: { label: "Password", type: "password" } },
    async authorize(raw) {
      const user = await verifyCredentials(raw);
      if (!user) return null;
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        platformRole: user.platformRole,
        sessionVersion: user.sessionVersion,
      };
    },
  }),
];

// App sign-in OAuth is opt-in: only registered when credentials exist.
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) providers.push(Google);
if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) providers.push(GitHub);

export const oauthProviders = providers
  .map((p) => (typeof p === "function" ? p() : p))
  .filter((p) => p.type === "oidc" || p.type === "oauth")
  .map((p) => ({ id: p.id, name: p.name }));

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(db),
  providers,
  logger: {
    error(err) {
      // A failed login is expected behaviour, not a server error.
      if (err.name === "CredentialsSignin") logger.warn({ event: "auth.signin_failed" }, "credentials sign-in failed");
      else logger.error({ err }, "auth error");
    },
    warn(code) {
      logger.warn({ code }, "auth warning");
    },
  },
  events: {
    // OAuth sign-ups don't go through registerUser; Phase 1 gives them a workspace on first visit.
    async signIn({ user }) {
      if (user.id) await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => {});
    },
  },
});
