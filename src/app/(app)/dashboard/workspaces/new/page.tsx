import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateWorkspaceForm } from "@/components/app/create-workspace-form";

export const metadata = { title: "New workspace" };

export default function NewWorkspacePage() {
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>New workspace</CardTitle>
        <CardDescription>Each workspace has its own accounts, content, members and billing.</CardDescription>
      </CardHeader>
      <CardContent><CreateWorkspaceForm /></CardContent>
    </Card>
  );
}
