import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Postpilot</h1>
      <p className="max-w-xl text-lg text-muted-foreground">
        Generate posts, images and short videos with AI, then schedule and auto-publish them to every social account
        you manage.
      </p>
      <div className="flex gap-3">
        <Button asChild size="lg">
          <Link href="/signup">Get started</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/login">Log in</Link>
        </Button>
      </div>
    </main>
  );
}
