import { useRouter } from "@tanstack/react-router";
import { useClientSettings } from "../../hooks/useSettings";
import { T3Wordmark } from "../T3Wordmark";

export function AlternatePageBrand() {
  const router = useRouter();
  const enabled = useClientSettings((settings) => settings.alternateLayoutEnabled);
  if (!enabled && router.options.basepath !== "/layout") return null;

  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-sm font-medium tracking-tight">
      <T3Wordmark aria-label="Sora" className="size-5 shrink-0 rounded-md" />
      <span className="text-muted-foreground">Sora</span>
    </span>
  );
}
