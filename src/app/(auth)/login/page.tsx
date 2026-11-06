import Link from "next/link";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { safeRedirectPath } from "@/lib/redirect";
import { OAuthButtons } from "../oauth-buttons";
import { LoginForm } from "./login-form";

export const metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl } = await searchParams;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Log in</CardTitle>
        <CardDescription>Welcome back.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <LoginForm callbackUrl={callbackUrl ? safeRedirectPath(callbackUrl) : undefined} />
        <OAuthButtons />
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        No account?&nbsp;<Link href="/signup" className="text-foreground underline underline-offset-4">Sign up</Link>
      </CardFooter>
    </Card>
  );
}
