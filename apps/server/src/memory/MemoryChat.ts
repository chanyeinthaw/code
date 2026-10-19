import { planProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as ServerConfig from "../config.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import { makeEnsureWorkspace } from "./MemoryWorkspace.ts";
import {
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  type EnvironmentId,
  ProjectId,
  ThreadId,
  CommandId,
  type ModelSelection,
  type RuntimeMode,
  type MemoryTransfer,
  MemoryChatError,
  MemoryId,
  type MemoryIdentity,
  type MemoryMessage,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ConversationMessage,
  type RunId,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as MemoryOwnership from "./MemoryOwnership.ts";
import * as TransferFiles from "./MemoryTransferFiles.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as MemoryStorage from "./MemoryStorage.ts";
import * as MemoryCompaction from "./MemoryCompaction.ts";
import { makeMemory } from "./MemoryWorker.ts";
import { memoryTurnItem } from "./MemoryTurnItem.ts";

const isMemoryChatError = Schema.is(MemoryChatError);
const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);
const isAppThread = Schema.is(OrchestrationV2AppThread);

const memoryError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isMemoryChatError(cause)
          ? cause
          : new MemoryChatError({ operation, reason: "storage", cause }),
      ),
    );

function userMemory(message: OrchestrationV2ConversationMessage): Omit<MemoryMessage, "id"> {
  return {
    key: `message:${message.id}`,
    kind: "user",
    text:
      message.text +
      (message.attachments.length === 0
        ? ""
        : `\nAttachments: ${message.attachments.map((attachment) => `${attachment.id}: ${attachment.name}`).join("\n")}`),
    date: DateTime.formatIso(message.createdAt),
  };
}

