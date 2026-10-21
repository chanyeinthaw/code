import { backgroundWorkHoldsCompletion } from "@satslab/shared/orchestrationV2PendingBackgroundWork";
import { scopedThreadKey, scopeThreadRef } from "@satslab/client-runtime/environment";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";

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

type StatusThread = Pick<
  SidebarThreadSummary,
  | "environmentId"
  | "id"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "blockedOnThreadWait"
  | "pendingBackgroundTasks"
  | "runtime"
  | "latestRun"
  | "lastVisitedAt"
  | "hasActionableProposedPlan"
  | "interactionMode"
> & {
  archivedAt: unknown;
  deletedAt: unknown;
};

export type NavigationStatusKind = "input" | "approval" | "done" | "working" | "waiting";

// Border colors match the thread row's top-status colors (SidebarThreadRow).
export const NAVIGATION_STATUS_BORDER_CLASS: Record<NavigationStatusKind, string> = {
  input: "border-indigo-600 dark:border-indigo-300",
  approval: "border-warning-foreground",
  done: "border-success",
  working: "border-info",
  waiting: "border-muted-foreground",
};

export const NAVIGATION_STATUS_LABEL: Record<NavigationStatusKind, string> = {
  input: "Awaiting input",
  approval: "Pending approval",
  done: "Completed",
  working: "Working",
  waiting: "Waiting",
};

// Lower rank wins. Approval is another ask for the person, ranked just below input.
const PRIORITY: Record<NavigationStatusKind, number> = {
  input: 0,
  approval: 0.5,
  done: 1,
  working: 2,
  waiting: 3,
};

/** Completion timestamps the person has dismissed, keyed by scoped thread key. */
export type AcknowledgedCompletions = Readonly<Record<string, string>>;

function resolveThreadNavigation(thread: StatusThread) {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "working") {
    return { key, status, unseenCompletedAt: null };
  }
  // resolveSidebarThreadStatus also says "waiting" for any idle runtime, which is just "no
  // active work". Genuine waiting mirrors the thread row's "Waiting" pill: a running turn parked
  // on a thread wait, or background work holding the completion.
  const waiting =
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []);
  if (waiting) return { key, status: "waiting" as const, unseenCompletedAt: null };
  // Same unread rule as the thread row: a completion newer than the server's visit watermark.
  // Threads that were never visited carry no watermark, so startup history stays quiet.
  const completedAt = thread.latestRun?.completedAt ?? null;
  const unseen = hasUnseenCompletion(thread);
  return { key, status: "idle" as const, unseenCompletedAt: unseen ? completedAt : null };
}

function isLive(thread: StatusThread) {
  return thread.deletedAt == null && thread.archivedAt == null;
}

/**
 * The single state a navigation section shows: input/approval > unacknowledged completion >
 * working > genuine waiting. Idle, failed, seen or acknowledged conversations show nothing, so a
 * section with no real state returns null.
 */
export function resolveNavigationStatus(
  threads: ReadonlyArray<StatusThread>,
  acknowledged: AcknowledgedCompletions,
): NavigationStatusKind | null {
  let best: NavigationStatusKind | null = null;
  const consider = (kind: NavigationStatusKind) => {
    if (best === null || PRIORITY[kind] < PRIORITY[best]) best = kind;
  };
  for (const thread of threads) {
    if (!isLive(thread)) continue;
    const resolved = resolveThreadNavigation(thread);
    if (resolved.status === "input") consider("input");
    else if (resolved.status === "approval") consider("approval");
    else if (resolved.status === "working") consider("working");
    else if (
      resolved.unseenCompletedAt !== null &&
      acknowledged[resolved.key] !== resolved.unseenCompletedAt
    )
      consider("done");
    else if (resolved.status === "waiting") consider("waiting");
  }
  return best;
}

/**
 * Acknowledging records exactly the completions currently unseen, replacing older entries:
 * an entry is only meaningful while its thread is still unseen at that completion time, so
 * visited threads and newer completions fall out on their own.
 */
export function acknowledgeNavigationCompletions(
  threads: ReadonlyArray<StatusThread>,
): AcknowledgedCompletions {
  const next: Record<string, string> = {};
  for (const thread of threads) {
    if (!isLive(thread)) continue;
    const resolved = resolveThreadNavigation(thread);
    if (resolved.unseenCompletedAt !== null) next[resolved.key] = resolved.unseenCompletedAt;
  }
  return next;
}
