import { ZodError } from "zod";
import { unstable_rethrow } from "next/navigation";
import { logger } from "@/lib/logger";
import { AppError } from "@/server/errors";

export interface ActionState {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  values?: Record<string, string>;
  /** Action-specific payload (e.g. a freshly created invite link). */
  data?: Record<string, string>;
}

/**
 * Convert a thrown error into form state. Next.js control-flow errors
 * (redirect/notFound) are re-thrown; unknown errors are logged and masked.
 */
export function toActionState(err: unknown, values?: Record<string, string>): ActionState {
  unstable_rethrow(err);
  if (err instanceof ZodError) return { fieldErrors: err.flatten().fieldErrors as ActionState["fieldErrors"], values };
  if (err instanceof AppError) return { error: err.message, values };
  logger.error({ err }, "server action failed");
  return { error: "Something went wrong. Please try again.", values };
}
