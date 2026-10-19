import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

type MemoryThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "lineage" | "memoryIdentityId"
>;

export function resolveMemoryThreadContext(thread: MemoryThread | null, root: MemoryThread | null) {
  if (thread === null) return null;
  const memoryThread = thread.memoryIdentityId
    ? thread
    : root?.id === thread.lineage.rootThreadId
      ? root
      : null;
  return memoryThread?.memoryIdentityId
    ? {
        memoryId: memoryThread.memoryIdentityId,
        threadId: memoryThread.id,
        title: memoryThread.title,
        isSubagent: thread.id !== memoryThread.id,
      }
    : null;
}
