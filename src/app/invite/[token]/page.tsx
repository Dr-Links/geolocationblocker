import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CenteredShell } from "@/components/app/centered-shell";
import { getInvitationByToken } from "@/server/services/members";
import { getSessionUser } from "@/server/tenancy/context";
import { AcceptInviteForm } from "./accept-form";

export const metadata = { title: "Invitation" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [inv, user] = await Promise.all([getInvitationByToken(token), getSessionUser()]);

  if (!inv || inv.state !== "pending") {
    return (
      <CenteredShell>
        <Card>
          <CardHeader>
            <CardTitle>Invitation unavailable</CardTitle>
            <CardDescription>
              {inv?.state === "accepted" ? "This invitation was already used." : "This invitation is invalid, revoked, or expired. Ask the workspace admin for a new one."}
            </CardDescription>
          </CardHeader>
          <CardContent><Button asChild variant="outline"><Link href="/dashboard">Go to dashboard</Link></Button></CardContent>
        </Card>
      </CenteredShell>
    );
  }

  const inviter = inv.invitedBy?.name ?? inv.invitedBy?.email ?? "A teammate";
  const roleText = inv.role === "WORKSPACE_ADMIN" ? "an admin" : "a member";
  const emailMatches = user && user.email.toLowerCase() === inv.email.toLowerCase();

  return (
    <CenteredShell>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Join {inv.workspace.name}</CardTitle>
          <CardDescription>{inviter} invited <strong>{inv.email}</strong> to join as {roleText}.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!user ? (
            <>
              <Button asChild><Link href={`/signup?invite=${token}`}>Create an account to accept</Link></Button>
              <Button asChild variant="outline"><Link href={`/login?callbackUrl=/invite/${token}`}>I already have an account</Link></Button>
            </>
          ) : emailMatches ? (
            <AcceptInviteForm token={token} workspaceName={inv.workspace.name} />
          ) : (
            <p className="text-sm text-destructive" role="alert">
              You&apos;re signed in as {user.email}. This invitation is for {inv.email}. Sign out and sign in with that email to accept.
            </p>
          )}
        </CardContent>
      </Card>
    </CenteredShell>
  );
}
