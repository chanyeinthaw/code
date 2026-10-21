import type { OrchestrationV2ThreadShell } from "@satslab/contracts";

type BotThread = Pick<OrchestrationV2ThreadShell, "id" | "title" | "lineage" | "botId">;

export function resolveBotThreadContext(thread: BotThread | null, root: BotThread | null) {
  if (thread === null) return null;
  const botThread = thread.botId ? thread : root?.id === thread.lineage.rootThreadId ? root : null;
  return botThread?.botId
    ? {
        botId: botThread.botId,
        threadId: botThread.id,
        title: botThread.title,
        isSubagent: thread.id !== botThread.id,
      }
    : null;
}
