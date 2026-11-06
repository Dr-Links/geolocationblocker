import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Field({
  name,
  label,
  errors,
  ...props
}: { name: string; label: string; errors?: string[] } & React.ComponentProps<"input">) {
  const errorId = `${name}-error`;
  return (
    <div className="grid gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} aria-invalid={!!errors?.length} aria-describedby={errors ? errorId : undefined} {...props} />
      {errors?.length ? (
        <p id={errorId} className="text-sm text-destructive">
          {errors[0]}
        </p>
      ) : null}
    </div>
  );
}
