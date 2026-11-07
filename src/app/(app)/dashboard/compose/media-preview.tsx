import { cn } from "@/lib/utils";

export function MediaPreview({ m, className }: { m: { id: string; kind: string }; className?: string }) {
  return m.kind === "VIDEO" ? (
    <video src={`/api/media/${m.id}`} className={cn("rounded-md bg-muted object-cover", className)} controls muted playsInline preload="metadata" />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/media/${m.id}`} alt="Attached media" className={cn("rounded-md bg-muted object-cover", className)} />
  );
}
