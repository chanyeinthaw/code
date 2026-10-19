import { useId } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { useEnvironments } from "../../state/environments";
import { Label } from "../ui/label";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

export function MemoryEnvironmentSelect({
  label,
  environments,
  value,
  disabled,
  onChange,
}: {
  label: string;
  environments: ReturnType<typeof useEnvironments>["environments"];
  value: EnvironmentId | null;
  disabled: boolean;
  onChange: (environmentId: EnvironmentId) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        disabled={disabled || environments.length === 0}
        onValueChange={(next) => {
          const environment = environments.find((item) => item.environmentId === next);
          if (environment) onChange(environment.environmentId);
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue>
            {environments.find((item) => item.environmentId === value)?.label ??
              "Select environment"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {environments.map((environment) => (
            <SelectItem key={environment.environmentId} value={environment.environmentId}>
              {environment.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
