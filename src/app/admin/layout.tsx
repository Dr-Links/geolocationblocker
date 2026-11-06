import Link from "next/link";
import { requireSuperAdmin } from "@/server/tenancy/context";

/** SUPER_ADMIN gate. Middleware checks the JWT; this re-checks the DB on every request (authoritative). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireSuperAdmin();
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <Link href="/admin" className="font-bold tracking-tight">Postpilot Admin</Link>
          <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">SUPER_ADMIN</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">{admin.email}</span>
          <Link href="/dashboard" className="underline underline-offset-4">Back to app</Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4 md:p-8">{children}</main>
    </div>
  );
}
