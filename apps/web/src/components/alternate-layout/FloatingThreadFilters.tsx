import { ArchiveIcon, ClockIcon, HammerIcon, MessagesSquareIcon } from "lucide-react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const filters = [
  { value: "all", label: "All", icon: MessagesSquareIcon },
  { value: "working", label: "Working", icon: HammerIcon },
  { value: "snoozed", label: "Snoozed", icon: ClockIcon },
  { value: "settled", label: "Settled", icon: ArchiveIcon },
] as const;

export type FloatingThreadFilter = (typeof filters)[number]["value"];

export function FloatingThreadFilters({
  value,
  onChange,
  counts,
  workingEnabled,
}: {
  value: FloatingThreadFilter;
  onChange: (value: FloatingThreadFilter) => void;
  counts: Record<FloatingThreadFilter, number>;
  workingEnabled: boolean;
}) {
  return (
    <ToggleGroup
      aria-label="Filter threads"
      variant="default"
      size="xs"
      className={workingEnabled ? "grid w-full grid-cols-4" : "grid w-full grid-cols-3"}
      value={[value]}
      onValueChange={(values) => {
        const selected = filters.find((filter) => values.includes(filter.value));
        if (selected) onChange(selected.value);
      }}
    >
      {filters
        .filter((filter) => workingEnabled || filter.value !== "working")
        .map(({ value: filter, label, icon: Icon }) => (
          <Tooltip key={filter}>
            <TooltipTrigger
              render={
                <Toggle
                  variant="surface"
                  value={filter}
                  aria-label={`${label}: ${counts[filter]}`}
                />
              }
            >
              <Icon className="size-3.5" />
              <span className="text-xs tabular-nums">{counts[filter]}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        ))}
    </ToggleGroup>
  );
}
