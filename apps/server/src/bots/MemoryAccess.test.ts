import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  BotId,
  RunId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  MessageId,
  ChatAttachmentId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
} from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@satslab/shared/nodeSqliteClient";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import migration from "../persistence/Migrations/069_BotChat.ts";
import * as BotStorage from "./BotStorage.ts";
import * as MemoryAccess from "./MemoryAccess.ts";

const database = Layer.effectDiscard(migration).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const layer = MemoryAccess.layer.pipe(
  Layer.provideMerge(BotStorage.layer),
  Layer.provide(database),
  Layer.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({})),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-access-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("uses the credential's frozen turn even after later messages and snapshots arrive", () =>
  Effect.gen(function* () {
    const storage = yield* BotStorage.BotStorage;
    const access = yield* MemoryAccess.MemoryAccess;
    const id = BotId.make("personal");
    const threadId = ThreadId.make("memory-thread");
    const firstRun = RunId.make("first");
    const secondRun = RunId.make("second");
    yield* storage.create({
      id,
      threadId,
      name: "Personal",
      ownerEnvironmentId: EnvironmentId.make("owner"),
      status: "active",
      generation: 0,
      destinationEnvironmentId: null,
    });
    yield* storage.append(id, [
      { key: "first", text: "first original", kind: "user", date: "2026-10-19T00:00:00.000Z" },
    ]);
    yield* storage.freeze({ botId: id, runId: firstRun, total: 1, view: "first view" });
    yield* storage.append(id, [
      { key: "second", text: "future original", kind: "talk", date: "2026-10-19T01:00:00.000Z" },
    ]);
    yield* storage.freeze({ botId: id, runId: secondRun, total: 2, view: "second view" });
    const first = { threadId, providerSessionId: "session-one", botRunId: firstRun };
    const second = { threadId, providerSessionId: "session-two", botRunId: secondRun };
    assert.equal(yield* access.zoom(first, 0, 1), "first original");
    const child = {
      ...first,
      threadId: ThreadId.make("delegated-child"),
      botThreadId: threadId,
    };
    assert.equal(yield* access.zoom(child, 0, 1), "first original");
    assert.equal(yield* access.date(child, 0), "2026-10-19T00:00:00.000Z");
    assert.equal((yield* Effect.result(access.zoom(child, 1, 1)))._tag, "Failure");
    assert.equal((yield* Effect.result(access.date(child, 1)))._tag, "Failure");
    assert.equal(
      (yield* Effect.result(access.zoom({ ...first, threadId: child.threadId }, 0, 1)))._tag,
      "Failure",
    );
    assert.equal((yield* Effect.result(access.zoom(first, 1, 1)))._tag, "Failure");
    assert.equal((yield* Effect.result(access.date(first, 1)))._tag, "Failure");
    assert.equal(yield* access.zoom(second, 1, 1), "future original");
    assert.equal(
      (yield* Effect.result(access.zoom({ threadId, providerSessionId: "unscoped" }, 0, 1)))._tag,
      "Failure",
    );
    assert.equal(
      (yield* Effect.result(access.zoom({ ...first, botRunId: RunId.make("unknown") }, 0, 1)))._tag,
      "Failure",
    );
    assert.equal(
      (yield* Effect.result(
        access.attachment(first, {
          attachmentId: "unused",
          offset: -1,
          length: 65537,
          encoding: "utf8",
        }),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("reads file pages only from runs visible to the frozen turn", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("files-thread");
    const runId = RunId.make("files-run");
    const botId = BotId.make("files-memory");
    const providerInstanceId = ProviderInstanceId.make("pi");
    const modelSelection = { instanceId: providerInstanceId, model: "test" };
    const thread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("files-project"),
      title: "Files",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const run: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("file-message"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const file = {
      type: "file" as const,
      id: ChatAttachmentId.make("notes"),
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
    };
    const image = {
      ...file,
      type: "image" as const,
      id: ChatAttachmentId.make("image"),
      name: "image.png",
      mimeType: "image/png",
    };
    const future = { ...file, id: ChatAttachmentId.make("future") };
    const message: OrchestrationV2ConversationMessage = {
      id: run.userMessageId,
      threadId,
      runId,
      nodeId: null,
      role: "user",
      text: "Read this",
      attachments: [file, image],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
    };
    const records: OrchestrationV2ThreadProjection = {
      thread,
      runs: [run, { ...run, id: RunId.make("future-run"), ordinal: 2 }],
      messages: [
        message,
        {
          ...message,
          id: MessageId.make("future-message"),
          runId: RunId.make("future-run"),
          attachments: [future],
        },
      ],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: now,
    };
    const testLayer = MemoryAccess.layer.pipe(
      Layer.provideMerge(BotStorage.layer),
      Layer.provide(database),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: (requestedThreadId) =>
            Effect.sync(() => {
              assert.equal(requestedThreadId, threadId);
              return records;
            }),
        }),
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-file-access-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const storage = yield* BotStorage.BotStorage;
      const access = yield* MemoryAccess.MemoryAccess;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* storage.create({
        id: botId,
        threadId,
        name: "Files",
        ownerEnvironmentId: EnvironmentId.make("owner"),
        status: "active",
        generation: 0,
        destinationEnvironmentId: null,
      });
      yield* storage.freeze({ botId, runId, total: 0, view: "" });
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: file,
      });
      assert.ok(path);
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFileString(path, "abcdef");
      const caller = { threadId, providerSessionId: "files-session", botRunId: runId };
      const child = { ...caller, threadId: ThreadId.make("file-child"), botThreadId: threadId };
      const page = yield* access.attachment(child, {
        attachmentId: file.id,
        offset: 2,
        length: 3,
        encoding: "utf8",
      });
      assert.deepEqual(page, {
        name: "notes.txt",
        mimeType: "text/plain",
        offset: 2,
        nextOffset: 5,
        content: "cde",
      });
      const last = yield* access.attachment(child, {
        attachmentId: file.id,
        offset: page.nextOffset,
        length: 3,
        encoding: "base64",
      });
      assert.equal(last.content, "Zg==");
      assert.equal(last.nextOffset, 6);
      const end = yield* access.attachment(caller, {
        attachmentId: file.id,
        offset: 6,
        length: 3,
        encoding: "utf8",
      });
      assert.equal(end.content, "");
      for (const attachmentId of [image.id, future.id, "another-thread-file"]) {
        assert.equal(
          (yield* Effect.result(
            access.attachment(caller, { attachmentId, offset: 0, length: 6, encoding: "utf8" }),
          ))._tag,
          "Failure",
        );
      }
    }).pipe(Effect.provide(testLayer));
  }),
);
