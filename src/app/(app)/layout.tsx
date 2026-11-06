import Link from "next/link";
import { CalendarDays, CreditCard, FileText, LayoutDashboard, Link2, Shield, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requireUserContext } from "@/server/session/current";
import { signOutAction } from "../(auth)/actions";

const nav = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, ready: true },
  { href: "#", label: "Composer", icon: Sparkles, ready: false },
  { href: "#", label: "Calendar", icon: CalendarDays, ready: false },
  { href: "#", label: "Posts", icon: FileText, ready: false },
  { href: "#", label: "Accounts", icon: Link2, ready: false },
  { href: "#", label: "Billing", icon: CreditCard, ready: false },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, workspace } = await requireUserContext();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 p-4 md:flex-col md:items-start">
          <div>
            <Link href="/dashboard" className="text-lg font-bold tracking-tight">Postpilot</Link>
            <p className="text-xs text-muted-foreground" data-testid="workspace-name">{workspace?.name ?? "No workspace"}</p>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-4">
          {nav.map(({ href, label, icon: Icon, ready }) =>
            ready ? (
              <Link key={label} href={href} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
                <Icon className="size-4" /> {label}
              </Link>
            ) : (
              <span key={label} className="flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground" title="Coming in a later phase">
                <Icon className="size-4" /> {label}
              </span>
            ),
          )}
          {user.platformRole === "SUPER_ADMIN" ? (
            <span className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground" title="Admin console arrives in Phase 1/6">
              <Shield className="size-4" /> Admin
            </span>
          ) : null}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b px-4 py-3">
          <span className="truncate text-sm text-muted-foreground" data-testid="user-email">{user.email}</span>
          <form action={signOutAction}>
            <Button type="submit" variant="outline" size="sm">Sign out</Button>
          </form>
        </header>
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
