import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { logger } from "@/lib/logger";
import { AppError, RateLimitError } from "@/server/errors";

/**
 * Wrap a route handler so errors become consistent JSON:
 * AppError → its status + safe message; ZodError → 400 with field errors;
 * anything else → logged, masked 500. Next.js redirects/notFound pass through.
 */
export function apiHandler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      unstable_rethrow(err);
      if (err instanceof AppError) {
        const headers: Record<string, string> = { "Cache-Control": "no-store" };
        if (err instanceof RateLimitError) headers["Retry-After"] = String(err.retryAfterSec);
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers });
      }
      if (err instanceof ZodError) {
        return NextResponse.json({ error: "Invalid request", code: "INVALID", fieldErrors: err.flatten().fieldErrors }, { status: 400 });
      }
      logger.error({ err }, "route handler failed");
      return NextResponse.json({ error: "Something went wrong", code: "INTERNAL" }, { status: 500 });
    }
  };
}
