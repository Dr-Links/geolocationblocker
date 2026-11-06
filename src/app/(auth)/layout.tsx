import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-12">
      <Link href="/" className="text-xl font-bold tracking-tight">
        Postpilot
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
