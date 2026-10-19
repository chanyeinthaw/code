import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  TurnItemId,
  EnvironmentId,
  EventId,
  MemoryId,
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
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as MemoryChat from "./MemoryChat.ts";
import * as MemoryCompaction from "./MemoryCompaction.ts";
import * as MemoryOwnership from "./MemoryOwnership.ts";
import * as MemoryStorage from "./MemoryStorage.ts";
import * as MemoryTransferFiles from "./MemoryTransferFiles.ts";

const owner = EnvironmentId.make("owner");
const memoryId = MemoryId.make("personal");
const threadId = ThreadId.make("memory-thread");
const instanceId = ProviderInstanceId.make("pi");
const now = DateTime.makeUnsafe("2026-10-20T00:00:00Z");
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("memory-project"),
  title: "Memory",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  memoryIdentityId: memoryId,
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
const dependencies = (eventStream: Stream.Stream<OrchestrationV2StoredEvent>) =>
  Layer.mergeAll(
    MemoryStorage.layer,
    ProjectionStore.layer,
    EventStore.layer,
    Layer.mock(MemoryOwnership.MemoryOwnership)({ packageFor: () => Effect.succeed(undefined) }),
    Layer.mock(MemoryTransferFiles.MemoryTransferFiles)({}),
    ProjectStore.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(owner),
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
) =>
  MemoryChat.layer.pipe(
    Layer.provideMerge(dependencies(eventStream)),
    Layer.provide(Layer.succeed(MemoryCompaction.MemoryCompaction, compaction)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-chat-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const layer = makeLayer({ open: () => Effect.die("Short messages need no inference") });
const persist = Effect.fn("MemoryChat.test.persist")(function* (event: OrchestrationV2DomainEvent) {
  yield* (yield* EventStore.OrchestrationEventStore).appendAgentEvents({ events: [event] });
  yield* (yield* ProjectionStore.ProjectionStoreV2).apply(event);
});
const setup = Effect.gen(function* () {
  const storage = yield* MemoryStorage.MemoryStorage;
  yield* storage.create({
    id: memoryId,
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
  "journals prior output and freezes a retry-stable view before appending the current input",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const chat = yield* MemoryChat.MemoryChat;
      const storage = yield* MemoryStorage.MemoryStorage;
      const first = message("first", "user", "Remember the name Chan");
      const initial = yield* chat.prepare({ memoryId, runId: RunId.make("first"), message: first });
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
      const frozen = yield* chat.prepare({ memoryId, runId: RunId.make("next"), message: next });
      assert.equal(frozen.total, 2);
      assert.include(frozen.view, "Remember the name Chan");
      assert.include(frozen.view, "Your name is Chan");
      assert.notInclude(frozen.view, "What is my name?");
      assert.deepEqual(
        yield* chat.prepare({ memoryId, runId: RunId.make("next"), message: next }),
        frozen,
      );
      assert.equal((yield* storage.memory(memoryId)).total, 3);
    }).pipe(Effect.provide(layer)),
);

it.effect("retains the user input of a run that fails before its view freezes", () =>
  Effect.gen(function* () {
    yield* setup;
    const chat = yield* MemoryChat.MemoryChat;
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
    const frozen = yield* chat.prepare({ memoryId, runId: RunId.make("next"), message: next });
    assert.equal(frozen.total, 1);
    assert.include(frozen.view, "Keep this failed request");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects ownership transfer while any turn is preparing, queued, starting, running, or waiting",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const chat = yield* MemoryChat.MemoryChat;
      const storage = yield* MemoryStorage.MemoryStorage;
      for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
        yield* persist({
          id: EventId.make(`run-${status}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: run("busy", status),
        });
        const rejected = yield* Effect.flip(
          chat.beginTransfer(memoryId, EnvironmentId.make("target")),
        );
        assert.equal(rejected.reason, "busy");
        assert.equal((yield* storage.get(memoryId)).status, "active");
      }
    }).pipe(Effect.provide(layer)),
);

it.effect("defers compaction until the foreground run ends, even with a newer queued run", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<string>();
    const changes = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    yield* Effect.gen(function* () {
      yield* setup;
      const chat = yield* MemoryChat.MemoryChat;
      const storage = yield* MemoryStorage.MemoryStorage;
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
        memoryId,
        runId: RunId.make("long"),
        message: message("long", "user", "Remember Chan. ".repeat(100)),
      });
      assert.equal(frozen.total, 0);
      assert.isFalse(yield* Deferred.isDone(started));
      assert.isTrue(yield* storage.memoryRecoveryDue(memoryId));
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
        memoryId,
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
    const chat = yield* MemoryChat.MemoryChat;
    yield* chat.prepare({
      memoryId,
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
      memoryId,
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
    const secondId = MemoryId.make("second");
    const secondThread = ThreadId.make("second-thread");
    yield* Effect.gen(function* () {
      yield* setup;
      const storage = yield* MemoryStorage.MemoryStorage;
      const chat = yield* MemoryChat.MemoryChat;
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
          memoryIdentityId: secondId,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: secondThread },
        },
      });
      yield* chat.prepare({
        memoryId,
        runId: RunId.make("first-long"),
        message: message("first-long", "user", "First memory input. ".repeat(100)),
      });
      yield* Deferred.await(firstStarted);
      const waiting = yield* chat
        .prepare({
          memoryId,
          runId: RunId.make("first-next"),
          message: message("first-next", "user", "First follow-up"),
        })
        .pipe(Effect.forkScoped);
      const initial = yield* chat.prepare({
        memoryId: secondId,
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
        memoryId: secondId,
        runId: RunId.make("second-next"),
        message: { ...message("second-next", "user", "Second follow-up"), threadId: secondThread },
      });
      assert.include(next.view, "Second input");
      assert.include(next.view, "Second memory summary");
      assert.notInclude(next.view, "First memory");
      assert.isUndefined(yield* storage.snapshot(memoryId, RunId.make("first-next")));
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
                  id === memoryId
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
  "automatically creates one memory inside a checkout and reuses it across concurrent requests",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const process = yield* spawner.spawn(
        ChildProcess.make("git", ["init", "--quiet", config.baseDir]),
      );
      assert.equal(Number(yield* process.exitCode), 0);
      const chat = yield* MemoryChat.MemoryChat;
      const input = {
        name: "Chat",
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
      assert.lengthOf(yield* chat.list(), 1);
      const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
        first.threadId,
        [],
      );
      assert.equal(projection.thread.memoryIdentityId, first.id);
      const project = yield* (yield* ProjectStore.ProjectStoreV2).get(projection.thread.projectId);
      assert.equal(project._tag, "Some");
      const path = yield* Path.Path;
      if (project._tag === "Some") {
        assert.equal(project.value.workspaceRoot, path.join(config.stateDir, "memory"));
        assert.isTrue(project.value.isMemory);
      }
      const fs = yield* FileSystem.FileSystem;
      assert.isTrue(yield* fs.exists(projection.thread.worktreePath ?? ""));
      const { memoryIdentityId: _memoryIdentityId, ...unboundThread } = projection.thread;
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
          .thread.memoryIdentityId,
        first.id,
      );
      const retried = yield* chat.create({
        ...input,
        threadId: first.threadId,
        reuseExisting: false,
      });
      assert.equal(retried.id, first.id);
      const additional = yield* chat.create({
        ...input,
        threadId: ThreadId.make("manual-memory"),
        name: "Other",
        reuseExisting: false,
      });
      assert.notEqual(additional.id, first.id);
      const additionalThread = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
        additional.threadId,
        [],
      );
      assert.equal(additionalThread.thread.projectId, projection.thread.projectId);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "keeps a delegated completion wake in the next frozen view after the prior session ends",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const chat = yield* MemoryChat.MemoryChat;
      const first = message("delegate", "user", "Inspect the project");
      yield* chat.prepare({ memoryId, runId: RunId.make("delegate"), message: first });
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
        memoryId,
        runId: completion.runId!,
        message: completion,
      });
      assert.include(frozen.view, "Inspect the project");
      const next = message("follow-up", "user", "Explain the findings");
      const nextView = yield* chat.prepare({ memoryId, runId: next.runId!, message: next });
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
      const chat = yield* MemoryChat.MemoryChat;
      const storage = yield* MemoryStorage.MemoryStorage;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* chat.prepare({
        memoryId,
        runId: RunId.make("before-reset"),
        message: message("before-reset", "user", "Old private memory"),
      });
      const reset = yield* chat.reset(memoryId);
      assert.equal(reset.id, memoryId);
      assert.equal(reset.name, "Personal");
      assert.equal(reset.ownerEnvironmentId, owner);
      assert.equal(reset.generation, 1);
      assert.notEqual(reset.threadId, threadId);
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
      const fresh = yield* projections.getThread(reset.threadId);
      assert.deepEqual(fresh.modelSelection, thread.modelSelection);
      assert.equal(fresh.memoryIdentityId, memoryId);
      assert.equal(fresh.lineage.rootThreadId, reset.threadId);
      assert.equal((yield* storage.memory(memoryId)).total, 0);
      const frozen = yield* chat.prepare({
        memoryId,
        runId: RunId.make("after-reset"),
        message: { ...message("after-reset", "user", "Hello"), threadId: reset.threadId },
      });
      assert.equal(frozen.total, 0);
      assert.notInclude(frozen.view, "Old private memory");
      const stale = yield* chat
        .prepare({
          memoryId,
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
    const chat = yield* MemoryChat.MemoryChat;
    const storage = yield* MemoryStorage.MemoryStorage;
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
      memoryId,
      runId: RunId.make("before-delete"),
      message: message("before-delete", "user", "Forget this"),
    });
    yield* chat.remove(memoryId);
    const deleted = yield* storage.get(memoryId);
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.generation, 1);
    assert.equal((yield* storage.memory(memoryId)).total, 0);
    assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    assert.isNotNull((yield* projections.getThread(childId)).deletedAt);
    assert.equal((yield* chat.assertOwner(memoryId).pipe(Effect.flip)).reason, "not-owner");
  }).pipe(Effect.provide(layer)),
);

it.effect("reset and delete reject a running memory without discarding its history", () =>
  Effect.gen(function* () {
    yield* setup;
    const chat = yield* MemoryChat.MemoryChat;
    const storage = yield* MemoryStorage.MemoryStorage;
    yield* chat.prepare({
      memoryId,
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
    assert.equal((yield* chat.reset(memoryId).pipe(Effect.flip)).reason, "busy");
    assert.equal((yield* chat.remove(memoryId).pipe(Effect.flip)).reason, "busy");
    assert.equal((yield* storage.get(memoryId)).status, "active");
    assert.equal((yield* storage.memory(memoryId)).total, 1);
  }).pipe(Effect.provide(layer)),
);

const persistMemoryDelegation = Effect.fn("MemoryChat.test.delegate")(function* (
  parent: OrchestrationV2AppThread,
  childId: ThreadId,
  parentRunId: RunId,
  origin: "app_owned" | "provider_native" = "app_owned",
) {
  const child: OrchestrationV2AppThread = {
    ...parent,
    id: childId,
    memoryIdentityId: undefined,
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
      const storage = yield* MemoryStorage.MemoryStorage;
      const chat = yield* MemoryChat.MemoryChat;
      const firstRun = RunId.make("parent-first");
      const original = { memoryId, runId: firstRun, total: 1, view: "original frozen view" };
      yield* storage.freeze(original);
      const child = yield* persistMemoryDelegation(thread, ThreadId.make("worker"), firstRun);
      const nested = yield* persistMemoryDelegation(
        child,
        ThreadId.make("nested-worker"),
        RunId.make("child-run"),
      );
      yield* storage.freeze({
        memoryId,
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
      const native = yield* persistMemoryDelegation(
        thread,
        ThreadId.make("native-worker"),
        firstRun,
        "provider_native",
      );
      assert.isUndefined(yield* chat.delegatedContext(native));
      const descendant = yield* persistMemoryDelegation(
        native,
        ThreadId.make("native-descendant"),
        RunId.make("native-run"),
      );
      assert.isUndefined(yield* chat.delegatedContext(descendant));
      const missing = yield* persistMemoryDelegation(
        thread,
        ThreadId.make("missing-snapshot"),
        RunId.make("unknown"),
      );
      assert.equal((yield* Effect.result(chat.delegatedContext(missing)))._tag, "Failure");
      yield* storage.reset(memoryId, ThreadId.make("replacement-memory-thread"));
      assert.isUndefined(yield* chat.delegatedContext(child));
    }).pipe(Effect.provide(layer)),
);
