import { ArchiveIcon, ClockIcon, MessagesSquareIcon } from "lucide-react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const filters = [
  { value: "all", label: "All", icon: MessagesSquareIcon },
  { value: "snoozed", label: "Snoozed", icon: ClockIcon },
  { value: "settled", label: "Settled", icon: ArchiveIcon },
] as const;

export type FloatingThreadFilter = (typeof filters)[number]["value"];

export function FloatingThreadFilters({
  value,
  onChange,
  counts,
}: {
  value: FloatingThreadFilter;
  onChange: (value: FloatingThreadFilter) => void;
  counts: Record<FloatingThreadFilter, number>;
}) {
  return (
    <ToggleGroup
      aria-label="Filter threads"
      variant="default"
      size="xs"
      className="grid w-full grid-cols-3"
      value={[value]}
      onValueChange={(values) => {
        const selected = filters.find((filter) => values.includes(filter.value));
        if (selected) onChange(selected.value);
      }}
    >
      {filters.map(({ value: filter, label, icon: Icon }) => (
        <Tooltip key={filter}>
          <TooltipTrigger
            render={
              <Toggle variant="surface" value={filter} aria-label={`${label}: ${counts[filter]}`} />
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
