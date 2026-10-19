import { updateClientSettings } from "../../hooks/useSettings";
import { isElectron } from "../../env";

export async function setAlternateLayoutEnabled(enabled: boolean) {
  await updateClientSettings({ alternateLayoutEnabled: enabled });
  if (enabled) return;
  const url = new URL(window.location.href);
  const route = isElectron ? url.hash.slice(1) : url.pathname;
  if (!/^\/layout(?:\/|$)/.test(route)) return;
  const originalRoute = route.replace(/^\/layout/, "") || "/";
  if (isElectron) {
    url.hash = originalRoute;
    window.location.replace(url.href);
    window.location.reload();
  } else {
    url.pathname = originalRoute;
    window.location.replace(url.href);
  }
}