const make = Effect.gen(function* () {
  const ensureWorkspace = yield* makeEnsureWorkspace;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const transferFiles = yield* TransferFiles.MemoryTransferFiles;
  const storage = yield* MemoryStorage.MemoryStorage;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const ownership = yield* MemoryOwnership.MemoryOwnership;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const compaction = yield* MemoryCompaction.MemoryCompaction;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const events = yield* EventStore.OrchestrationEventStore;
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const ownerEnvironmentId = yield* environment.getEnvironmentId;
  // Retain each lock across worker replacement so transfers and turns for one memory stay serialized.
  const operationLocks = yield* Cache.makeWith(() => Semaphore.make(1), {
    capacity: Infinity,
    timeToLive: () => Infinity,
  });
  const withOperation =
    (id: MemoryId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Cache.get(operationLocks, id).pipe(Effect.flatMap((lock) => lock.withPermit(effect)));
  const creationGate = yield* Semaphore.make(1);
  const projectGate = yield* Semaphore.make(1);
  const fibers = yield* FiberMap.make<MemoryId>();
  const workers = yield* Cache.makeWith(
    (id: MemoryId) =>
      Effect.gen(function* () {
        return {
          worker: yield* makeMemory(id, (view) => compaction.open(id, view)),
          signal: yield* Queue.sliding<void>(1),
        };
      }),
    { capacity: Infinity, timeToLive: () => Infinity },
  );
  const assertOwner = Effect.fn("MemoryChat.assertOwner")(function* (id: MemoryId) {
    const memory = yield* storage.get(id);
    if (memory.ownerEnvironmentId !== ownerEnvironmentId || memory.status !== "active")
      return yield* new MemoryChatError({ operation: "owner", reason: "not-owner" });
    return memory;
  });
  const bindThread = Effect.fn("MemoryChat.bindThread")(
    function* (input: { threadId: ThreadId; name: string }) {
      const projection = yield* projections.getThreadRecords(input.threadId, ["runs", "messages"]);
      if (projection.thread.memoryIdentityId)
        return yield* storage.get(projection.thread.memoryIdentityId);
      if (projection.runs.length || projection.messages.length)
        return yield* new MemoryChatError({ operation: "create", reason: "busy" });
      const existing = yield* storage.forThread(input.threadId);
      const identity: MemoryIdentity = existing ?? {
        id: MemoryId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
        name: input.name,
        ownerEnvironmentId,
        threadId: input.threadId,
        generation: 0,
        status: "active",
        destinationEnvironmentId: null,
      };
      const workspace = yield* ensureWorkspace(identity.id);
      // The identity is authoritative before a thread can advertise its binding.
      if (!existing) yield* storage.create(identity);
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId: input.threadId }),
            type: "thread.metadata-updated",
            threadId: input.threadId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...projection.thread,
              memoryIdentityId: identity.id,
              worktreePath: workspace,
            },
          },
        ],
      });
      return identity;
    },
    (effect, input) => storage.withMemory(`thread:${input.threadId}`, effect),
    memoryError("create"),
  );
  const ensureProject = Effect.fn("MemoryChat.ensureProject")(
    function* () {
      const workspaceRoot = path.join(config.stateDir, "memory");
      const existing = yield* projects.findActiveByWorkspaceRoot(workspaceRoot);
      if (Option.isSome(existing)) return existing.value.projectId;
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      const projectId = ProjectId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const commandId = CommandId.make(`memory-project:${projectId}`);
      const now = yield* DateTime.now;
      const planned = planProjectCommand({
        command: {
          type: "project.create",
          commandId,
          projectId,
          title: "Memory",
          isMemory: true,
          workspaceRoot,
        },
        state: { project: undefined, workspaceOwner: undefined },
        eventId: yield* ids.allocate.event({ commandId }),
        now,
      });
      if (Result.isFailure(planned)) return yield* planned.failure;
      yield* sink.commitProjectCommand({
        commandId,
        projectId,
        commandType: "project.create",
        acceptedAt: now,
        event: planned.success,
      });
      return projectId;
    },
    (effect) => projectGate.withPermit(effect),
  );
  const create = Effect.fn("MemoryChat.create")(
    function* (input: {
      threadId: ThreadId;
      name: string;
      modelSelection: ModelSelection;
      runtimeMode: RuntimeMode;
      reuseExisting?: boolean;
    }) {
      if (input.reuseExisting) {
        const existing = (yield* storage.list()).find(
          (memory) =>
            memory.status === "active" && memory.ownerEnvironmentId === ownerEnvironmentId,
        );
        if (existing)
          return yield* bindThread({ threadId: existing.threadId, name: existing.name });
      }
      if (!(yield* projections.getThreadShell(input.threadId))) {
        const projectId = yield* ensureProject();
        const now = yield* DateTime.now;
        const thread: OrchestrationV2AppThread = {
          id: input.threadId,
          projectId,
          title: input.name,
          providerInstanceId: input.modelSelection.instanceId,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: input.threadId,
          },
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
        yield* sink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId: input.threadId }),
              type: "thread.created",
              threadId: input.threadId,
              providerInstanceId: input.modelSelection.instanceId,
              occurredAt: now,
              payload: thread,
            },
          ],
        });
      }
      return yield* bindThread(input);
    },
    (effect) => creationGate.withPermit(effect),
    memoryError("create"),
  );
  const record = Effect.fn("MemoryChat.record")(function* (
    id: MemoryId,
    stored: OrchestrationV2StoredEvent,
  ) {
    const event = stored.event;
    if (event.type === "message.updated" && !event.payload.streaming) {
      const message = event.payload;
      if (message.role === "user") {
        // Queued input enters memory only when its turn consumes it.
        if (message.runId !== null && (yield* storage.snapshot(id, message.runId)))
          yield* storage.append(id, [userMemory(message)]);
      } else if (message.role === "assistant") {
        yield* storage.append(id, [
          {
            key: `message:${message.id}`,
            kind: "talk",
            text: message.text,
            date: DateTime.formatIso(message.createdAt),
          },
        ]);
      }
    } else if (
      event.type === "run.updated" &&
      ["completed", "failed", "interrupted", "cancelled"].includes(event.payload.status)
    ) {
      // Input from a turn that failed before freezing still belongs in the next turn's memory.
      const projection = yield* projections.getThreadRecords(event.threadId, ["messages"], {
        runIds: [event.payload.id],
      });
      yield* storage.append(
        id,
        projection.messages
          .filter((message) => message.role === "user" && message.runId === event.payload.id)
          .map(userMemory),
      );
    } else if (event.type === "turn-item.updated") {
      yield* storage.append(id, memoryTurnItem(event.payload));
    }
    yield* storage.advance(id, stored.sequence);
  });
  const synchronize = Effect.fn("MemoryChat.synchronize")(function* (memory: MemoryIdentity) {
    const current = yield* storage.get(memory.id);
    if (current.status !== "active" || current.threadId !== memory.threadId) return;
    const afterSequence = yield* storage.cursor(memory.id);
    yield* events
      .readAgentEvents({ threadId: memory.threadId, afterSequence })
      .pipe(Stream.runForEach((event) => record(memory.id, event)));
  });
  const wake = Effect.fn("MemoryChat.wake")(function* (id: MemoryId) {
    const entry = yield* Cache.get(workers, id);
    yield* Queue.offer(entry.signal, undefined);
    yield* FiberMap.run(
      fibers,
      id,
      Effect.forever(
        Effect.gen(function* () {
          yield* Queue.take(entry.signal);
          yield* withOperation(id)(
            Effect.gen(function* () {
              const memory = yield* assertOwner(id);
              const thread = yield* projections.getThreadShell(memory.threadId);
              // Preparation drains old jobs itself; new input and output wait for this reply to end.
              if (
                thread &&
                ["preparing", "starting", "running", "waiting"].includes(
                  thread.activityRunStatus ?? thread.status,
                )
              )
                return;
              yield* entry.worker.pump();
            }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Memory compaction failed", { memoryId: id, cause }),
            ),
          );
        }),
      ),
      { onlyIfMissing: true },
    );
  });
  const prepare = Effect.fn("MemoryChat.prepare")(function* (input: {
    memoryId: MemoryId;
    runId: RunId;
    message: OrchestrationV2ConversationMessage;
  }) {
    const frozen = yield* withOperation(input.memoryId)(
      Effect.gen(function* () {
        const memory = yield* assertOwner(input.memoryId);
        if (memory.threadId !== input.message.threadId)
          return yield* new MemoryChatError({ operation: "prepare", reason: "not-owner" });
        const previous = yield* storage.snapshot(memory.id, input.runId);
        if (previous) {
          yield* storage.append(memory.id, [userMemory(input.message)]);
          return previous;
        }
        yield* synchronize(memory);
        const { worker } = yield* Cache.get(workers, memory.id);
        const view = yield* worker.settle();
        const state = yield* storage.memory(memory.id);
        return yield* storage.freezeAndAppend(
          {
            memoryId: memory.id,
            runId: input.runId,
            total: state.total,
            view,
          },
          userMemory(input.message),
        );
      }),
    );
    yield* wake(input.memoryId);
    return frozen;
  }, memoryError("prepare"));
  const ensureIdle = Effect.fn("MemoryChat.ensureIdle")(function* (threadId: ThreadId) {
    if (!(yield* projections.getThreadShell(threadId))) return;
    const projection = yield* projections.getThreadRecords(threadId, ["runs"]);
    if (
      projection.runs.some((run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
      )
    )
      return yield* new MemoryChatError({ operation: "transfer", reason: "busy" });
  });
  const changeHistory = Effect.fn("MemoryChat.changeHistory")(
    function* (id: MemoryId, operation: "reset" | "delete") {
      const current = yield* assertOwner(id);
      const active = yield* projections.getShellSnapshot();
      for (const member of [...active.threads, ...active.archivedThreads]) {
        if (member.id === current.threadId || member.lineage.rootThreadId === current.threadId)
          yield* ensureIdle(member.id);
      }
      // Stop compaction before taking its operation lock; no old job may repopulate the tree.
      yield* FiberMap.remove(fibers, id);
      return yield* withOperation(id)(
        Effect.gen(function* () {
          const memory = yield* assertOwner(id);
          const snapshot = yield* projections.getShellSnapshot();
          const family = [...snapshot.threads, ...snapshot.archivedThreads].filter(
            (thread) =>
              thread.id === memory.threadId || thread.lineage.rootThreadId === memory.threadId,
          );
          for (const member of family) yield* ensureIdle(member.id);
          const thread = yield* projections.getThread(memory.threadId);
          const now = yield* DateTime.now;
          const nextThreadId = ThreadId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
          const nextThread: OrchestrationV2AppThread = {
            ...thread,
            id: nextThreadId,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: nextThreadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            archivedAt: null,
            settledAt: null,
            settledOverride: null,
            lastVisitedAt: null,
            titleRegeneration: null,
          };
          const deleted = yield* Effect.forEach(family, (member) =>
            Effect.gen(function* () {
              const current = yield* projections.getThread(member.id);
              return {
                id: yield* ids.allocate.event({ threadId: member.id }),
                type: "thread.deleted" as const,
                threadId: member.id,
                occurredAt: now,
                payload: { ...current, deletedAt: now, updatedAt: now },
              };
            }),
          );
          const created = {
            id: yield* ids.allocate.event({ threadId: nextThreadId }),
            type: "thread.created" as const,
            threadId: nextThreadId,
            occurredAt: now,
            payload: nextThread,
          };
          const result = yield* sql.withTransaction(
            Effect.gen(function* () {
              let identity: MemoryIdentity | null = null;
              if (operation === "reset") identity = yield* storage.reset(id, nextThreadId);
              else yield* storage.remove(id);
              yield* sink.write({
                events: operation === "reset" ? [...deleted, created] : deleted,
              });
              return identity;
            }),
          );
          yield* Cache.invalidate(workers, id);
          return result;
        }),
      );
    },
    (effect, id) =>
      Effect.gen(function* () {
        const memory = yield* assertOwner(id);
        return yield* threadCommands.withLock(
          memory.threadId,
          Effect.gen(function* () {
            if ((yield* assertOwner(id)).threadId !== memory.threadId)
              return yield* new MemoryChatError({ operation: "change-history", reason: "busy" });
            return yield* effect;
          }),
        );
      }),
    memoryError("change-history"),
  );
  const reset = Effect.fn("MemoryChat.reset")(function* (id: MemoryId) {
    const memory = yield* changeHistory(id, "reset");
    if (!memory) return yield* new MemoryChatError({ operation: "reset", reason: "storage" });
    return memory;
  });
  const remove = Effect.fn("MemoryChat.remove")(function* (id: MemoryId) {
    yield* changeHistory(id, "delete");
  });
  const beginTransfer = Effect.fn("MemoryChat.beginTransfer")(
    function* (id: MemoryId, destination: EnvironmentId) {
      return yield* withOperation(id)(
        Effect.gen(function* () {
          const memory = yield* storage.get(id);
          const saved = yield* ownership.packageFor(id);
          if (saved && (memory.status === "transferring" || memory.status === "forwarded")) {
            if (saved.destinationEnvironmentId !== destination)
              return yield* new MemoryChatError({
                operation: "transfer",
                reason: "invalid-transfer",
              });
            return yield* ownership.describe(id, saved.transferId);
          }
          if (
            memory.ownerEnvironmentId !== ownerEnvironmentId ||
            !["active", "transferring"].includes(memory.status)
          )
            return yield* new MemoryChatError({ operation: "transfer", reason: "not-owner" });
          yield* ensureIdle(memory.threadId);
          if (memory.status === "active") yield* synchronize(memory);
          yield* FiberMap.remove(fibers, id);
          const core = yield* ownership.prepare(id, destination);
          const history = yield* events
            .readAgentEvents({ threadId: memory.threadId })
            .pipe(Stream.runCollect);
          const transfer: MemoryTransfer = {
            ...core,
            events: history.map((stored) => stored.event),
            workspace: yield* transferFiles.exportWorkspace(id),
            attachments: yield* transferFiles.exportAttachments(
              history.flatMap((stored) =>
                stored.event.type === "message.updated" ? stored.event.payload.attachments : [],
              ),
            ),
          };
          yield* ownership.savePackage(transfer);
          return yield* ownership.describe(id, transfer.transferId);
        }),
      );
    },
    (effect, id) =>
      Effect.gen(function* () {
        const memory = yield* storage.get(id);
        return yield* threadCommands.withLock(memory.threadId, effect);
      }),
    memoryError("transfer-export"),
  );
  const stageTransfer = Effect.fn("MemoryChat.stageTransfer")(function* (
    transferId: string,
    length: number,
  ) {
    const projectId = yield* ensureProject().pipe(memoryError("transfer-project"));
    const transfer = yield* ownership.readIncoming(transferId, length);
    const id = transfer.identity.id;
    return yield* withOperation(id)(
      Effect.gen(function* () {
        if (Option.isNone(yield* projects.get(projectId)))
          return yield* new MemoryChatError({ operation: "transfer", reason: "not-found" });
        if (transfer.events.some((event) => event.threadId !== transfer.identity.threadId))
          return yield* new MemoryChatError({ operation: "transfer", reason: "invalid-transfer" });
        const created = transfer.events.find((event) => event.type === "thread.created");
        if (!created || created.payload.id !== transfer.identity.threadId)
          return yield* new MemoryChatError({ operation: "transfer", reason: "invalid-transfer" });
        const shell = yield* projections.getThreadShell(transfer.identity.threadId);
        if (shell && shell.memoryIdentityId !== id)
          return yield* new MemoryChatError({ operation: "transfer", reason: "invalid-transfer" });
        yield* ensureIdle(transfer.identity.threadId);
        const staged = yield* ownership.stage(transfer, ownerEnvironmentId);
        // An acknowledged activation may have lost its reply; never overwrite its workspace on retry.
        if (staged.status === "active") return staged;
        const workspace = yield* transferFiles.importWorkspace(transfer);
        yield* transferFiles.importAttachments(transfer);
        const localHistory = yield* events
          .readAgentEvents({ threadId: transfer.identity.threadId })
          .pipe(Stream.runCollect);
        const seen = new Set(localHistory.map((stored) => stored.event.id));
        const imported = yield* Effect.forEach(
          transfer.events.filter((event) => !seen.has(event.id)),
          (event) =>
            decodeDomainEvent({
              ...event,
              payload: isAppThread(event.payload)
                ? { ...event.payload, projectId, worktreePath: workspace, memoryIdentityId: id }
                : event.type === "checkpoint-scope.created" ||
                    event.type === "provider-session.attached" ||
                    event.type === "provider-session.updated"
                  ? { ...event.payload, cwd: workspace }
                  : event.payload,
            }),
        );
        // Replay persisted facts only. Historical outbox effects must never run on the destination.
        if (imported.length) yield* sink.write({ events: imported });
        const thread = yield* projections.getThread(transfer.identity.threadId);
        yield* sink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId: thread.id }),
              type: "thread.metadata-updated",
              threadId: thread.id,
              occurredAt: yield* DateTime.now,
              payload: { ...thread, projectId, worktreePath: workspace, memoryIdentityId: id },
            },
          ],
        });
        yield* storage.advance(id, yield* events.latestAgentSequence(thread.id));
        yield* ownership.completeImport(id, transferId);
        return staged;
      }),
    );
  }, memoryError("transfer-import"));
  const activateTransfer = Effect.fn("MemoryChat.activateTransfer")(function* (
    id: MemoryId,
    transferId: string,
    secret: string,
  ) {
    const memory = yield* withOperation(id)(
      Effect.gen(function* () {
        const active = yield* ownership.activate(id, transferId, secret, ownerEnvironmentId);
        yield* Cache.invalidate(workers, id);
        return active;
      }),
    );
    yield* wake(id);
    return memory;
  }, memoryError("transfer-activate"));
  const cancelTransfer = Effect.fn("MemoryChat.cancelTransfer")(function* (
    id: MemoryId,
    transferId: string,
  ) {
    const memory = yield* withOperation(id)(ownership.cancel(id, transferId, ownerEnvironmentId));
    yield* wake(id);
    return memory;
  });
  const latest = yield* sink.latestSequence();
  yield* sink.stream({ afterSequence: latest }).pipe(
    Stream.filter(
      ({ event }) =>
        (event.type === "message.updated" && !event.payload.streaming) ||
        (event.type === "turn-item.updated" &&
          !["running", "pending", "waiting"].includes(event.payload.status)) ||
        (event.type === "run.updated" &&
          ["completed", "failed", "interrupted", "cancelled"].includes(event.payload.status)),
    ),
    Stream.mapEffect(
      (stored) =>
        Effect.gen(function* () {
          const memory = yield* storage.forThread(stored.event.threadId);
          if (
            !memory ||
            memory.status !== "active" ||
            memory.ownerEnvironmentId !== ownerEnvironmentId
          )
            return;
          yield* withOperation(memory.id)(synchronize(memory));
          yield* wake(memory.id);
          if (
            stored.event.type === "run.updated" &&
            ["completed", "failed", "interrupted", "cancelled"].includes(
              stored.event.payload.status,
            )
          ) {
            const projection = yield* projections.getThreadRecords(memory.threadId, [
              "providerThreads",
            ]);
            const providerThreadId = stored.event.payload.providerThreadId;
            const providerThread = projection.providerThreads.find(
              (thread) => thread.id === providerThreadId,
            );
            if (providerThread?.providerSessionId)
              yield* sessions.close(providerThread.providerSessionId);
          }
        }).pipe(
          Effect.catch((cause) =>
            Effect.logError("Memory journal synchronization failed", { cause }),
          ),
        ),
      { concurrency: "unbounded", unordered: true },
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );
  // Recover committed thread output and durable compaction jobs after restart.
  for (const memory of yield* storage.list()) {
    if (memory.status !== "active" || memory.ownerEnvironmentId !== ownerEnvironmentId) continue;
    yield* withOperation(memory.id)(synchronize(memory));
    yield* wake(memory.id);
  }
  return {
    create,
    reset,
    remove,
    prepare,
    assertOwner,
    list: storage.list,
    forThread: storage.forThread,
    wake,
    beginTransfer,
    stageTransfer,
    activateTransfer,
    cancelTransfer,
    releaseTransfer: ownership.release,
    readTransferChunk: ownership.readChunk,
    writeTransferChunk: ownership.writeChunk,
  };
});
export class MemoryChat extends Context.Service<MemoryChat, Effect.Success<typeof make>>()(
  "t3/memory/MemoryChat",
) {}
export const layer = Layer.effect(MemoryChat, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
