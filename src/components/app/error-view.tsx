"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Shared body for error boundaries. Shows a reference id (Next.js's digest,
 * which also appears in the server log line for this error) and never the raw
 * error message, which can contain internals in production.
 */
export function ErrorView({ error, reset, home = "/dashboard" }: { error: Error & { digest?: string }; reset: () => void; home?: string }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto grid max-w-md gap-3 py-16 text-center" role="alert" data-testid="error-boundary">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        The problem has been logged. Try again, and if it keeps happening contact support
        {error.digest ? <> with reference <code className="rounded bg-muted px-1">{error.digest}</code></> : null}.
      </p>
      <div className="flex justify-center gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline"><Link href={home}>Go home</Link></Button>
      </div>
    </div>
  );
}
