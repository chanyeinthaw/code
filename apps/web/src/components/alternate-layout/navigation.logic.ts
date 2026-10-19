import { resolveThreadStatusPill } from "../Sidebar.logic";

export type NavigationSection = "bots" | "threads";

export function resolveNavigationSection(
  pathname: string,
  previous: NavigationSection,
): NavigationSection {
  const path = pathname.replace(/^\/layout(?=\/|$)/, "") || "/";
  if (path === "/bots" || path.startsWith("/bots/")) return "bots";
  if (path === "/usage" || path === "/pull-requests" || /^\/settings(?:\/|$)/.test(path))
    return previous;
  return "threads";
}

type StatusThread = Parameters<typeof resolveThreadStatusPill>[0]["thread"] & {
  archivedAt: string | null;
  deletedAt: string | null;
};

export function resolveNavigationStatus(threads: ReadonlyArray<StatusThread>) {
  let working: ReturnType<typeof resolveThreadStatusPill> = null;
  let approval: ReturnType<typeof resolveThreadStatusPill> = null;
  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    const status = resolveThreadStatusPill({ thread });
    if (status?.label === "Awaiting Input") return status;
    if (status?.label === "Pending Approval") approval = status;
    if (status?.label === "Working" || status?.label === "Connecting") working = status;
  }
  return approval ?? working;
}
