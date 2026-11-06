import Link from "next/link";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { OAuthButtons } from "../oauth-buttons";
import { SignUpForm } from "./signup-form";

export const metadata = { title: "Sign up" };
export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Create your account</CardTitle>
        <CardDescription>At least 10 characters, with a letter and a number.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <SignUpForm />
        <OAuthButtons />
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        Already have an account?&nbsp;<Link href="/login" className="text-foreground underline underline-offset-4">Log in</Link>
      </CardFooter>
    </Card>
  );
}
