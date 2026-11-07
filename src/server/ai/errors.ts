import type { AiProvider } from "@prisma/client";

/**
 * Normalized provider failure. `retryable` = worth trying the NEXT provider
 * (overload, rate limit, timeout, 5xx, bad/expired key). Non-retryable errors
 * (the request itself is invalid, or content was refused on policy grounds)
 * stop the chain: switching vendors to get around a safety refusal is not OK.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: AiProvider,
    readonly opts: { retryable: boolean; code?: string; status?: number; cause?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = "ProviderError";
  }
  get retryable() {
    return this.opts.retryable;
  }
  get code() {
    return this.opts.code;
  }
}

export class ContentRefusedError extends ProviderError {
  constructor(provider: AiProvider, detail?: string) {
    super(`The ${provider.toLowerCase()} model declined this request${detail ? ` (${detail})` : ""}. Try rephrasing the prompt.`, provider, {
      retryable: false,
      code: "refused",
    });
    this.name = "ContentRefusedError";
  }
}

/** Classify an HTTP status from any SDK into retryable / not. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network / timeout
  return status === 401 || status === 403 || status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Wrap anything thrown by an SDK into a ProviderError (keeps the original as `cause`). */
export function toProviderError(provider: AiProvider, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { status?: number; statusCode?: number; code?: string | number; message?: string; name?: string };
  const status = typeof e?.status === "number" ? e.status : typeof e?.statusCode === "number" ? e.statusCode : undefined;
  const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
  return new ProviderError(
    `${provider} error${status ? ` ${status}` : ""}: ${String(e?.message ?? err).slice(0, 300)}`,
    provider,
    { retryable: aborted || isRetryableStatus(status), status, code: aborted ? "timeout" : String(e?.code ?? status ?? "unknown"), cause: err },
  );
}
