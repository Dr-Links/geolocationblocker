import type { PlatformRole } from "@prisma/client";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: { id: string; platformRole: PlatformRole; sessionVersion: number } & DefaultSession["user"];
  }
  interface User {
    platformRole?: PlatformRole;
    sessionVersion?: number;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    platformRole?: PlatformRole;
    sv?: number;
  }
}
