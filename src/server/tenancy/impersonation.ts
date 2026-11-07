import "server-only";
import { cookies } from "next/headers";
import { z } from "zod";
import { signToken, verifyToken } from "@/lib/signed-token";

/**
 * Support impersonation: a SUPER_ADMIN acts inside a workspace as its admin.
 * Stored in a signed, httpOnly, 60-minute cookie bound to that admin's user id.
 * Every audit entry made meanwhile carries impersonatorId; billing and API-key
 * changes are blocked (see guard.ts).
 */
export const IMPERSONATION_COOKIE = "pp_imp";
const PURPOSE = "impersonation";
export const IMPERSONATION_TTL_SEC = 60 * 60;

export interface ImpersonationToken {
  a: string; // admin user id
  w: string; // workspace id
  r: string; // reason
  s: number; // started (epoch ms)
  exp: number;
}

export const impersonationReasonSchema = z.string().trim().min(5, "Give a reason (shown in the audit log)").max(300);

export async function readImpersonation(adminId: string): Promise<ImpersonationToken | null> {
  const raw = (await cookies()).get(IMPERSONATION_COOKIE)?.value;
  const t = verifyToken<ImpersonationToken>(raw, PURPOSE);
  return t && t.a === adminId ? t : null;
}

export async function setImpersonationCookie(adminId: string, workspaceId: string, reason: string) {
  const token = signToken({ a: adminId, w: workspaceId, r: reason, s: Date.now() }, PURPOSE, IMPERSONATION_TTL_SEC);
  (await cookies()).set(IMPERSONATION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: IMPERSONATION_TTL_SEC,
  });
}

export async function clearImpersonationCookie() {
  (await cookies()).delete(IMPERSONATION_COOKIE);
}
