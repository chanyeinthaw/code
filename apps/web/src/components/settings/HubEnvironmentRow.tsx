import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";

/** Hub-owned copy of the upstream row adds installation identity without changing Connections. */
export function HubEnvironmentRow({
  kind,
  label,
  thisEnvironment = false,
  subtitle,
  below,
  detail,
  dimmed = false,
  className,
  children,
}: {
  readonly kind: EnvironmentMachineKind;
  readonly label: string;
  readonly thisEnvironment?: boolean;
  readonly subtitle: ReactNode;
  /** Extra content under the subtitle, such as update progress. */
  readonly below?: ReactNode;
  /** Expanded content under the whole row, aligned with the label, such as its routes. */
  readonly detail?: ReactNode;
  readonly dimmed?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 sm:px-4",
        dimmed && "opacity-60",
        className,
      )}
    >
      <EnvironmentMachineIcon aria-hidden kind={kind} className="size-4 text-muted-foreground" />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{label}</p>
          {thisEnvironment ? (
            <Badge variant="secondary" size="sm">
              This environment
            </Badge>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        {below}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
      {detail ? <div className="col-span-2 col-start-2 min-w-0">{detail}</div> : null}
    </div>
  );
}
