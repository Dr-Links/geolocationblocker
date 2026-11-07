import Link from "next/link";
import { Button } from "@/components/ui/button";

export function Pagination({ page, pages, href }: { page: number; pages: number; href: (p: number) => string }) {
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-between gap-3 text-sm" aria-label="Pagination">
      <span className="text-muted-foreground">Page {page} of {pages}</span>
      <div className="flex gap-2">
        {page > 1 ? <Button asChild size="sm" variant="outline"><Link href={href(page - 1)}>Previous</Link></Button> : null}
        {page < pages ? <Button asChild size="sm" variant="outline"><Link href={href(page + 1)}>Next</Link></Button> : null}
      </div>
    </nav>
  );
}

/** Build a query string, dropping empty values. */
export function qs(params: Record<string, string | number | undefined | null | boolean>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}
