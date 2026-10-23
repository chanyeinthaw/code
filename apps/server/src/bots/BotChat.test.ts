import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  ChatAttachmentId,
  CheckpointId,
  CheckpointScopeId,
  TurnItemId,
  EnvironmentId,
  EventId,
  BotId,
  NodeId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
} from "@satslab/contracts";
import * as IdAllocator from "@satslab/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ThreadCommands from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as LegacyImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotChat from "./BotChat.ts";
import * as MemoryCompaction from "./MemoryCompaction.ts";
import * as BotOwnership from "./BotOwnership.ts";
import * as BotStorage from "./BotStorage.ts";
import * as BotTransferFiles from "./BotTransferFiles.ts";
import { planProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as Result from "effect/Result";
import { turnInstructions } from "./MemoryWorker.ts";

const owner = EnvironmentId.make("owner");
const botId = BotId.make("personal");
const threadId = ThreadId.make("bot-thread");
const instanceId = ProviderInstanceId.make("pi");
const now = DateTime.makeUnsafe("2026-10-20T00:00:00Z");
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("bot-project"),
  title: "Personal",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  botId: botId,
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
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId,
  runId: RunId.make(id),
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
});
const run = (id: string, status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(id),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});
const database = SqlitePersistence.layerMemory;
const dependencies = (
  eventStream: Stream.Stream<OrchestrationV2StoredEvent>,
  environmentId: EnvironmentId = owner,
  transfers = false,
) =>
  Layer.mergeAll(
    BotStorage.layer,
    ProjectionStore.layer,
    EventStore.layer,
    transfers
      ? BotOwnership.layer.pipe(Layer.provide(BotStorage.layer))
      : Layer.mock(BotOwnership.BotOwnership)({ packageFor: () => Effect.succeed(undefined) }),
    transfers ? BotTransferFiles.layer : Layer.mock(BotTransferFiles.BotTransferFiles)({}),
    ProjectStore.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.unwrap(
      Effect.gen(function* () {
        const events = yield* EventStore.OrchestrationEventStore;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        return Layer.mock(EventSink.EventSinkV2)({
          write: ({ events: incoming }) =>
            Effect.gen(function* () {
              const saved = yield* events.appendAgentEvents({
                events: incoming,
              });
              for (const event of incoming) yield* projections.apply(event);
              return saved;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EventSink.EventSinkWriteError({ eventCount: incoming.length, cause }),
              ),
            ),
          commitProjectCommand: (input) =>
            Effect.gen(function* () {
              const event = yield* events.appendProjectEvent(input.event);
              yield* projects.apply(event);
              return {
                committed: true,
                receipt: {
                  commandId: input.commandId,
                  projectId: input.projectId,
                  commandType: input.commandType,
                  acceptedAt: input.acceptedAt,
                  resultSequence: event.sequence,
                  status: "accepted" as const,
                  error: null,
                },
              };
            }).pipe(
              Effect.mapError(
                (cause) => new EventSink.EventSinkWriteError({ eventCount: 1, cause }),
              ),
            ),
          latestSequence: () => Effect.succeed(0),
          stream: () => eventStream,
        });
      }),
    ).pipe(
      Layer.provide(Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer)),
    ),
    Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
    IdAllocator.layer,
  ).pipe(Layer.provideMerge(database));
