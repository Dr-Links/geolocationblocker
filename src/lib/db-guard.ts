import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Row-level security is skipped for superusers and BYPASSRLS roles. Verify the
 * runtime connection is a plain role, so tenant isolation is actually enforced.
 * Throws in production; warns elsewhere.
 */
export async function assertRlsEnforced(): Promise<{ ok: boolean; role: string }> {
  const rows = await db.$queryRaw<{ role: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  const r = rows[0];
  const ok = !!r && !r.rolsuper && !r.rolbypassrls;
  if (!ok) {
    const msg = `DATABASE_URL role "${r?.role}" bypasses row-level security; tenant isolation is NOT enforced. Use a non-superuser member of app_user.`;
    if (process.env.NODE_ENV === "production") throw new Error(msg);
    logger.warn({ role: r?.role }, msg);
  }
  return { ok, role: r?.role ?? "unknown" };
}
