import { BotChatError, type ThreadId, type RunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as BotStorage from "./BotStorage.ts";
import { memoryTools } from "./MemoryTools.ts";

const isBotChatError = Schema.is(BotChatError);

const make = Effect.gen(function* () {
  const storage = yield* BotStorage.BotStorage;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const resolve = Effect.fn("MemoryAccess.resolve")(function* (caller: {
    threadId: ThreadId;
    providerSessionId: string;
    botRunId?: RunId;
    botThreadId?: ThreadId;
  }) {
    const memory = yield* storage.forThread(caller.botThreadId ?? caller.threadId);
    if (!memory || memory.status !== "active")
      return yield* new BotChatError({ operation: "access", reason: "not-owner" });
    if (caller.botRunId === undefined)
      return yield* new BotChatError({ operation: "access", reason: "not-ready" });
    const snapshot = yield* storage.snapshot(memory.id, caller.botRunId);
    if (!snapshot) return yield* new BotChatError({ operation: "access", reason: "not-ready" });
    return { memory, snapshot, tools: memoryTools(storage, memory.id) };
  });
  const zoom = Effect.fn("MemoryAccess.zoom")(function* (
    caller: {
      threadId: ThreadId;
      providerSessionId: string;
      botRunId?: RunId;
      botThreadId?: ThreadId;
    },
    id: number,
    count: number,
  ) {
    const { tools, snapshot } = yield* resolve(caller);
    return yield* tools.zoom(id, count, snapshot.total);
  });
  const date = Effect.fn("MemoryAccess.date")(function* (
    caller: {
      threadId: ThreadId;
      providerSessionId: string;
      botRunId?: RunId;
      botThreadId?: ThreadId;
    },
    id: number,
  ) {
    const { tools, snapshot } = yield* resolve(caller);
    return yield* tools.date(id, snapshot.total);
  });
  const attachment = Effect.fn("MemoryAccess.attachment")(function* (
    caller: {
      threadId: ThreadId;
      providerSessionId: string;
      botRunId?: RunId;
      botThreadId?: ThreadId;
    },
    input: { attachmentId: string; offset: number; length: number; encoding: "utf8" | "base64" },
  ) {
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.length) ||
      input.length < 1 ||
      input.length > 65536
    )
      return yield* new BotChatError({ operation: "attachment", reason: "invalid-range" });
    const { snapshot, memory } = yield* resolve(caller);
    const projection = yield* projections.getThreadRecords(memory.threadId, ["messages", "runs"]);
    const run = projection.runs.find((candidate) => candidate.id === snapshot.runId);
    if (!run) return yield* new BotChatError({ operation: "attachment", reason: "not-ready" });
    const visibleRuns = new Set(
      projection.runs
        .filter((candidate) => candidate.ordinal <= run.ordinal)
        .map((candidate) => candidate.id),
    );
    const attachment = projection.messages
      .filter((message) => message.runId !== null && visibleRuns.has(message.runId))
      .flatMap((message) => message.attachments)
      .find((item) => item.id === input.attachmentId);
    if (!attachment || attachment.type === "image")
      return yield* new BotChatError({ operation: "attachment", reason: "not-found" });
    const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
    if (path === null)
      return yield* new BotChatError({ operation: "attachment", reason: "not-found" });
    const content = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path, { flag: "r" });
        yield* file.seek(BigInt(input.offset), "start");
        const buffer = new Uint8Array(input.length);
        const read = yield* file.read(buffer);
        return buffer.subarray(0, read);
      }),
    );
    return {
      name: attachment.name,
      mimeType: attachment.mimeType,
      offset: input.offset,
      nextOffset: input.offset + content.length,
      content:
        input.encoding === "base64"
          ? Buffer.from(content).toString("base64")
          : new TextDecoder().decode(content),
    };
  });
  const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isBotChatError(cause)
          ? cause
          : new BotChatError({ operation: "access", reason: "storage", cause }),
      ),
    );
  return {
    zoom: (...args: Parameters<typeof zoom>) => zoom(...args).pipe(wrap),
    date: (...args: Parameters<typeof date>) => date(...args).pipe(wrap),
    attachment: (...args: Parameters<typeof attachment>) => attachment(...args).pipe(wrap),
  };
});
export class MemoryAccess extends Context.Service<MemoryAccess, Effect.Success<typeof make>>()(
  "t3/bots/MemoryAccess",
) {}
export const layer = Layer.effect(MemoryAccess, make);
