"use client";

/** Last-resort boundary (the root layout itself failed): no app CSS or components. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1rem", textAlign: "center" }}>
        <h1>Something went wrong</h1>
        <p>Please try again.{error.digest ? ` Reference: ${error.digest}` : ""}</p>
        <button onClick={reset} style={{ padding: "0.5rem 1rem" }}>Try again</button>
      </body>
    </html>
  );
}
