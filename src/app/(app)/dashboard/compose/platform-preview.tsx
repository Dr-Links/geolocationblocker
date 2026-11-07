"use client";

import { PLATFORM_RULES } from "@/lib/platforms";
import { cn } from "@/lib/utils";
import { validatePost } from "@/server/social/validation";
import type { SocialPlatform } from "@prisma/client";
import { MediaPreview } from "./media-preview";
import type { ComposerMedia, TargetAccount } from "./types";

/** Where each platform truncates the feed text behind "…more". */
const FOLD: Partial<Record<SocialPlatform, number>> = { INSTAGRAM: 125, FACEBOOK: 480, LINKEDIN: 210, TIKTOK: 100 };
const ACCENT: Record<string, string> = { X: "bg-black", INSTAGRAM: "bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600", FACEBOOK: "bg-blue-600", LINKEDIN: "bg-sky-700", TIKTOK: "bg-zinc-900", YOUTUBE: "bg-red-600" };

/** Renders a post roughly as it will look on the platform, plus live validation from the shared rules. */
export function PlatformPreview({ account, text, media }: { account: TargetAccount; text: string; media: ComposerMedia[] }) {
  const platform = account.platform as SocialPlatform;
  const rules = PLATFORM_RULES[platform];
  // Bytes are never needed to validate; the loader just refuses (no Buffer in the browser).
  const v = validatePost(platform, { text, media: media.map((m) => ({ ...m, load: () => Promise.reject(new Error("not loaded in preview")) })) }, { publicUrlsAvailable: true });
  const chars = [...text].length;
  const fold = FOLD[platform];
  const folded = fold && chars > fold ? `${[...text].slice(0, fold).join("")}… ` : null;
  const isVideoPlatform = platform === "TIKTOK" || platform === "YOUTUBE";
  const ytTitle = platform === "YOUTUBE" ? (text.split("\n")[0] ?? "") : null;

  return (
    <div className={cn("grid min-w-0 content-start gap-2 rounded-lg border p-3", !v.ok && "border-destructive/50")} data-testid={`preview-${platform}`}>
      <div className="flex items-center gap-2">
        <span className={cn("size-7 shrink-0 rounded-full", ACCENT[platform])} aria-hidden />
        <div className="min-w-0 text-sm leading-tight">
          <p className="truncate font-semibold">{account.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{rules.label} · {account.label}{account.isMock ? " (mock)" : ""}</p>
        </div>
      </div>

      {media.length ? (
        <div className={cn("grid gap-1", media.length > 1 && !isVideoPlatform ? "grid-cols-2" : "grid-cols-1")}>
          {media.slice(0, isVideoPlatform ? 1 : 4).map((m) => (
            <MediaPreview key={m.id} m={m} className={cn("w-full", platform === "INSTAGRAM" ? "aspect-[4/5]" : isVideoPlatform ? "aspect-[9/16] max-h-64" : "aspect-video")} />
          ))}
        </div>
      ) : null}

      {ytTitle !== null ? <p className="text-sm font-semibold">{ytTitle || <span className="text-muted-foreground">(title: first line)</span>}</p> : null}
      <p className="whitespace-pre-wrap break-words text-sm">
        {(ytTitle !== null ? text.split("\n").slice(1).join("\n") : folded ?? text) || <span className="text-muted-foreground">Your post text…</span>}
        {folded ? <span className="text-muted-foreground">more</span> : null}
      </p>

      <p className={cn("text-xs tabular-nums", chars > rules.maxChars ? "text-destructive" : "text-muted-foreground")} data-testid={`chars-${platform}`}>
        {chars.toLocaleString("en-US")} / {rules.maxChars.toLocaleString("en-US")}
      </p>
      {v.errors.map((e) => <p key={e.code} className="text-xs text-destructive">⛔ {e.message}</p>)}
      {v.warnings.map((w) => <p key={w.code} className="text-xs text-muted-foreground">⚠️ {w.message}</p>)}
      {v.ok && !v.warnings.length ? <p className="text-xs text-green-700 dark:text-green-500">✓ Ready for {rules.label}</p> : null}
    </div>
  );
}
