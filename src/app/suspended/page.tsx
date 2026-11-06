import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CenteredShell } from "@/components/app/centered-shell";

export const metadata = { title: "Workspace suspended" };

export default function SuspendedPage() {
  return (
    <CenteredShell>
      <Card>
        <CardHeader>
          <CardTitle>Workspace suspended</CardTitle>
          <CardDescription>This workspace has been suspended by the platform administrator. Contact support for help.</CardDescription>
        </CardHeader>
      </Card>
    </CenteredShell>
  );
}
