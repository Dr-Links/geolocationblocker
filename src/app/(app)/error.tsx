"use client";

import { ErrorView } from "@/components/app/error-view";

/** Errors inside the signed-in app keep the sidebar/navigation usable. */
export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView {...props} />;
}
