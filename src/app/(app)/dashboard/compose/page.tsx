import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { withTenantTx } from "@/lib/db";
import { describeRule } from "@/lib/recurrence";
import { formatInTz, utcToLocalInput } from "@/lib/time";
import { getComposerOptions, listRecentGenerations, toPublicGeneration } from "@/server/ai/service";
import { getEntitlements } from "@/server/billing/entitlements";
import { NotFoundError } from "@/server/errors";
import { getPost, listPosts } from "@/server/scheduling/posts";
import { parseSlots } from "@/server/scheduling/queue-slots";
import { listAccounts } from "@/server/social/accounts";
import { requireTenant } from "@/server/tenancy/context";
import { Composer } from "./composer";

export const metadata = { title: "Composer" };
export const dynamic = "force-dynamic";

const TIMEZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

export default async function ComposePage({ searchParams }: { searchParams: Promise<{ post?: string }> }) {
  const ctx = await requireTenant("content.create");
  const { post: postId } = await searchParams;
  const [options, drafts, recent, accounts, ws, ent] = await Promise.all([
    getComposerOptions(ctx),
    listPosts(ctx, "DRAFT", 10),
    listRecentGenerations(ctx, 8),
    listAccounts(ctx),
    ctx.db.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { timezone: true, queueSlots: true } }),
    withTenantTx(ctx.workspaceId, (tx) => getEntitlements(tx, ctx.workspaceId)),
  ]);
  const post = postId ? await getPost(ctx, postId).catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e))) : null;
  const tz = post?.schedule?.timezone ?? ws.timezone;
  // Default: the next round hour, at least 30 minutes away.
  const soon = new Date(Math.ceil((Date.now() + 30 * 60_000) / 3600_000) * 3600_000);

  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Composer</h1>
        <p className="text-sm text-muted-foreground">Write or generate a post, preview it per platform, then publish now, schedule it, or add it to your queue.</p>
      </div>
      <Composer
        key={post?.id ?? "new"}
        options={options}
        recent={recent.map(toPublicGeneration)}
        workspaceTz={tz}
        timezones={TIMEZONES}
        canRecur={ent.features.recurring}
        hasQueueSlots={parseSlots(ws.queueSlots).length > 0}
        defaultLocal={post?.schedule ? utcToLocalInput(post.schedule.scheduledAt, tz) : utcToLocalInput(soon, tz)}
        accounts={accounts
          .filter((a) => a.status !== "DISCONNECTED" || post?.targets.some((t) => t.socialAccountId === a.id))
          .map((a) => ({ id: a.id, platform: a.platform, label: a.handle ?? a.displayName, displayName: a.displayName, isMock: a.isMock, status: a.status }))}
        initial={{
          postId: post?.id,
          status: post?.status,
          content: post?.content ?? "",
          overrides: Object.fromEntries(Object.entries((post?.platformOverrides ?? {}) as Record<string, { content?: string }>).map(([k, v]) => [k, v.content ?? ""])),
          media: post?.media.map((m) => ({ id: m.mediaAsset.id, kind: m.mediaAsset.kind, mimeType: m.mediaAsset.mimeType, width: m.mediaAsset.width, height: m.mediaAsset.height, durationMs: m.mediaAsset.durationMs, sizeBytes: m.mediaAsset.sizeBytes })) ?? [],
          accountIds: post?.targets.map((t) => t.socialAccountId) ?? [],
          scheduledLabel: post?.schedule ? `${formatInTz(post.schedule.scheduledAt, tz)} (${tz})` : null,
          repeatLabel: describeRule(post?.schedule?.recurrenceRule),
        }}
      />
      <Card>
        <CardHeader><CardTitle>Drafts</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 text-sm" data-testid="drafts-list">
          {drafts.length === 0 ? <span className="text-muted-foreground">No drafts yet.</span> : null}
          {drafts.map((d) => (
            <Link key={d.id} href={`/dashboard/compose?post=${d.id}`} className="flex min-w-0 justify-between gap-4 rounded-md border px-3 py-2 hover:bg-accent">
              <span className="min-w-0 truncate">{d.content || <em className="text-muted-foreground">Untitled draft</em>}</span>
              <span className="shrink-0 text-muted-foreground">{d.media.length} media · {d.targets.length} account{d.targets.length === 1 ? "" : "s"}</span>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
