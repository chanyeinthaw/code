import type { RouterHistory } from "@tanstack/react-router";
import { ensureClientSettingsHydrated, getClientSettings } from "../../hooks/useSettings";

export function memoryStartupPath(pathname: string, alternateLayoutEnabled: boolean) {
  if (pathname === "/layout" || pathname === "/layout/") return "/layout/memory";
  return pathname === "/" && alternateLayoutEnabled ? "/memory" : null;
}

export async function prepareMemoryStartup(history: RouterHistory) {
  const initialHref = history.location.href;
  if (!["/", "/layout", "/layout/"].includes(history.location.pathname)) return;
  await ensureClientSettingsHydrated().catch(() => undefined);
  if (history.location.href !== initialHref) return;
  const pathname = memoryStartupPath(
    history.location.pathname,
    getClientSettings().alternateLayoutEnabled,
  );
  if (pathname) history.replace(`${pathname}${history.location.search}${history.location.hash}`);
}
