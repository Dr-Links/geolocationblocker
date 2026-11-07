import { z } from "zod";
import { withTenantTx } from "@/lib/db";
import { assertWithinLimit } from "@/server/billing/entitlements";
import { NotFoundError } from "@/server/errors";
import { assertCan } from "@/server/tenancy/guard";
import type { TenantContext } from "@/server/tenancy/types";

/** Draft posts (Phase 3: compose + attach media). Scheduling arrives in Phase 5. */

export const draftSchema = z.object({
  postId: z.string().min(8).max(64).optional(),
  content: z.string().max(63_206, "Post is too long").default(""),
  mediaAssetIds: z.array(z.string().min(8).max(64)).max(10, "Attach at most 10 files").default([]),
});
export type DraftInput = z.input<typeof draftSchema>;

export async function saveDraft(ctx: TenantContext, input: DraftInput) {
  assertCan(ctx, "content.create");
  const data = draftSchema.parse(input);
  const mediaIds = [...new Set(data.mediaAssetIds)];
  return withTenantTx(ctx.workspaceId, async (tx) => {
    // RLS hides other tenants' media, so foreign ids simply don't match.
    const found = await tx.mediaAsset.count({ where: { id: { in: mediaIds } } });
    if (found !== mediaIds.length) throw new NotFoundError("Some attached media no longer exists");

    if (data.postId) {
      const post = await tx.post.findUnique({ where: { id: data.postId } });
      if (!post) throw new NotFoundError("Post not found");
      await tx.postMedia.deleteMany({ where: { postId: post.id } });
      return tx.post.update({
        where: { id: post.id },
        data: { content: data.content, media: { create: mediaIds.map((mediaAssetId, order) => ({ mediaAssetId, order })) } },
      });
    }
    await assertWithinLimit(tx, ctx.workspaceId, "maxPostsPerMonth");
    return tx.post.create({
      data: {
        workspaceId: ctx.workspaceId,
        authorId: ctx.userId,
        content: data.content,
        status: "DRAFT",
        media: { create: mediaIds.map((mediaAssetId, order) => ({ mediaAssetId, order })) },
      },
    });
  });
}

export async function getPostWithMedia(ctx: TenantContext, postId: string) {
  const post = await ctx.db.post.findUnique({
    where: { id: postId },
    include: { media: { orderBy: { order: "asc" }, include: { mediaAsset: true } } },
  });
  if (!post) throw new NotFoundError("Post not found");
  return post;
}

export async function listDrafts(ctx: TenantContext, take = 10) {
  return ctx.db.post.findMany({
    where: { workspaceId: ctx.workspaceId, status: "DRAFT" },
    orderBy: { updatedAt: "desc" },
    take,
    include: { _count: { select: { media: true } } },
  });
}
