import { Link } from "@tanstack/react-router";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { T3Wordmark } from "../T3Wordmark";

export function AlternateSidebarHeader() {
  return (
    <div
      className={cn(
        "flex h-[var(--workspace-topbar-height)] shrink-0 items-center pr-3",
        isElectron && "drag-region",
      )}
    >
      <Link
        to="/"
        aria-label="Go to threads"
        className="ml-[var(--workspace-titlebar-content-left)] flex h-7 min-w-0 items-center rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
          <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
          <span className="truncate text-muted-foreground [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1">
            Code
          </span>
        </span>
      </Link>
    </div>
  );
}
