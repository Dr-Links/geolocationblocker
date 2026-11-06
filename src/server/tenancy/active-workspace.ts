import "server-only";
import { cookies } from "next/headers";
import { ACTIVE_WORKSPACE_COOKIE } from "./context";

export async function setActiveWorkspace(workspaceId: string) {
  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function clearActiveWorkspace() {
  (await cookies()).delete(ACTIVE_WORKSPACE_COOKIE);
}