const makeLayer = (
  compaction: MemoryCompaction.MemoryCompaction["Service"],
  eventStream: Stream.Stream<OrchestrationV2StoredEvent> = Stream.empty,
  environmentId: EnvironmentId = owner,
  transfers = false,
) =>
  BotChat.layer.pipe(
    Layer.provideMerge(dependencies(eventStream, environmentId, transfers)),
    Layer.provide(Layer.succeed(MemoryCompaction.MemoryCompaction, compaction)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bot-chat-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const layer = makeLayer({ open: () => Effect.die("Short messages need no inference") });
const persist = Effect.fn("BotChat.test.persist")(function* (event: OrchestrationV2DomainEvent) {
  yield* (yield* EventStore.OrchestrationEventStore).appendAgentEvents({ events: [event] });
  yield* (yield* ProjectionStore.ProjectionStoreV2).apply(event);
});
const setup = Effect.gen(function* () {
  const storage = yield* BotStorage.BotStorage;
  yield* storage.create({
    id: botId,
    threadId,
    name: "Personal",
    ownerEnvironmentId: owner,
    status: "active",
    generation: 0,
    destinationEnvironmentId: null,
  });
  yield* persist({
    id: EventId.make("thread"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
});

it.effect(
  "renames a bot, journals the change once, and keeps existing frozen views unchanged",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const chat = yield* BotChat.BotChat;
      const storage = yield* BotStorage.BotStorage;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const frozen = yield* chat.prepare({
        botId,
        runId: RunId.make("before-rename"),
        message: message("before-rename", "user", "Hello"),
      });
      const renamed = yield* chat.rename(botId, "Atlas");
      assert.equal(renamed.name, "Atlas");
      const updated = yield* projections.getThread(threadId);
      assert.equal(updated.title, "Atlas");
      assert.include(turnInstructions(updated.title), "You are Atlas,");
      yield* chat.rename(botId, "Atlas");
      yield* chat.rename(botId, "Nova");
      assert.deepEqual(yield* storage.snapshot(botId, frozen.runId), frozen);
      const next = yield* chat.prepare({
        botId,
        runId: RunId.make("after-rename"),
        message: message("after-rename", "user", "Who are you?"),
      });
      assert.equal(next.total, 3);
      assert.include(next.view, 'Your name changed from "Atlas" to "Nova"');
      assert.include(next.view, 'Your name changed from "Personal" to "Atlas"');
      assert.include(next.view, 'Your name is now "Atlas"');
      assert.notInclude(turnInstructions(updated.title), "You are Sora");
    }).pipe(Effect.provide(layer)),
);

it.effect("records name changes made through ordinary thread metadata", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* persist({
      id: EventId.make("external-rename"),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: now,
      payload: { ...thread, title: "Nova" },
    });
    const chat = yield* BotChat.BotChat;
    const frozen = yield* chat.prepare({
      botId,
      runId: RunId.make("renamed-turn"),
      message: message("renamed-turn", "user", "Hello"),
    });
    assert.equal((yield* chat.assertOwner(botId)).name, "Nova");
    assert.include(frozen.view, 'Your name changed from "Personal" to "Nova"');
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "journals prior output and freezes a retry-stable view before appending the current input",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const chat = yield* BotChat.BotChat;
      const storage = yield* BotStorage.BotStorage;
      const first = message("first", "user", "Remember the name Chan");
      const initial = yield* chat.prepare({ botId, runId: RunId.make("first"), message: first });
      assert.equal(initial.total, 0);
      assert.notInclude(initial.view, "Chan");
      yield* persist({
        id: EventId.make("answer"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: message("answer", "assistant", "Your name is Chan"),
      });
      const next = message("next", "user", "What is my name?");
      const frozen = yield* chat.prepare({ botId, runId: RunId.make("next"), message: next });
      assert.equal(frozen.total, 2);
      assert.include(frozen.view, "Remember the name Chan");
      assert.include(frozen.view, "Your name is Chan");
      assert.notInclude(frozen.view, "What is my name?");
      assert.deepEqual(
        yield* chat.prepare({ botId, runId: RunId.make("next"), message: next }),
        frozen,
      );
      assert.equal((yield* storage.memory(botId)).total, 3);
    }).pipe(Effect.provide(layer)),
);

it.effect("retains the user input of a run that fails before its view freezes", () =>
  Effect.gen(function* () {
    yield* setup;
    const chat = yield* BotChat.BotChat;
    const failed = message("failed", "user", "Keep this failed request");
    yield* persist({
      id: EventId.make("failed-message"),
      type: "message.updated",
      threadId,
      occurredAt: now,
      payload: failed,
    });
    yield* persist({
      id: EventId.make("failed-run"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: run("failed", "failed"),
    });
    const next = message("next", "user", "Continue");
    const frozen = yield* chat.prepare({ botId, runId: RunId.make("next"), message: next });
    assert.equal(frozen.total, 1);
    assert.include(frozen.view, "Keep this failed request");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects ownership transfer while any turn is preparing, queued, starting, running, or waiting",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const chat = yield* BotChat.BotChat;
      const storage = yield* BotStorage.BotStorage;
      for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
        yield* persist({
          id: EventId.make(`run-${status}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: run("busy", status),
        });
        const rejected = yield* Effect.flip(
          chat.beginTransfer(botId, EnvironmentId.make("target")),
        );
        assert.equal(rejected.reason, "busy");
        assert.equal((yield* storage.get(botId)).status, "active");
      }
    }).pipe(Effect.provide(layer)),
);

const destinationEnvironment = EnvironmentId.make("destination");
const transferLayer = (environmentId: EnvironmentId) =>
  makeLayer(
    { open: () => Effect.die("Short messages need no inference") },
    Stream.empty,
    environmentId,
    true,
  ).pipe(Layer.provideMerge(ServerSettings.layerTest()));

it.effect(
  "pins inherited instruction loading while other absent overrides inherit the destination",
  () =>
    Effect.gen(function* () {
      const sourceContext = yield* Layer.build(transferLayer(owner));
      const source = Context.get(sourceContext, BotChat.BotChat);
      const sourceSettings = Context.get(sourceContext, ServerSettings.ServerSettingsService);
      yield* sourceSettings.updateSettings({
        botLoadResources: false,
        enableAgentBrowserAccess: false,
      });
      const created = yield* source.create({
        threadId,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
      });
      yield* source.beginTransfer(created.id, destinationEnvironment);
      const transfer = yield* Context.get(sourceContext, BotOwnership.BotOwnership).packageFor(
        created.id,
      );
      assert.deepEqual(transfer?.project.settingsOverrides, { botLoadResources: false });
      assert.isNull(transfer?.project.defaultModelSelection);
    }).pipe(Effect.scoped),
);

it.effect("moves root history and project settings without workspace files or attachments", () =>
  Effect.gen(function* () {
    const sourceContext = yield* Layer.build(transferLayer(owner));
    const destinationContext = yield* Layer.build(transferLayer(destinationEnvironment));
    const source = Context.get(sourceContext, BotChat.BotChat);
    const destination = Context.get(destinationContext, BotChat.BotChat);
    const created = yield* source.create({
      threadId,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
    });
    const sourceProjects = Context.get(sourceContext, ProjectStore.ProjectStoreV2);
    const sourceThread = yield* Context.get(
      sourceContext,
      ProjectionStore.ProjectionStoreV2,
    ).getThread(threadId);
    const sourceSettings = Context.get(sourceContext, ServerSettings.ServerSettingsService);
    const destinationSettings = Context.get(
      destinationContext,
      ServerSettings.ServerSettingsService,
    );
    const unrelatedId = ProjectId.make("unrelated");
    yield* destinationSettings.updateSettings({
      botLoadResources: true,
      projectSettingsOverrides: {
        [unrelatedId]: { botLoadResources: true, defaultAutoPull: true },
      },
    });
    const scripts = [
      {
        id: "test",
        name: "Test",
        command: "vp test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];
    const defaults = { ...thread.modelSelection, options: [{ id: "effort", value: "max" }] };
    const row = yield* sourceProjects.get(sourceThread.projectId);
    assert.isTrue(Option.isSome(row));
    const command = {
      type: "project.meta.update" as const,
      commandId: CommandId.make("configure-transfer"),
      projectId: sourceThread.projectId,
      defaultModelSelection: defaults,
      defaultThreadEnvMode: "local" as const,
      autoPull: true,
      projectIcon: { kind: "emoji" as const, emoji: "🪻" },
      scripts,
    };
    const planned = planProjectCommand({
      command,
      state: { project: Option.getOrUndefined(row), workspaceOwner: undefined },
      eventId: EventId.make("configure-transfer"),
      now,
    });
    if (Result.isFailure(planned)) return yield* planned.failure;
    yield* Context.get(sourceContext, EventSink.EventSinkV2).commitProjectCommand({
      commandId: command.commandId,
      projectId: command.projectId,
      commandType: command.type,
      acceptedAt: now,
      event: planned.success,
    });
    const sourceFs = Context.get(sourceContext, FileSystem.FileSystem);
    const targetFs = Context.get(destinationContext, FileSystem.FileSystem);
    const sourcePath = sourceThread.worktreePath;
    assert.isNotNull(sourcePath);
    if (!sourcePath) return yield* Effect.die("Bot has no workspace");
    yield* sourceFs.writeFileString(`${sourcePath}/private.txt`, "workspace bytes excluded");
    yield* sourceFs.symlink("/missing-transfer-workspace-target", `${sourcePath}/unreadable-link`);
    const attachment = {
      type: "file" as const,
      id: ChatAttachmentId.make("missing-attachment"),
      name: "private.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };
    const rootMessage = {
      ...message("root-history", "user", "Keep this text"),
      runId: null,
      attachments: [attachment],
    };
    yield* Context.get(sourceContext, EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make("root-history"),
          threadId,
          occurredAt: now,
          type: "message.updated",
          payload: rootMessage,
        },
        {
          id: EventId.make("separate-thread"),
          threadId: ThreadId.make("separate-thread"),
          occurredAt: now,
          type: "thread.created",
          payload: {
            ...sourceThread,
            id: ThreadId.make("separate-thread"),
            lineage: {
              parentThreadId: threadId,
              rootThreadId: threadId,
              relationshipToParent: "subagent",
            },
          },
        },
      ],
    });
    const sourceStorage = Context.get(sourceContext, BotStorage.BotStorage);
    yield* sourceStorage.append(created.id, [
      { key: "memory", kind: "talk", text: "Retained memory", date: DateTime.formatIso(now) },
    ]);
    yield* sourceStorage.completeMemoryJob(created.id, {
      id: 0,
      count: 1,
      text: "Compacted memory",
    });
    const compacted = yield* sourceStorage.memory(created.id);
    yield* sourceStorage.saveMemory(created.id, {
      ...compacted,
      compactParts: [{ id: 0, count: 1 }],
      compactRevision: compacted.revision,
      compactPending: false,
    });
    yield* sourceStorage.append(created.id, [
      {
        key: "pending-memory",
        kind: "talk",
        text: "Pending compaction",
        date: DateTime.formatIso(now),
      },
    ]);
    yield* sourceStorage.freeze({
      botId: created.id,
      runId: RunId.make("frozen-transfer"),
      total: 1,
      view: "Frozen memory",
    });
    yield* sourceSettings.updateSettings({
      projectSettingsOverrides: {
        [sourceThread.projectId]: {
          botLoadResources: false,
          defaultModelSelection: null,
          enableAgentBrowserAccess: false,
          defaultProjectScripts: scripts,
        },
      },
    });
    const descriptor = yield* source.beginTransfer(created.id, destinationEnvironment);
    for (let offset = 0; offset < descriptor.length;) {
      const chunk = yield* source.readTransferChunk(created.id, descriptor.transferId, offset);
      yield* destination.writeTransferChunk(descriptor.transferId, offset, chunk.data);
      offset = chunk.nextOffset;
    }
    const packageBefore = yield* Context.get(sourceContext, BotOwnership.BotOwnership).packageFor(
      created.id,
    );
    assert.isDefined(packageBefore);
    assert.isFalse(JSON.stringify(packageBefore).includes("workspace bytes excluded"));
    assert.isFalse(Object.hasOwn(packageBefore ?? {}, "workspace"));
    assert.isFalse(Object.hasOwn(packageBefore ?? {}, "attachments"));
    assert.isTrue(packageBefore?.events.every((event) => event.threadId === threadId));
    assert.deepEqual(yield* source.beginTransfer(created.id, destinationEnvironment), descriptor);
    const staged = yield* destination.stageTransfer(descriptor.transferId, descriptor.length);
    const stagedThread = yield* Context.get(
      destinationContext,
      ProjectionStore.ProjectionStoreV2,
    ).getThread(threadId);
    yield* destinationSettings.updateSettings({
      projectSettingsOverrides: {
        [stagedThread.projectId]: {
          defaultAutoPull: true,
          providerInstances: { [instanceId]: { enabled: false } },
        },
      },
    });
    yield* destination.stageTransfer(descriptor.transferId, descriptor.length);
    assert.equal(staged.status, "staged");
    const targetThread = yield* Context.get(
      destinationContext,
      ProjectionStore.ProjectionStoreV2,
    ).getThread(threadId);
    const targetSettings = yield* Context.get(
      destinationContext,
      ServerSettings.ServerSettingsService,
    ).getSettings;
    assert.deepEqual(targetSettings.projectSettingsOverrides[targetThread.projectId], {
      botLoadResources: false,
      defaultModelSelection: null,
      enableAgentBrowserAccess: false,
      providerInstances: {},
      defaultProjectScripts: scripts,
    });
    assert.deepEqual(targetSettings.projectSettingsOverrides[unrelatedId], {
      botLoadResources: true,
      defaultAutoPull: true,
    });
    const targetProject = yield* Context.get(destinationContext, ProjectStore.ProjectStoreV2).get(
      targetThread.projectId,
    );
    assert.isTrue(Option.isSome(targetProject));
    if (Option.isNone(targetProject)) return yield* Effect.die("Missing imported project");
    assert.deepEqual(targetProject.value.defaultModelSelection, defaults);
    assert.equal(targetProject.value.defaultThreadEnvMode, "local");
    assert.isTrue(targetProject.value.autoPull);
    assert.deepEqual(targetProject.value.projectIcon, command.projectIcon);
    assert.deepEqual(targetProject.value.scripts, scripts);
    assert.equal(targetProject.value.title, created.name);
    assert.notEqual(targetProject.value.workspaceRoot, sourcePath);
    assert.isFalse(yield* targetFs.exists(`${targetProject.value.workspaceRoot}/private.txt`));
    const targetHistory = yield* Context.get(
      destinationContext,
      ProjectionStore.ProjectionStoreV2,
    ).getThreadRecords(threadId, ["messages"]);
    assert.equal(
      targetHistory.messages[0]?.text,
      "Keep this text\n[Attachments unavailable after transfer: private.txt]",
    );
    assert.deepEqual(targetHistory.messages[0]?.attachments, []);
    assert.isNull(targetThread.activeProviderThreadId);
    const targetStorage = Context.get(destinationContext, BotStorage.BotStorage);
    assert.equal((yield* targetStorage.message(created.id, 0))?.text, "Retained memory");
    assert.equal(
      (yield* targetStorage.snapshot(created.id, RunId.make("frozen-transfer")))?.view,
      "Frozen memory",
    );
    const targetSql = Context.get(destinationContext, SqlClient.SqlClient);
    assert.deepEqual(
      yield* targetSql`SELECT id,count,source FROM sats_bot_memory_jobs WHERE bot_id=${created.id}`,
      packageBefore?.jobs,
    );
    assert.deepEqual(yield* targetStorage.memory(created.id), packageBefore?.state);
    assert.deepEqual(yield* targetStorage.memoryNodes(created.id, [{ id: 0, count: 1 }]), [
      { id: 0, count: 1, text: "Compacted memory" },
    ]);
    assert.deepEqual((yield* targetStorage.memory(created.id)).compactParts, [{ id: 0, count: 1 }]);
    const released = yield* source.releaseTransfer(created.id, descriptor.transferId);
    const active = yield* destination.activateTransfer(
      created.id,
      descriptor.transferId,
      released.secret,
    );
    assert.equal(active.status, "active");
    assert.equal(active.id, created.id);
    assert.equal(active.threadId, threadId);
    assert.equal(active.ownerEnvironmentId, destinationEnvironment);
    yield* destinationSettings.updateSettings({
      projectSettingsOverrides: { [targetThread.projectId]: { botLoadResources: true } },
    });
    yield* targetFs.writeFileString(
      `${targetProject.value.workspaceRoot}/target-only.txt`,
      "keep me",
    );
    assert.deepEqual(
      yield* destination.stageTransfer(descriptor.transferId, descriptor.length),
      active,
    );
    assert.equal(
      (yield* destinationSettings.getSettings).projectSettingsOverrides[targetThread.projectId]
        ?.botLoadResources,
      true,
    );
    assert.equal(
      yield* targetFs.readFileString(`${targetProject.value.workspaceRoot}/target-only.txt`),
      "keep me",
    );
    const projected = yield* Context.get(
      destinationContext,
      ProjectionStore.ProjectionStoreV2,
    ).getThread(created.threadId);
    assert.equal(projected.botId, created.id);
    assert.isNull(projected.deletedAt);
  }).pipe(Effect.scoped),
);

it.effect("defers compaction until the foreground run ends, even with a newer queued run", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<string>();
    const changes = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    yield* Effect.gen(function* () {
      yield* setup;
      const chat = yield* BotChat.BotChat;
      const storage = yield* BotStorage.BotStorage;
      yield* persist({
        id: EventId.make("long-running"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: run("long", "running"),
      });
      yield* persist({
        id: EventId.make("newer-queued"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...run("queued", "queued"), ordinal: 2 },
      });
      const frozen = yield* chat.prepare({
        botId,
        runId: RunId.make("long"),
        message: message("long", "user", "Remember Chan. ".repeat(100)),
      });
      assert.equal(frozen.total, 0);
      assert.isFalse(yield* Deferred.isDone(started));
      assert.isTrue(yield* storage.memoryRecoveryDue(botId));
      const sink = yield* EventSink.EventSinkV2;
      const saved = yield* sink.write({
        events: [
          {
            id: EventId.make("long-completed"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: run("long", "completed"),
          },
        ],
      });
      yield* Queue.offerAll(changes, saved);
      assert.include(yield* Deferred.await(started), "Remember Chan.");
      const next = yield* chat.prepare({
        botId,
        runId: RunId.make("next"),
        message: message("next", "user", "Continue"),
      });
      assert.include(next.view, "Remember Chan.");
    }).pipe(
      Effect.provide(
        makeLayer(
          {
            open: () =>
              Effect.succeed({
                send: (task) =>
                  Deferred.succeed(started, task).pipe(Effect.as("user: Remember Chan.")),
              }),
          },
          Stream.fromQueue(changes),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("records concise tool exchanges and ignores checkpoints without inference", () =>
  Effect.gen(function* () {
    yield* setup;
    const chat = yield* BotChat.BotChat;
    yield* chat.prepare({
      botId,
      runId: RunId.make("first"),
      message: message("first", "user", "What time?"),
    });
    yield* persist({
      id: EventId.make("reply"),
      type: "message.updated",
      threadId,
      occurredAt: now,
      payload: message("reply", "assistant", "It is midnight."),
    });
    const base = {
      id: TurnItemId.make("tool"),
      threadId,
      runId: RunId.make("first"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    for (const id of ["tool-complete", "tool-repeat"])
      yield* persist({
        id: EventId.make(id),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...base,
          type: "dynamic_tool",
          toolName: "date",
          input: { id: 0 },
          output: "2026-10-20T00:00:00Z",
        },
      });
    yield* persist({
      id: EventId.make("checkpoint"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...base,
        id: TurnItemId.make("checkpoint"),
        type: "checkpoint",
        checkpointId: CheckpointId.make("checkpoint"),
        scopeId: CheckpointScopeId.make("scope"),
        files: [],
      },
    });
    const frozen = yield* chat.prepare({
      botId,
      runId: RunId.make("next"),
      message: message("next", "user", "Continue"),
    });
    assert.equal(frozen.total, 4);
    assert.include(frozen.view, 'tool: date({"id":0})');
    assert.include(frozen.view, "echo: 2026-10-20T00:00:00Z");
    assert.include(frozen.view, "It is midnight.");
    assert.notInclude(frozen.view, "checkpoint");
    assert.notInclude(frozen.view, "providerThreadId");
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps turns and output compaction independent across memories", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const changes = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const secondId = BotId.make("second");
    const secondThread = ThreadId.make("second-thread");
    yield* Effect.gen(function* () {
      yield* setup;
      const storage = yield* BotStorage.BotStorage;
      const chat = yield* BotChat.BotChat;
      yield* storage.create({
        id: secondId,
        threadId: secondThread,
        name: "Second",
        ownerEnvironmentId: owner,
        status: "active",
        generation: 0,
        destinationEnvironmentId: null,
      });
      yield* persist({
        id: EventId.make("second-thread"),
        type: "thread.created",
        threadId: secondThread,
        occurredAt: now,
        payload: {
          ...thread,
          id: secondThread,
          botId: secondId,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: secondThread },
        },
      });
      yield* chat.prepare({
        botId,
        runId: RunId.make("first-long"),
        message: message("first-long", "user", "First memory input. ".repeat(100)),
      });
      yield* Deferred.await(firstStarted);
      const waiting = yield* chat
        .prepare({
          botId,
          runId: RunId.make("first-next"),
          message: message("first-next", "user", "First follow-up"),
        })
        .pipe(Effect.forkScoped);
      const initial = yield* chat.prepare({
        botId: secondId,
        runId: RunId.make("second-first"),
        message: { ...message("second-first", "user", "Second input"), threadId: secondThread },
      });
      assert.equal(initial.total, 0);
      const sink = yield* EventSink.EventSinkV2;
      const saved = yield* sink.write({
        events: [
          {
            id: EventId.make("first-output"),
            type: "message.updated",
            threadId,
            occurredAt: now,
            payload: message("first-output", "assistant", "First memory output. ".repeat(100)),
          },
          {
            id: EventId.make("second-output"),
            type: "message.updated",
            threadId: secondThread,
            occurredAt: now,
            payload: {
              ...message("second-output", "assistant", "Second memory output. ".repeat(100)),
              threadId: secondThread,
            },
          },
        ],
      });
      yield* Queue.offerAll(changes, saved);
      yield* Deferred.await(secondStarted);
      const next = yield* chat.prepare({
        botId: secondId,
        runId: RunId.make("second-next"),
        message: { ...message("second-next", "user", "Second follow-up"), threadId: secondThread },
      });
      assert.include(next.view, "Second input");
      assert.include(next.view, "Second memory summary");
      assert.notInclude(next.view, "First memory");
      assert.isUndefined(yield* storage.snapshot(botId, RunId.make("first-next")));
      yield* Deferred.succeed(releaseFirst, undefined);
      const firstNext = yield* Fiber.join(waiting);
      assert.include(firstNext.view, "First memory summary");
      assert.notInclude(firstNext.view, "Second memory");
    }).pipe(
      Effect.provide(
        makeLayer(
          {
            open: (id) =>
              Effect.succeed({
                send: () =>
                  id === botId
                    ? Deferred.succeed(firstStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseFirst)),
                        Effect.as("First memory summary"),
                      )
                    : Deferred.succeed(secondStarted, undefined).pipe(
                        Effect.as("Second memory summary"),
                      ),
              }),
          },
          Stream.fromQueue(changes),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect(
  "automatically creates one bot inside a checkout and reuses it across concurrent requests",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const process = yield* spawner.spawn(
        ChildProcess.make("git", ["init", "--quiet", config.baseDir]),
      );
      assert.equal(Number(yield* process.exitCode), 0);
      const chat = yield* BotChat.BotChat;
      const input = {
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        reuseExisting: true,
      };
      const identities = yield* Effect.all(
        [
          chat.create({ ...input, threadId: ThreadId.make("automatic-first") }),
          chat.create({ ...input, threadId: ThreadId.make("automatic-second") }),
        ],
        { concurrency: "unbounded" },
      );
      const first = identities[0];
      assert.deepEqual(identities[1], first);
      assert.notEqual(first.name, "Bot");
      assert.isNotEmpty(first.name);
      assert.lengthOf(yield* chat.list(), 1);
      const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
        first.threadId,
        [],
      );
      assert.equal(projection.thread.botId, first.id);
      assert.isNotNull(projection.thread.autoSettleDisabledAt);
      assert.isDefined(projection.thread.autoSettleDisabledAt);
      const project = yield* (yield* ProjectStore.ProjectStoreV2).get(projection.thread.projectId);
      assert.equal(project._tag, "Some");
      const path = yield* Path.Path;
      if (project._tag === "Some") {
        assert.equal(
          project.value.workspaceRoot,
          path.join(config.stateDir, "bots", `bot-${first.id}`, "workspace"),
        );
        assert.equal(project.value.title, first.name);
        assert.isTrue(project.value.isBot);
      }
      const fs = yield* FileSystem.FileSystem;
      assert.isTrue(yield* fs.exists(projection.thread.worktreePath ?? ""));
      const { botId: _botId, ...unboundThread } = projection.thread;
      yield* persist({
        id: EventId.make("interrupted-binding"),
        type: "thread.metadata-updated",
        threadId: first.threadId,
        occurredAt: now,
        payload: unboundThread,
      });
      const recovered = yield* chat.create({
        ...input,
        threadId: ThreadId.make("recovery-request"),
      });
      assert.equal(recovered.id, first.id);
      assert.equal(
        (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(first.threadId, []))
          .thread.botId,
        first.id,
      );
      yield* persist({
        id: EventId.make("enable-auto-settle"),
        type: "thread.metadata-updated",
        threadId: first.threadId,
        occurredAt: now,
        payload: { ...projection.thread, autoSettleDisabledAt: null },
      });
      const retried = yield* chat.create({
        ...input,
        threadId: first.threadId,
        reuseExisting: false,
      });
      assert.equal(retried.id, first.id);
      assert.isNull(
        (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(first.threadId, []))
          .thread.autoSettleDisabledAt,
      );
      const additional = yield* chat.create({
        ...input,
        threadId: ThreadId.make("manual-bot"),
        name: "Other",
        reuseExisting: false,
      });
      assert.notEqual(additional.id, first.id);
      const additionalThread = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
        additional.threadId,
        [],
      );
      assert.notEqual(additionalThread.thread.projectId, projection.thread.projectId);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("keeps each bot project named with its bot and deletes only that project", () =>
  Effect.gen(function* () {
    const chat = yield* BotChat.BotChat;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const first = yield* chat.create({
      threadId: ThreadId.make("project-first"),
      name: "Atlas",
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
    });
    const second = yield* chat.create({
      threadId: ThreadId.make("project-second"),
      name: "Nova",
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
    });
    const firstThread = yield* projections.getThread(first.threadId);
    const secondThread = yield* projections.getThread(second.threadId);
    assert.notEqual(firstThread.projectId, secondThread.projectId);
    yield* chat.rename(first.id, "Vega");
    assert.equal(Option.getOrThrow(yield* projects.get(firstThread.projectId)).title, "Vega");
    assert.equal(Option.getOrThrow(yield* projects.get(secondThread.projectId)).title, "Nova");
    const reset = yield* chat.reset(first.id);
    assert.equal((yield* projections.getThread(reset.threadId)).projectId, firstThread.projectId);
    yield* chat.remove(first.id);
    assert.isTrue(Option.isNone(yield* projects.get(firstThread.projectId)));
    assert.isTrue(Option.isSome(yield* projects.get(secondThread.projectId)));
    assert.equal((yield* chat.assertOwner(second.id)).name, "Nova");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "moves an existing bot and its archived subagents into its dedicated project on restart",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const childId = ThreadId.make("legacy-child");
      yield* persist({
        id: EventId.make("legacy-child"),
        type: "thread.created",
        threadId: childId,
        occurredAt: now,
        payload: {
          ...thread,
          id: childId,
          lineage: {
            parentThreadId: threadId,
            rootThreadId: threadId,
            relationshipToParent: "subagent",
          },
          archivedAt: now,
        },
      });
      const restartedContext = yield* Layer.build(
        Layer.fresh(BotChat.layer).pipe(
          Layer.provide(
            Layer.succeed(MemoryCompaction.MemoryCompaction, {
              open: () => Effect.die("No inference needed"),
            }),
          ),
        ),
      );
      const chat = Context.get(restartedContext, BotChat.BotChat);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const root = yield* projections.getThread(threadId);
      const child = yield* projections.getThread(childId);
      assert.notEqual(root.projectId, thread.projectId);
      assert.equal(child.projectId, root.projectId);
      assert.isNotNull(child.archivedAt);
      assert.equal((yield* chat.assertOwner(botId)).name, "Personal");
      const project = Option.getOrThrow(
        yield* (yield* ProjectStore.ProjectStoreV2).get(root.projectId),
      );
      assert.equal(project.title, "Personal");
      assert.isTrue(project.isBot);
    }).pipe(Effect.provide(layer)),
);

it.effect("discovers current local bots by name with pagination and follows resets", () =>
  Effect.gen(function* () {
    const chat = yield* BotChat.BotChat;
    const storage = yield* BotStorage.BotStorage;
    const input = { modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode };
    const atlas = yield* chat.create({
      ...input,
      threadId: ThreadId.make("discover-atlas"),
      name: "Atlas",
    });
    const polaris = yield* chat.create({
      ...input,
      threadId: ThreadId.make("discover-polaris"),
      name: "Polaris",
    });
    const removed = yield* chat.create({
      ...input,
      threadId: ThreadId.make("discover-removed"),
      name: "Removed",
    });
    yield* chat.remove(removed.id);
    yield* storage.create({
      ...atlas,
      id: BotId.make("remote-atlas"),
      threadId: ThreadId.make("remote-atlas"),
      ownerEnvironmentId: EnvironmentId.make("remote"),
    });
    const first = yield* chat.discover({ limit: 1 });
    assert.deepEqual(
      first.bots.map((bot) => bot.id),
      [atlas.id],
    );
    assert.equal(first.nextCursor, 1);
    const second = yield* chat.discover({ cursor: first.nextCursor!, limit: 1 });
    assert.deepEqual(
      second.bots.map((bot) => bot.id),
      [polaris.id],
    );
    assert.isNull(second.nextCursor);
    const reset = yield* chat.reset(polaris.id);
    assert.deepEqual(
      (yield* chat.discover({ query: "PoLa" })).bots.map((bot) => bot.threadId),
      [reset.threadId],
    );
    assert.lengthOf((yield* chat.discover({ query: "missing" })).bots, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("project rename and removal update the bot through the project service", () =>
  Effect.gen(function* () {
    const chat = yield* BotChat.BotChat;
    const bot = yield* chat.create({
      threadId,
      name: "Atlas",
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = (yield* projections.getThread(threadId)).projectId;
    const enrichment = {
      repositoryIdentity: null,
      faviconPath: null,
      repositoryIdentityResolved: true,
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
        getAvailable: () => Effect.succeed(enrichment),
        peek: () => Effect.succeed(enrichment),
        invalidate: () => Effect.void,
      }),
      ThreadCommands.layer,
      Layer.mock(WorkspacePaths.WorkspacePaths)({}),
      Layer.mock(LegacyImporter.LegacyV1ThreadImporter)({}),
      Layer.mock(ServerSettings.ServerSettingsService)({
        updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
    );
    const context = yield* Effect.context<
      Effect.Services<typeof ProjectService.make> | BotChat.BotChat
    >().pipe(Effect.provide(dependencies));
    const memoMap = yield* Layer.makeMemoMap;
    const scope = yield* Effect.scope;
    // The server's finalization observer acquires the offline project layer first.
    yield* Layer.buildWithMemoMap(ProjectService.layer, memoMap, scope).pipe(
      Effect.setContext(Context.omit(BotChat.BotChat)(context)),
    );
    const serverContext = yield* Layer.buildWithMemoMap(
      ProjectService.layerWithBots.pipe(Layer.provide(Layer.succeed(BotChat.BotChat, chat))),
      memoMap,
      scope,
    ).pipe(Effect.provideContext(context));
    const projects = Context.get(serverContext, ProjectService.ProjectService);
    const refused = yield* projects
      .delete({ projectId, commandId: CommandId.make("remove-without-confirmation") })
      .pipe(Effect.flip);
    assert.instanceOf(refused, ProjectService.ProjectNotEmptyError);
    yield* projects.update({
      projectId,
      commandId: CommandId.make("rename-project"),
      title: "Vega",
    });
    assert.equal((yield* chat.assertOwner(bot.id)).name, "Vega");
    assert.equal((yield* projections.getThread(threadId)).title, "Vega");
    const storage = yield* BotStorage.BotStorage;
    assert.include(
      (yield* storage.message(bot.id, 0))?.text ?? "",
      'Your name changed from "Atlas" to "Vega"',
    );
    yield* persist({
      id: EventId.make("project-busy"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: run("busy", "running"),
    });
    yield* projects
      .delete({ projectId, force: true, commandId: CommandId.make("remove-busy") })
      .pipe(Effect.flip);
    assert.equal((yield* chat.assertOwner(bot.id)).name, "Vega");
    assert.isNull((yield* projections.getThread(threadId)).deletedAt);
    yield* persist({
      id: EventId.make("project-idle"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: run("busy", "completed"),
    });
    const removed = yield* projects.delete({
      projectId,
      force: true,
      commandId: CommandId.make("remove-project"),
    });
    assert.isNotNull(removed.deletedAt);
    assert.equal((yield* storage.get(bot.id)).status, "deleted");
    assert.equal((yield* storage.memory(bot.id)).total, 0);
    assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps an automatically chosen name when creation resumes after the thread was saved",
  () =>
    Effect.gen(function* () {
      const { botId: _botId, ...unbound } = thread;
      yield* persist({
        id: EventId.make("interrupted-create"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: { ...unbound, title: "Sirius" },
      });
      const chat = yield* BotChat.BotChat;
      const bot = yield* chat.create({
        threadId,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
      });
      assert.equal(bot.name, "Sirius");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("gives unnamed bots distinct star names even after exhausting the base list", () =>
  Effect.gen(function* () {
    const chat = yield* BotChat.BotChat;
    const input = { modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode };
    const named = yield* chat.create({ ...input, threadId: ThreadId.make("named"), name: "vega" });
    const bots = yield* Effect.all(
      Array.from({ length: 25 }, (_, index) =>
        chat.create({ ...input, threadId: ThreadId.make(`star-${index}`) }),
      ),
      { concurrency: "unbounded" },
    );
    assert.equal(named.name, "vega");
    const names = bots.map((bot) => bot.name.toLowerCase());
    assert.equal(new Set(names).size, bots.length);
    assert.notInclude(names, "vega");
    assert.isTrue(names.some((name) => name.endsWith(" 2")));
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    for (const bot of bots)
      assert.equal((yield* projections.getThreadRecords(bot.threadId, [])).thread.title, bot.name);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "keeps a delegated completion wake in the next frozen view after the prior session ends",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const chat = yield* BotChat.BotChat;
      const first = message("delegate", "user", "Inspect the project");
      yield* chat.prepare({ botId, runId: RunId.make("delegate"), message: first });
      yield* persist({
        id: EventId.make("delegate:done"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: run("delegate", "completed"),
      });
      const completion = {
        ...message(
          "completion-wake",
          "user",
          "Task task:42 completed in thread worker:42. Found the missing configuration.",
        ),
        createdBy: "system" as const,
        creationSource: "server" as const,
      };
      const frozen = yield* chat.prepare({
        botId,
        runId: completion.runId!,
        message: completion,
      });
      assert.include(frozen.view, "Inspect the project");
      const next = message("follow-up", "user", "Explain the findings");
      const nextView = yield* chat.prepare({ botId, runId: next.runId!, message: next });
      assert.include(nextView.view, "task:42");
      assert.include(nextView.view, "worker:42");
      assert.include(nextView.view, "Found the missing configuration");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "reset retains the identity and model while replacing its conversation and frozen history",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const chat = yield* BotChat.BotChat;
      const storage = yield* BotStorage.BotStorage;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* chat.prepare({
        botId,
        runId: RunId.make("before-reset"),
        message: message("before-reset", "user", "Old private memory"),
      });
      const reset = yield* chat.reset(botId);
      assert.equal(reset.id, botId);
      assert.equal(reset.name, "Personal");
      assert.equal(reset.ownerEnvironmentId, owner);
      assert.equal(reset.generation, 1);
      assert.notEqual(reset.threadId, threadId);
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
      const fresh = yield* projections.getThread(reset.threadId);
      assert.deepEqual(fresh.modelSelection, thread.modelSelection);
      assert.equal(fresh.botId, botId);
      assert.equal(fresh.lineage.rootThreadId, reset.threadId);
      assert.equal((yield* storage.memory(botId)).total, 0);
      const frozen = yield* chat.prepare({
        botId,
        runId: RunId.make("after-reset"),
        message: { ...message("after-reset", "user", "Hello"), threadId: reset.threadId },
      });
      assert.equal(frozen.total, 0);
      assert.notInclude(frozen.view, "Old private memory");
      const stale = yield* chat
        .prepare({
          botId,
          runId: RunId.make("stale"),
          message: message("stale", "user", "Old thread"),
        })
        .pipe(Effect.flip);
      assert.equal(stale.reason, "not-owner");
    }).pipe(Effect.provide(layer)),
);

it.effect("delete clears memory history and hides the root and its archived descendants", () =>
  Effect.gen(function* () {
    yield* setup;
    const chat = yield* BotChat.BotChat;
    const storage = yield* BotStorage.BotStorage;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const childId = ThreadId.make("archived-child");
    yield* persist({
      id: EventId.make("child-created"),
      type: "thread.created",
      threadId: childId,
      occurredAt: now,
      payload: {
        ...thread,
        id: childId,
        archivedAt: now,
        lineage: {
          rootThreadId: threadId,
          parentThreadId: threadId,
          relationshipToParent: "subagent",
        },
      },
    });
    yield* chat.prepare({
      botId,
      runId: RunId.make("before-delete"),
      message: message("before-delete", "user", "Forget this"),
    });
    yield* chat.remove(botId);
    const deleted = yield* storage.get(botId);
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.generation, 1);
    assert.equal((yield* storage.memory(botId)).total, 0);
    assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    assert.isNotNull((yield* projections.getThread(childId)).deletedAt);
    assert.equal((yield* chat.assertOwner(botId).pipe(Effect.flip)).reason, "not-owner");
  }).pipe(Effect.provide(layer)),
);

it.effect("reset and delete reject a running bot without discarding its history", () =>
  Effect.gen(function* () {
    yield* setup;
    const chat = yield* BotChat.BotChat;
    const storage = yield* BotStorage.BotStorage;
    yield* chat.prepare({
      botId,
      runId: RunId.make("busy"),
      message: message("busy", "user", "Keep this"),
    });
    yield* persist({
      id: EventId.make("busy-run"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: run("busy", "running"),
    });
    assert.equal((yield* chat.reset(botId).pipe(Effect.flip)).reason, "busy");
    assert.equal((yield* chat.remove(botId).pipe(Effect.flip)).reason, "busy");
    assert.equal((yield* storage.get(botId)).status, "active");
    assert.equal((yield* storage.memory(botId)).total, 1);
  }).pipe(Effect.provide(layer)),
);

const persistBotDelegation = Effect.fn("BotChat.test.delegate")(function* (
  parent: OrchestrationV2AppThread,
  childId: ThreadId,
  parentRunId: RunId,
  origin: "app_owned" | "provider_native" = "app_owned",
) {
  const child: OrchestrationV2AppThread = {
    ...parent,
    id: childId,
    botId: undefined,
    lineage: {
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
      rootThreadId: parent.lineage.rootThreadId,
    },
  };
  yield* persist({
    id: EventId.make(`thread:${childId}`),
    type: "thread.created",
    threadId: childId,
    occurredAt: now,
    payload: child,
  });
  yield* persist({
    id: EventId.make(`task:${childId}`),
    type: "subagent.updated",
    threadId: parent.id,
    occurredAt: now,
    payload: {
      id: NodeId.make(`task:${childId}`),
      threadId: parent.id,
      runId: parentRunId,
      parentNodeId: NodeId.make(`root:${parentRunId}`),
      origin,
      createdBy: "agent",
      driver: ProviderDriverKind.make("pi"),
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId: childId,
      nativeTaskRef: null,
      prompt: "Inspect the project",
      title: "Worker",
      model: "test",
      status: "completed",
      result: "Done",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    },
  });
  return child;
});

it.effect(
  "inherits the original frozen view only through app-owned delegation, including nested tasks",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const storage = yield* BotStorage.BotStorage;
      const chat = yield* BotChat.BotChat;
      const firstRun = RunId.make("parent-first");
      const original = { botId, runId: firstRun, total: 1, view: "original frozen view" };
      yield* storage.freeze(original);
      const child = yield* persistBotDelegation(thread, ThreadId.make("worker"), firstRun);
      const nested = yield* persistBotDelegation(
        child,
        ThreadId.make("nested-worker"),
        RunId.make("child-run"),
      );
      yield* storage.freeze({
        botId,
        runId: RunId.make("parent-later"),
        total: 2,
        view: "later view",
      });
      assert.deepEqual(yield* chat.delegatedContext(child), { threadId, snapshot: original });
      assert.deepEqual(yield* chat.delegatedContext(nested), { threadId, snapshot: original });
      assert.isUndefined(yield* chat.delegatedContext(thread));
      assert.isUndefined(
        yield* chat.delegatedContext({
          ...child,
          lineage: { ...child.lineage, relationshipToParent: "fork" },
        }),
      );
      const native = yield* persistBotDelegation(
        thread,
        ThreadId.make("native-worker"),
        firstRun,
        "provider_native",
      );
      assert.isUndefined(yield* chat.delegatedContext(native));
      const descendant = yield* persistBotDelegation(
        native,
        ThreadId.make("native-descendant"),
        RunId.make("native-run"),
      );
      assert.isUndefined(yield* chat.delegatedContext(descendant));
      const missing = yield* persistBotDelegation(
        thread,
        ThreadId.make("missing-snapshot"),
        RunId.make("unknown"),
      );
      assert.equal((yield* Effect.result(chat.delegatedContext(missing)))._tag, "Failure");
      yield* storage.reset(botId, ThreadId.make("replacement-bot-thread"));
      assert.isUndefined(yield* chat.delegatedContext(child));
    }).pipe(Effect.provide(layer)),
);
