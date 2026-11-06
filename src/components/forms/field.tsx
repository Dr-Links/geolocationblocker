import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Field({
  name,
  label,
  errors,
  hint,
  ...props
}: { name: string; label: string; errors?: string[]; hint?: string } & React.ComponentProps<"input">) {
  const errorId = `${name}-error`;
  return (
    <div className="grid gap-2">
      <Label htmlFor={props.id ?? name}>{label}</Label>
      <Input id={name} name={name} aria-invalid={!!errors?.length} aria-describedby={errors ? errorId : undefined} {...props} />
      {hint && !errors?.length ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {errors?.length ? (
        <p id={errorId} className="text-sm text-destructive">
          {errors[0]}
        </p>
      ) : null}
    </div>
  );
}

export function FormMessage({ state }: { state: { error?: string; message?: string } }) {
  if (state.error) return <p role="alert" className="text-sm text-destructive">{state.error}</p>;
  if (state.message) return <p role="status" className="text-sm text-muted-foreground">{state.message}</p>;
  return null;
}
