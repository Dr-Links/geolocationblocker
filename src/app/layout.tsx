import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Postpilot", template: "%s · Postpilot" },
  description: "Generate, schedule and auto-publish social content with AI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
