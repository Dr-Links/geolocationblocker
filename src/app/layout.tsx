import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Postpilot", template: "%s · Postpilot" },
  description: "Generate, schedule and auto-publish social content with AI.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the per-request CSP nonce (set by middleware) opts every page into
  // dynamic rendering, so Next.js can stamp the nonce on its scripts. A
  // statically prerendered page would carry no nonce and be blocked by the CSP.
  await headers();
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
