import { MemoryChatError, type MemoryId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as MemoryStorage from "./MemoryStorage.ts";
import { nodeKey, renderView, validRange } from "./MemoryTree.ts";

export const memoryTools = (
  storage: MemoryStorage.MemoryStorage["Service"],
  memoryId: MemoryId,
) => ({
  zoom: Effect.fn("Memory.zoom")(function* (id: number, count: number, total?: number) {
    const state = yield* storage.memory(memoryId);
    if (!validRange(id, count, total ?? state.total))
      return yield* new MemoryChatError({ operation: "zoom", reason: "invalid-range" });
    if (count === 1) return (yield* storage.message(memoryId, id))?.text ?? "";
    const parts = [
      { id, count: count / 2 },
      { id: id + count / 2, count: count / 2 },
    ];
    const nodes = new Map(
      (yield* storage.memoryNodes(memoryId, parts)).map((node) => [nodeKey(node), node]),
    );
    if (parts.some((part) => !nodes.has(nodeKey(part))))
      return yield* new MemoryChatError({ operation: "zoom", reason: "not-ready" });
    return renderView(parts, nodes);
  }),
  date: Effect.fn("Memory.date")(function* (id: number, total?: number) {
    const state = yield* storage.memory(memoryId);
    if (!validRange(id, 1, total ?? state.total))
      return yield* new MemoryChatError({ operation: "date", reason: "invalid-range" });
    const message = yield* storage.message(memoryId, id);
    if (!message) return yield* new MemoryChatError({ operation: "date", reason: "not-found" });
    return message.date;
  }),
});
