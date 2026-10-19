import { useRouter } from "@tanstack/react-router";
import { useClientSettings } from "../../hooks/useSettings";
import { T3Wordmark } from "../T3Wordmark";

export function AlternatePageBrand() {
  const router = useRouter();
  const enabled = useClientSettings((settings) => settings.alternateLayoutEnabled);
  if (!enabled && router.options.basepath !== "/layout") return null;

  return (
    <span className="inline-flex shrink-0 items-baseline gap-1 text-sm font-medium tracking-tight">
      <T3Wordmark aria-label="T3" className="h-[1cap] w-auto" />
      <span className="text-muted-foreground">Code</span>
    </span>
  );
}
