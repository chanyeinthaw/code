import { describe, expect, it } from "vite-plus/test";
import { BotId, ThreadId } from "@t3tools/contracts";
import { resolveBotThreadContext } from "./botThreadContext";

const rootId = ThreadId.make("memory-thread");
const memory = {
  id: rootId,
  title: "Personal",
  botId: BotId.make("personal"),
  lineage: { rootThreadId: rootId, parentThreadId: null, relationshipToParent: null },
};

describe("memory navigation context", () => {
  it("shows the memory identity for the main conversation", () => {
    expect(resolveBotThreadContext(memory, null)).toEqual({
      botId: memory.botId,
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
      expect(resolveBotThreadContext(child, memory)).toEqual({
        botId: memory.botId,
        threadId: rootId,
        title: "Personal",
        isSubagent: true,
      });
      expect(child).not.toHaveProperty("botId");
    }
  });

  it("does not classify normal threads or unrelated roots as memory", () => {
    const normal = {
      id: ThreadId.make("normal"),
      title: "Project work",
      lineage: { ...memory.lineage, rootThreadId: ThreadId.make("normal") },
    };
    expect(resolveBotThreadContext(normal, null)).toBeNull();
    expect(resolveBotThreadContext(normal, memory)).toBeNull();
    expect(resolveBotThreadContext(null, memory)).toBeNull();
  });
});
