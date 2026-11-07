"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { deleteAction, retryAction, unscheduleAction } from "../compose/actions";

export function PostActions({ postId, status, hasFailed }: { postId: string; status: string; hasFailed: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok?: boolean; message?: string; error?: string }>, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? (r.message ?? null) : (r.error ?? "Something went wrong"));
      router.refresh();
    });
  };
  const editable = ["DRAFT", "SCHEDULED", "FAILED"].includes(status);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {editable ? <Button asChild size="sm" variant="outline"><a href={`/dashboard/compose?post=${postId}`}>Edit</a></Button> : null}
      {status === "SCHEDULED" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => unscheduleAction(postId))}>Unschedule</Button> : null}
      {hasFailed && (status === "FAILED" || status === "PARTIALLY_PUBLISHED") ? <Button size="sm" disabled={busy} onClick={() => run(() => retryAction(postId))}>Retry failed</Button> : null}
      {status !== "PUBLISHING" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => deleteAction(postId), "Delete this post?")}>Delete</Button> : null}
      {msg ? <span className="text-xs text-muted-foreground" role="status">{msg}</span> : null}
    </div>
  );
}
