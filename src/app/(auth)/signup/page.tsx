import Link from "next/link";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getInvitationByToken } from "@/server/services/members";
import { OAuthButtons } from "../oauth-buttons";
import { SignUpForm } from "./signup-form";

export const metadata = { title: "Sign up" };
export const dynamic = "force-dynamic";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const { invite: token } = await searchParams;
  const inv = token ? await getInvitationByToken(token) : null;
  const invite = inv?.state === "pending" ? { token: token!, email: inv.email, workspaceName: inv.workspace.name } : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{invite ? `Join ${invite.workspaceName}` : "Create your account"}</CardTitle>
        <CardDescription>
          {token && !invite ? "That invitation is no longer valid. You can still create your own workspace. " : null}
          Password: at least 10 characters, with a letter and a number.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <SignUpForm invite={invite} />
        {invite ? null : <OAuthButtons />}
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        Already have an account?&nbsp;
        <Link href={invite ? `/login?callbackUrl=/invite/${invite.token}` : "/login"} className="text-foreground underline underline-offset-4">
          Log in
        </Link>
      </CardFooter>
    </Card>
  );
}
