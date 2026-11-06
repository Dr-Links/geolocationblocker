import { NativeSelect } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

const ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

export function TimezoneSelect({ defaultValue = "UTC", disabled, error }: { defaultValue?: string; disabled?: boolean; error?: string }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="timezone">Timezone</Label>
      <NativeSelect id="timezone" name="timezone" defaultValue={defaultValue} disabled={disabled}>
        {ZONES.map((z) => (
          <option key={z} value={z}>{z}</option>
        ))}
      </NativeSelect>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
