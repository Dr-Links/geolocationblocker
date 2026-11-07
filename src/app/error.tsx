"use client";

import { ErrorView } from "@/components/app/error-view";

export default function RootError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="px-4"><ErrorView {...props} home="/" /></main>;
}
