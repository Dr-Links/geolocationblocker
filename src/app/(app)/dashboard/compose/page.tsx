import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getComposerOptions, listRecentGenerations, toPublicGeneration } from "@/server/ai/service";
import { getPostWithMedia, listDrafts } from "@/server/services/posts";
import { NotFoundError } from "@/server/errors";
import { requireTenant } from "@/server/tenancy/context";
import { Composer } from "./composer";

export const metadata = { title: "Composer" };
export const dynamic = "force-dynamic";

export default async function ComposePage({ searchParams }: { searchParams: Promise<{ post?: string }> }) {
  const ctx = await requireTenant("content.create");
  const { post: postId } = await searchParams;
  const [options, drafts, recent] = await Promise.all([getComposerOptions(ctx), listDrafts(ctx), listRecentGenerations(ctx, 8)]);
  const post = postId ? await getPostWithMedia(ctx, postId).catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e))) : null;

  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Composer</h1>
        <p className="text-sm text-muted-foreground">Write a post, or generate captions, images and short videos with AI, then attach them.</p>
      </div>
      <Composer
        key={post?.id ?? "new"}
        options={options}
        initial={{
          postId: post?.id,
          content: post?.content ?? "",
          media: post?.media.map((m) => ({ id: m.mediaAsset.id, kind: m.mediaAsset.kind, mimeType: m.mediaAsset.mimeType })) ?? [],
        }}
        recent={recent.map(toPublicGeneration)}
      />
      <Card>
        <CardHeader><CardTitle>Recent drafts</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 text-sm" data-testid="drafts-list">
          {drafts.length === 0 ? <span className="text-muted-foreground">No drafts yet.</span> : null}
          {drafts.map((d) => (
            <Link key={d.id} href={`/dashboard/compose?post=${d.id}`} className="flex min-w-0 justify-between gap-4 rounded-md border px-3 py-2 hover:bg-accent">
              <span className="min-w-0 truncate">{d.content || <em className="text-muted-foreground">Untitled draft</em>}</span>
              <span className="shrink-0 text-muted-foreground">{d._count.media} media · {d.updatedAt.toISOString().slice(0, 10)}</span>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
