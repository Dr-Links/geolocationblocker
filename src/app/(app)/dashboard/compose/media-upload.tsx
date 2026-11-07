"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ComposerMedia } from "./types";

const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime";

/** Upload images/videos from the user's device; each one is attached as it finishes. */
export function MediaUpload({ onUploaded, disabled }: { onUploaded: (m: ComposerMedia) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    setError(null);
    for (const file of Array.from(files ?? [])) {
      setBusy((n) => n + 1);
      try {
        const body = new FormData();
        body.set("file", file);
        const res = await fetch("/api/media/upload", { method: "POST", body });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) setError(`${file.name}: ${json.error ?? "upload failed"}`);
        else onUploaded(json as ComposerMedia);
      } catch {
        setError(`${file.name}: upload failed. Check your connection and try again.`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
    if (input.current) input.current.value = "";
  }

  return (
    <div className="grid gap-1">
      <input ref={input} type="file" accept={ACCEPT} multiple className="sr-only" id="media-upload" aria-label="Upload media" onChange={(e) => upload(e.target.files)} disabled={disabled} />
      <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled || busy > 0} onClick={() => input.current?.click()}>
        <Upload className="size-4" /> {busy ? `Uploading ${busy}…` : "Upload image or video"}
      </Button>
      {error ? <p className="text-sm text-destructive" role="alert" data-testid="upload-error">{error}</p> : null}
    </div>
  );
}
