/** Next.js boot hook: refuse to serve in production if RLS would be bypassed. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertRlsEnforced } = await import("@/lib/db-guard");
  await assertRlsEnforced();
}
