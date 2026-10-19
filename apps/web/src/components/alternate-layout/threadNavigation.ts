import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isBotProject } from "@t3tools/shared/botChat";
import type { DraftThreadState } from "../../composerDraftStore";

type NavigationProject = Pick<EnvironmentProject, "id" | "environmentId" | "isBot">;
type NavigationThread = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "botId"
  | "lastVisitedAt"
  | "updatedAt"
  | "archivedAt"
  | "deletedAt"
>;
type NavigationDraft = Pick<DraftThreadState, "environmentId" | "projectId" | "promotedTo">;

export function resolveThreadsNavigationHref({
  rememberedHref,
  projects,
  threads,
  drafts,
}: {
  rememberedHref: string | null;
  projects: readonly NavigationProject[];
  threads: readonly NavigationThread[];
  drafts: Readonly<Record<string, NavigationDraft>>;
}) {
  const ordinaryProject = (environmentId: string, projectId: string) =>
    projects.some(
      (project) =>
        project.environmentId === environmentId &&
        project.id === projectId &&
        !isBotProject(project),
    );
  const ordinaryThreads = threads.filter(
    (thread) =>
      thread.botId === undefined &&
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      ordinaryProject(thread.environmentId, thread.projectId),
  );
  if (
    rememberedHref !== null &&
    rememberedHref.startsWith("/") &&
    !rememberedHref.startsWith("//")
  ) {
    const pathname = rememberedHref.split(/[?#]/, 1)[0]?.replace(/^\/layout(?=\/|$)/, "") ?? "";
    let parts: string[] = [];
    try {
      parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      // Ignore malformed persisted URLs and use the ordinary thread fallback.
    }
    if (parts.length === 2) {
      const [environmentId, threadId] = parts;
      if (environmentId === "draft" && threadId) {
        const draft = drafts[threadId];
        if (draft && !draft.promotedTo && ordinaryProject(draft.environmentId, draft.projectId))
          return rememberedHref;
      } else if (
        ordinaryThreads.some(
          (thread) => thread.environmentId === environmentId && thread.id === threadId,
        )
      ) {
        return rememberedHref;
      }
    }
  }
  let recent: NavigationThread | undefined;
  for (const thread of ordinaryThreads) {
    if (
      !recent ||
      (thread.lastVisitedAt ?? thread.updatedAt) > (recent.lastVisitedAt ?? recent.updatedAt)
    )
      recent = thread;
  }
  return recent
    ? `/${encodeURIComponent(recent.environmentId)}/${encodeURIComponent(recent.id)}`
    : "/";
}
