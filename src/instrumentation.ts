import type { Instrumentation } from "next";

/** Next.js boot hook: refuse to serve in production if RLS would be bypassed. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertRlsEnforced } = await import("@/lib/db-guard");
  await assertRlsEnforced();
  const { assertProductionConfig } = await import("@/lib/env");
  assertProductionConfig();
  if (process.env.NODE_ENV === "production" && !process.env.S3_BUCKET) {
    const { logger } = await import("@/lib/logger");
    logger.warn("No S3_BUCKET: media is stored on local disk. That only works when the app and worker share a volume (docker-compose); on Render/Fly/multiple machines configure S3 or R2.");
  }
}

/**
 * Every unhandled server error (pages, server actions, route handlers) becomes
 * one structured log line. `digest` is the reference id the error page shows
 * the user, so support can find the matching line.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger } = await import("@/lib/logger");
  const e = err as Error & { digest?: string };
  logger.error(
    { err: e, digest: e.digest, method: request.method, path: request.path.split("?")[0], routePath: context.routePath, routeType: context.routeType },
    "unhandled request error",
  );
};
