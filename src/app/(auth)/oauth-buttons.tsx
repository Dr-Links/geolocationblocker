import { oauthProviders } from "@/auth";
import { Button } from "@/components/ui/button";
import { signInWithProviderAction } from "./actions";

export function OAuthButtons() {
  if (oauthProviders.length === 0) return null;
  return (
    <div className="grid gap-2">
      <div className="relative my-2 text-center text-xs uppercase text-muted-foreground">
        <span className="bg-card px-2">or</span>
      </div>
      {oauthProviders.map((p) => (
        <form key={p.id} action={signInWithProviderAction}>
          <input type="hidden" name="provider" value={p.id} />
          <Button type="submit" variant="outline" className="w-full">Continue with {p.name}</Button>
        </form>
      ))}
    </div>
  );
}
