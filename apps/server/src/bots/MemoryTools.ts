import { BotChatError, type BotId } from "@satslab/contracts";
import * as Effect from "effect/Effect";
import type * as BotStorage from "./BotStorage.ts";
import { nodeKey, renderView, validRange } from "./MemoryTree.ts";

export const memoryTools = (storage: BotStorage.BotStorage["Service"], botId: BotId) => ({
  zoom: Effect.fn("Memory.zoom")(function* (id: number, count: number, total?: number) {
    const state = yield* storage.memory(botId);
    if (!validRange(id, count, total ?? state.total))
      return yield* new BotChatError({ operation: "zoom", reason: "invalid-range" });
    if (count === 1) return (yield* storage.message(botId, id))?.text ?? "";
    const parts = [
      { id, count: count / 2 },
      { id: id + count / 2, count: count / 2 },
    ];
    const nodes = new Map(
      (yield* storage.memoryNodes(botId, parts)).map((node) => [nodeKey(node), node]),
    );
    if (parts.some((part) => !nodes.has(nodeKey(part))))
      return yield* new BotChatError({ operation: "zoom", reason: "not-ready" });
    return renderView(parts, nodes);
  }),
  date: Effect.fn("Memory.date")(function* (id: number, total?: number) {
    const state = yield* storage.memory(botId);
    if (!validRange(id, 1, total ?? state.total))
      return yield* new BotChatError({ operation: "date", reason: "invalid-range" });
    const message = yield* storage.message(botId, id);
    if (!message) return yield* new BotChatError({ operation: "date", reason: "not-found" });
    return message.date;
  }),
});
