import type { RouterHistory } from "@tanstack/react-router";
import { ensureClientSettingsHydrated, getClientSettings } from "../../hooks/useSettings";

export function botStartupPath(pathname: string, alternateLayoutEnabled: boolean) {
  if (pathname === "/layout" || pathname === "/layout/") return "/layout/bot";
  return pathname === "/" && alternateLayoutEnabled ? "/bots" : null;
}

export async function prepareBotStartup(history: RouterHistory) {
  const initialHref = history.location.href;
  if (!["/", "/layout", "/layout/"].includes(history.location.pathname)) return;
  await ensureClientSettingsHydrated().catch(() => undefined);
  if (history.location.href !== initialHref) return;
  const pathname = botStartupPath(
    history.location.pathname,
    getClientSettings().alternateLayoutEnabled,
  );
  if (pathname) history.replace(`${pathname}${history.location.search}${history.location.hash}`);
}
