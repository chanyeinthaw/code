import type { BotId, EnvironmentId, ScopedThreadRef, ThreadId } from "@satslab/contracts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export interface ComposerThreadCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly botId?: BotId | undefined;
  readonly deletedAt?: string | null | undefined;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
  readonly isBot?: boolean;
}

/**
 * The agent can only read threads on its own server, so candidates stay within the
 * composer's environment.
 */
export function matchComposerThreadItems(input: {
  shells: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  excludeThreadId: ThreadId | null;
  query: string;
}): ComposerThreadItem[] {
  const query = input.query.trim().toLowerCase();
  return input.shells
    .filter(
      (shell) =>
        shell.environmentId === input.environmentId &&
        shell.id !== input.excludeThreadId &&
        shell.archivedAt === null &&
        shell.deletedAt == null &&
        (query.length > 0 || shell.botId !== undefined) &&
        shell.title.toLowerCase().includes(query),
    )
    .sort(
      (left, right) =>
        Number(right.botId !== undefined) - Number(left.botId !== undefined) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map((shell) => ({
      id: `thread:${shell.environmentId}:${shell.id}`,
      type: "thread",
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      label: shell.title,
      description: shell.botId === undefined ? "Thread" : "Bot",
      ...(shell.botId === undefined ? {} : { isBot: true }),
    }));
}
