import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PLATFORM_RULES } from "@/lib/platforms";
import { describeRule } from "@/lib/recurrence";
import { formatInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { listPosts } from "@/server/scheduling/posts";
import { requireTenant } from "@/server/tenancy/context";
import { PostActions } from "./post-actions";

export const metadata = { title: "Posts" };
export const dynamic = "force-dynamic";

const TABS = [
  ["scheduled", "Scheduled", "SCHEDULED"],
  ["drafts", "Drafts", "DRAFT"],
  ["published", "Published", "PUBLISHED"],
  ["failed", "Failed", "FAILED"],
  ["all", "All", "ALL"],
] as const;

const STATUS_VARIANT: Record<string, "outline" | "secondary" | "destructive" | "default"> = {
  DRAFT: "secondary", SCHEDULED: "outline", PUBLISHING: "default", PUBLISHED: "outline", PARTIALLY_PUBLISHED: "destructive", FAILED: "destructive",
};
const TARGET_ICON: Record<string, string> = { PENDING: "⏳", PUBLISHING: "🔄", PUBLISHED: "✅", FAILED: "⛔" };
const NOTICE: Record<string, string> = { scheduled: "Scheduled. It will publish automatically.", publishing: "Publishing now. Statuses update below." };

export default async function PostsPage({ searchParams }: { searchParams: Promise<{ tab?: string; notice?: string }> }) {
  const ctx = await requireTenant("workspace.view");
  const q = await searchParams;
  const active = TABS.find((t) => t[0] === q.tab) ?? TABS[0];
  const [posts, ws] = await Promise.all([
    listPosts(ctx, active[2]),
    ctx.db.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { timezone: true } }),
  ]);
  const hasPublishing = posts.some((p) => p.status === "PUBLISHING" || p.targets.some((t) => t.status === "PUBLISHING"));

  return (
    <div className="grid grid-cols-1 gap-6">
      {/* Auto-refresh while something is publishing, so statuses update without a manual reload. */}
      {hasPublishing ? <meta httpEquiv="refresh" content="3" /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Posts</h1>
        <Link href="/dashboard/compose" className="text-sm underline underline-offset-4">New post</Link>
      </div>
      {q.notice && NOTICE[q.notice] ? <p role="status" className="rounded-md border border-green-600/30 bg-green-600/10 p-3 text-sm">{NOTICE[q.notice]}</p> : null}
      <nav className="flex flex-wrap gap-1" aria-label="Post status">
        {TABS.map(([key, label]) => (
          <Link key={key} href={`/dashboard/posts?tab=${key}`} aria-current={active[0] === key ? "page" : undefined}
            className={cn("rounded-md px-3 py-1.5 text-sm", active[0] === key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{label}</Link>
        ))}
      </nav>

      {posts.length === 0 ? <p className="text-sm text-muted-foreground">Nothing here.</p> : null}
      <div className="grid grid-cols-1 gap-3" data-testid="posts-list">
        {posts.map((p) => {
          const tz = p.schedule?.timezone ?? ws.timezone;
          return (
            <Card key={p.id} data-testid={`post-${p.id}`}>
              <CardContent className="grid gap-3 pt-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm">{p.content || <em className="text-muted-foreground">No text</em>}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <Badge variant={STATUS_VARIANT[p.status]} data-testid="post-status">{p.status.replace("_", " ").toLowerCase()}</Badge>{" "}
                      {p.status === "PUBLISHED" || p.status === "PARTIALLY_PUBLISHED"
                        ? p.publishedAt ? `published ${formatInTz(p.publishedAt, tz)}` : ""
                        : p.schedule ? `${p.status === "FAILED" ? "was due" : "for"} ${formatInTz(p.schedule.scheduledAt, tz)} (${tz})` : ""}
                      {p.schedule?.recurrenceRule ? ` · ${describeRule(p.schedule.recurrenceRule)}` : ""}
                      {p.media.length ? ` · ${p.media.length} media` : ""}
                    </p>
                  </div>
                  <PostActions postId={p.id} status={p.status} hasFailed={p.targets.some((t) => t.status === "FAILED")} />
                </div>
                {p.targets.length ? (
                  <ul className="grid gap-1 text-sm" data-testid="post-targets">
                    {p.targets.map((t) => (
                      <li key={t.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2" data-testid={`target-${t.socialAccount.platform}`}>
                        <span>{TARGET_ICON[t.status]} {PLATFORM_RULES[t.socialAccount.platform].label} · {t.socialAccount.handle ?? t.socialAccount.displayName}</span>
                        {t.externalUrl ? <a href={t.externalUrl} target="_blank" rel="noreferrer" className="text-xs underline">view post</a> : null}
                        {t.status === "PENDING" && t.nextAttemptAt ? <span className="text-xs text-muted-foreground">retrying {formatInTz(t.nextAttemptAt, tz, { timeStyle: "short" })}</span> : null}
                        {t.lastError ? <span className="min-w-0 break-words text-xs text-destructive">{t.lastError}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-muted-foreground">No accounts selected.</p>}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
