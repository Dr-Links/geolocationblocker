import type { PlatformRole } from "@prisma/client";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: { id: string; platformRole: PlatformRole } & DefaultSession["user"];
  }
  interface User {
    platformRole?: PlatformRole;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    platformRole?: PlatformRole;
  }
}
