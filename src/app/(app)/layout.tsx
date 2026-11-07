import Link from "next/link";
import { CalendarDays, CreditCard, FileText, LayoutDashboard, Link2, Plus, Settings, Shield, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkspaceSwitcher } from "@/components/app/workspace-switcher";
import { getTenantContext, listMyWorkspaces } from "@/server/tenancy/context";
import { signOutAction } from "../(auth)/actions";

const nav = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, ready: true },
  { href: "/dashboard/compose", label: "Composer", icon: Sparkles, ready: true },
  { href: "#", label: "Calendar", icon: CalendarDays, ready: false },
  { href: "#", label: "Posts", icon: FileText, ready: false },
  { href: "#", label: "Accounts", icon: Link2, ready: false },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard, ready: true },
  { href: "/dashboard/settings/members", label: "Members", icon: Users, ready: true },
  { href: "/dashboard/settings", label: "Settings", icon: Settings, ready: true },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getTenantContext();
  const workspaces = await listMyWorkspaces(ctx.userId);
  const { user } = ctx;

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="grid gap-3 p-4">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight">Postpilot</Link>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <WorkspaceSwitcher workspaces={workspaces} activeId={ctx.workspaceId} />
            </div>
            <Button asChild variant="ghost" size="icon" title="New workspace">
              <Link href="/dashboard/workspaces/new" aria-label="New workspace"><Plus /></Link>
            </Button>
          </div>
          <p className="sr-only" data-testid="workspace-name">{workspaces.find((w) => w.id === ctx.workspaceId)?.name}</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-4">
          {nav.map(({ href, label, icon: Icon, ready }) =>
            ready ? (
              <Link key={label} href={href} className="flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
                <Icon className="size-4" /> {label}
              </Link>
            ) : (
              <span key={label} className="flex shrink-0 cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground" title="Coming in a later phase">
                <Icon className="size-4" /> {label}
              </span>
            ),
          )}
          {user.platformRole === "SUPER_ADMIN" ? (
            <Link href="/admin" className="flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
              <Shield className="size-4" /> Admin
            </Link>
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
