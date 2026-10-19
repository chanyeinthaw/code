import { describe, expect, it } from "vite-plus/test";
import { MemoryId, ThreadId } from "@t3tools/contracts";
import { resolveMemoryThreadContext } from "./memoryThreadContext";

const rootId = ThreadId.make("memory-thread");
const memory = {
  id: rootId,
  title: "Personal",
  memoryIdentityId: MemoryId.make("personal"),
  lineage: { rootThreadId: rootId, parentThreadId: null, relationshipToParent: null },
};

describe("memory navigation context", () => {
  it("shows the memory identity for the main conversation", () => {
    expect(resolveMemoryThreadContext(memory, null)).toEqual({
      memoryId: memory.memoryIdentityId,
      threadId: rootId,
      title: "Personal",
      isSubagent: false,
    });
  });

  it("keeps direct and nested subagents in their root memory", () => {
    for (const parentThreadId of [rootId, ThreadId.make("another-subagent")]) {
      const child = {
        id: ThreadId.make("child"),
        title: "Say hello",
        lineage: {
          rootThreadId: rootId,
          parentThreadId,
          relationshipToParent: "subagent" as const,
        },
      };
      expect(resolveMemoryThreadContext(child, memory)).toEqual({
        memoryId: memory.memoryIdentityId,
        threadId: rootId,
        title: "Personal",
        isSubagent: true,
      });
      expect(child).not.toHaveProperty("memoryIdentityId");
    }
  });

  it("does not classify normal threads or unrelated roots as memory", () => {
    const normal = {
      id: ThreadId.make("normal"),
      title: "Project work",
      lineage: { ...memory.lineage, rootThreadId: ThreadId.make("normal") },
    };
    expect(resolveMemoryThreadContext(normal, null)).toBeNull();
    expect(resolveMemoryThreadContext(normal, memory)).toBeNull();
    expect(resolveMemoryThreadContext(null, memory)).toBeNull();
  });
});
