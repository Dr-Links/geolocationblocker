import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className="mx-auto grid max-w-md gap-3 px-4 py-16 text-center" data-testid="not-found">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-muted-foreground">It may have been moved or deleted, or you might not have access to it.</p>
      <div className="flex justify-center"><Button asChild><Link href="/dashboard">Go to dashboard</Link></Button></div>
    </main>
  );
}
