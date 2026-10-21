import { planProjectCommand, type ProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import { makeEnsureWorkspace } from "./BotWorkspace.ts";
import {
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  type EnvironmentId,
  ProjectId,
  ThreadId,
  CommandId,
  type ModelSelection,
  type RuntimeMode,
  type BotTransfer,
  BotChatError,
  BotId,
  type BotIdentity,
  type BotDiscoveryInput,
  type MemoryMessage,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ConversationMessage,
  type RunId,
} from "@satslab/contracts";
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
import * as Random from "effect/Random";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as BotOwnership from "./BotOwnership.ts";
import * as TransferFiles from "./BotTransferFiles.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as IdAllocator from "@satslab/provider-core/server/IdAllocator";
import * as BotStorage from "./BotStorage.ts";
import * as MemoryCompaction from "./MemoryCompaction.ts";
import { makeMemory } from "./MemoryWorker.ts";
import { memoryTurnItem } from "./MemoryTurnItem.ts";

const BOT_STAR_NAMES = [
  "Vega",
  "Sirius",
  "Altair",
  "Rigel",
  "Deneb",
  "Capella",
  "Polaris",
  "Arcturus",
  "Spica",
  "Antares",
  "Procyon",
  "Castor",
  "Pollux",
  "Regulus",
  "Bellatrix",
  "Mira",
  "Alhena",
  "Alnilam",
  "Alnitak",
  "Saiph",
  "Fomalhaut",
  "Aldebaran",
  "Achernar",
  "Alcor",
];

const isBotChatError = Schema.is(BotChatError);
const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);
const isAppThread = Schema.is(OrchestrationV2AppThread);

const botError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isBotChatError(cause) ? cause : new BotChatError({ operation, reason: "storage", cause }),
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
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const transferFiles = yield* TransferFiles.BotTransferFiles;
  const storage = yield* BotStorage.BotStorage;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const ownership = yield* BotOwnership.BotOwnership;
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
  // Retain each lock across worker replacement so transfers and turns for one bot stay serialized.
  const operationLocks = yield* Cache.makeWith(() => Semaphore.make(1), {
    capacity: Infinity,
    timeToLive: () => Infinity,
  });
  const withOperation =
    (id: BotId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Cache.get(operationLocks, id).pipe(Effect.flatMap((lock) => lock.withPermit(effect)));
  const creationGate = yield* Semaphore.make(1);
  const projectGate = yield* Semaphore.make(1);
  const fibers = yield* FiberMap.make<BotId>();
  const workers = yield* Cache.makeWith(
    (id: BotId) =>
      Effect.gen(function* () {
        return {
          worker: yield* makeMemory(id, (view) => compaction.open(id, view)),
          signal: yield* Queue.sliding<void>(1),
        };
      }),
    { capacity: Infinity, timeToLive: () => Infinity },
  );
  const assertOwner = Effect.fn("BotChat.assertOwner")(function* (id: BotId) {
    const bot = yield* storage.get(id);
    if (bot.ownerEnvironmentId !== ownerEnvironmentId || bot.status !== "active")
      return yield* new BotChatError({ operation: "owner", reason: "not-owner" });
    return bot;
  });
  const bindThread = Effect.fn("BotChat.bindThread")(
    function* (input: { threadId: ThreadId; name: string; id?: BotId }) {
      const projection = yield* projections.getThreadRecords(input.threadId, ["runs", "messages"]);
      if (projection.thread.botId) return yield* storage.get(projection.thread.botId);
      if (projection.runs.length || projection.messages.length)
        return yield* new BotChatError({ operation: "create", reason: "busy" });
      const existing = yield* storage.forThread(input.threadId);
      const identity: BotIdentity = existing ?? {
        id: input.id ?? BotId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
        name: input.name,
        ownerEnvironmentId,
        threadId: input.threadId,
        generation: 0,
        status: "active",
        destinationEnvironmentId: null,
      };
      const workspace = yield* ensureWorkspace(identity.id);
      const projectId = yield* ensureProject(identity.id, identity.name);
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
              botId: identity.id,
              projectId,
              autoSettleDisabledAt: projection.thread.autoSettleDisabledAt ?? (yield* DateTime.now),
              worktreePath: workspace,
            },
          },
        ],
      });
      return identity;
    },
    (effect, input) => storage.withBot(`thread:${input.threadId}`, effect),
    botError("create"),
  );
  const commitProject = Effect.fn("BotChat.commitProject")(function* (command: ProjectCommand) {
    const current = Option.getOrUndefined(yield* projects.get(command.projectId));
    const now = yield* DateTime.now;
    const planned = planProjectCommand({
      command,
      state: { project: current, workspaceOwner: undefined },
      eventId: yield* ids.allocate.event({ commandId: command.commandId }),
      now,
    });
    if (Result.isFailure(planned)) return yield* planned.failure;
    const { receipt } = yield* sink.commitProjectCommand({
      commandId: command.commandId,
      projectId: command.projectId,
      commandType: command.type,
      acceptedAt: now,
      event: planned.success,
    });
    if (
      receipt.projectId !== command.projectId ||
      receipt.commandType !== command.type ||
      receipt.status !== "accepted"
    )
      return yield* new BotChatError({ operation: "project", reason: "storage" });
  });
  const ensureProject = Effect.fn("BotChat.ensureProject")(
    function* (id: BotId, name: string) {
      const workspaceRoot = yield* ensureWorkspace(id);
      const existing = yield* projects.findActiveByWorkspaceRoot(workspaceRoot);
      const projectId = Option.isSome(existing)
        ? existing.value.projectId
        : ProjectId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      if (Option.isSome(existing) && existing.value.title === name && existing.value.isBot)
        return projectId;
      const commandId = CommandId.make(
        `bot-project:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
      );
      yield* commitProject(
        Option.isSome(existing)
          ? { type: "project.meta.update", commandId, projectId, title: name, isBot: true }
          : {
              type: "project.create",
              commandId,
              projectId,
              title: name,
              isBot: true,
              workspaceRoot,
            },
      );
      return projectId;
    },
    (effect) => projectGate.withPermit(effect),
  );
  const forProject = Effect.fn("BotChat.forProject")(function* (projectId: ProjectId) {
    for (const bot of yield* storage.list()) {
      if (bot.status !== "active" || bot.ownerEnvironmentId !== ownerEnvironmentId) continue;
      const thread = yield* projections.getThreadShell(bot.threadId);
      if (thread?.projectId === projectId) return bot;
    }
  });
  const discover = Effect.fn("BotChat.discover")(function* (input: BotDiscoveryInput) {
    const query = input.query?.trim().toLocaleLowerCase() ?? "";
    const bots = (yield* storage.list())
      .filter(
        (bot) =>
          bot.status === "active" &&
          bot.ownerEnvironmentId === ownerEnvironmentId &&
          bot.name.toLocaleLowerCase().includes(query),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const start = input.cursor ?? 0;
    const end = start + (input.limit ?? 20);
    return { bots: bots.slice(start, end), nextCursor: end < bots.length ? end : null };
  });
  const bindProject = Effect.fn("BotChat.bindProject")(function* (bot: BotIdentity) {
    const projectId = yield* ensureProject(bot.id, bot.name);
    const snapshot = yield* projections.getShellSnapshot();
    for (const member of [...snapshot.threads, ...snapshot.archivedThreads]) {
      if (
        member.projectId === projectId ||
        (member.id !== bot.threadId && member.lineage.rootThreadId !== bot.threadId)
      )
        continue;
      const thread = yield* projections.getThread(member.id);
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId: thread.id }),
            type: "thread.metadata-updated",
            threadId: thread.id,
            occurredAt: yield* DateTime.now,
            payload: { ...thread, projectId },
          },
        ],
      });
    }
  });
  const create = Effect.fn("BotChat.create")(
    function* (input: {
      threadId: ThreadId;
      name?: string;
      modelSelection: ModelSelection;
      runtimeMode: RuntimeMode;
      reuseExisting?: boolean;
    }) {
      const bots = yield* storage.list();
      if (input.reuseExisting) {
        const existing = bots.find(
          (bot) => bot.status === "active" && bot.ownerEnvironmentId === ownerEnvironmentId,
        );
        if (existing)
          return yield* bindThread({ threadId: existing.threadId, name: existing.name });
      }
      const existingThread = yield* projections.getThreadShell(input.threadId);
      let name = existingThread?.title ?? input.name?.trim();
      if (!name) {
        const usedNames = new Set(bots.map((bot) => bot.name.trim().toLocaleLowerCase()));
        let candidates = BOT_STAR_NAMES.filter((star) => !usedNames.has(star.toLocaleLowerCase()));
        for (let suffix = 2; candidates.length === 0; suffix++) {
          candidates = BOT_STAR_NAMES.map((star) => `${star} ${suffix}`).filter(
            (star) => !usedNames.has(star.toLocaleLowerCase()),
          );
        }
        name = yield* Random.choice(candidates);
      }
      const id =
        (yield* storage.forThread(input.threadId))?.id ??
        BotId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      if (!existingThread) {
        const projectId = yield* ensureProject(id, name);
        const now = yield* DateTime.now;
        const thread: OrchestrationV2AppThread = {
          id: input.threadId,
          projectId,
          title: name,
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
      return yield* bindThread({ ...input, name, id });
    },
    (effect) => creationGate.withPermit(effect),
    botError("create"),
  );
  const record = Effect.fn("BotChat.record")(function* (
    id: BotId,
    stored: OrchestrationV2StoredEvent,
  ) {
    const event = stored.event;
    if (event.type === "thread.metadata-updated") {
      yield* storage.rename(
        id,
        event.payload.title,
        `rename:${event.id}`,
        DateTime.formatIso(event.occurredAt),
      );
      yield* ensureProject(id, (yield* storage.get(id)).name);
    } else if (event.type === "message.updated" && !event.payload.streaming) {
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
  const synchronize = Effect.fn("BotChat.synchronize")(function* (bot: BotIdentity) {
    const current = yield* storage.get(bot.id);
    if (current.status !== "active" || current.threadId !== bot.threadId) return;
    const afterSequence = yield* storage.cursor(bot.id);
    yield* events
      .readAgentEvents({ threadId: bot.threadId, afterSequence })
      .pipe(Stream.runForEach((event) => record(bot.id, event)));
  });
  const wake = Effect.fn("BotChat.wake")(function* (id: BotId) {
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
              const bot = yield* assertOwner(id);
              const thread = yield* projections.getThreadShell(bot.threadId);
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
              Effect.logWarning("Bot compaction failed", { botId: id, cause }),
            ),
          );
        }),
      ),
      { onlyIfMissing: true },
    );
  });
  const delegatedContext = Effect.fn("BotChat.delegatedContext")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    const visited = new Set<ThreadId>();
    let child = thread;
    while (
      child.lineage.relationshipToParent === "subagent" &&
      child.lineage.parentThreadId !== null &&
      !visited.has(child.id)
    ) {
      visited.add(child.id);
      const parent = yield* projections.getThreadRecords(child.lineage.parentThreadId, [
        "subagents",
      ]);
      const task = parent.subagents.find(
        (candidate) => candidate.origin === "app_owned" && candidate.childThreadId === child.id,
      );
      // Provider-native children and ordinary thread launches never inherit bot access.
      if (task?.runId == null) return undefined;
      const bot = yield* storage.forThread(parent.thread.id);
      if (bot !== undefined) {
        yield* assertOwner(bot.id);
        const snapshot = yield* storage.snapshot(bot.id, task.runId);
        if (snapshot === undefined)
          return yield* new BotChatError({ operation: "delegate", reason: "not-ready" });
        return { threadId: bot.threadId, snapshot };
      }
      child = parent.thread;
    }
    return undefined;
  }, botError("delegate"));
  const prepare = Effect.fn("BotChat.prepare")(function* (input: {
    botId: BotId;
    runId: RunId;
    message: OrchestrationV2ConversationMessage;
  }) {
    const frozen = yield* withOperation(input.botId)(
      Effect.gen(function* () {
        const bot = yield* assertOwner(input.botId);
        if (bot.threadId !== input.message.threadId)
          return yield* new BotChatError({ operation: "prepare", reason: "not-owner" });
        const previous = yield* storage.snapshot(bot.id, input.runId);
        if (previous) {
          yield* storage.append(bot.id, [userMemory(input.message)]);
          return previous;
        }
        yield* synchronize(bot);
        const { worker } = yield* Cache.get(workers, bot.id);
        const view = yield* worker.settle();
        const state = yield* storage.memory(bot.id);
        return yield* storage.freezeAndAppend(
          {
            botId: bot.id,
            runId: input.runId,
            total: state.total,
            view,
          },
          userMemory(input.message),
        );
      }),
    );
    yield* wake(input.botId);
    return frozen;
  }, botError("prepare"));
  const rename = Effect.fn("BotChat.rename")(function* (id: BotId, name: string) {
    const bot = yield* assertOwner(id);
    return yield* threadCommands.withLock(
      bot.threadId,
      withOperation(id)(
        Effect.gen(function* () {
          yield* synchronize(yield* assertOwner(id));
          const current = yield* assertOwner(id);
          if (current.name === name) return current;
          const thread = yield* projections.getThread(current.threadId);
          const now = yield* DateTime.now;
          const eventId = yield* ids.allocate.event({ threadId: thread.id });
          const projectId = yield* ensureProject(id, current.name);
          const renamed = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* storage.rename(id, name, `rename:${eventId}`, DateTime.formatIso(now));
              yield* commitProject({
                type: "project.meta.update",
                commandId: CommandId.make(`bot-rename:${eventId}`),
                projectId,
                title: name,
              });
              yield* sink.write({
                events: [
                  {
                    id: eventId,
                    type: "thread.metadata-updated",
                    threadId: thread.id,
                    occurredAt: now,
                    payload: { ...thread, projectId, title: name, updatedAt: now },
                  },
                ],
              });
              return yield* storage.get(id);
            }),
          );
          yield* wake(id);
          return renamed;
        }),
      ),
    );
  }, botError("rename"));
  const ensureIdle = Effect.fn("BotChat.ensureIdle")(function* (threadId: ThreadId) {
    if (!(yield* projections.getThreadShell(threadId))) return;
    const projection = yield* projections.getThreadRecords(threadId, ["runs"]);
    if (
      projection.runs.some((run) =>
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
      )
    )
      return yield* new BotChatError({ operation: "transfer", reason: "busy" });
  });
  const changeHistory = Effect.fn("BotChat.changeHistory")(
    function* (id: BotId, operation: "reset" | "delete", projectCommandId?: CommandId) {
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
          const bot = yield* assertOwner(id);
          const snapshot = yield* projections.getShellSnapshot();
          const family = [...snapshot.threads, ...snapshot.archivedThreads].filter(
            (thread) => thread.id === bot.threadId || thread.lineage.rootThreadId === bot.threadId,
          );
          for (const member of family) yield* ensureIdle(member.id);
          const thread = yield* projections.getThread(bot.threadId);
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
              let identity: BotIdentity | null = null;
              if (operation === "reset") identity = yield* storage.reset(id, nextThreadId);
              else yield* storage.remove(id);
              yield* sink.write({
                events: operation === "reset" ? [...deleted, created] : deleted,
              });
              if (operation === "delete") {
                const project = yield* projects.get(thread.projectId);
                if (
                  Option.isSome(project) &&
                  project.value.isBot &&
                  project.value.workspaceRoot === thread.worktreePath
                ) {
                  yield* commitProject({
                    type: "project.delete",
                    commandId:
                      projectCommandId ?? CommandId.make(`bot-delete:${id}:${bot.generation}`),
                    projectId: thread.projectId,
                  });
                }
              }
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
        const bot = yield* assertOwner(id);
        return yield* threadCommands.withLock(
          bot.threadId,
          Effect.gen(function* () {
            if ((yield* assertOwner(id)).threadId !== bot.threadId)
              return yield* new BotChatError({ operation: "change-history", reason: "busy" });
            return yield* effect;
          }),
        );
      }),
    botError("change-history"),
  );
  const reset = Effect.fn("BotChat.reset")(function* (id: BotId) {
    const bot = yield* changeHistory(id, "reset");
    if (!bot) return yield* new BotChatError({ operation: "reset", reason: "storage" });
    return bot;
  });
  const remove = Effect.fn("BotChat.remove")(function* (id: BotId, projectCommandId?: CommandId) {
    const bot = yield* assertOwner(id);
    const thread = yield* projections.getThread(bot.threadId);
    yield* changeHistory(id, "delete", projectCommandId);
    if (Option.isSome(settings))
      yield* settings.value
        .updateSettings({ projectSettingsOverrides: { [thread.projectId]: null } })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not clear deleted bot project settings", { cause }),
          ),
        );
  }, botError("delete"));
  const beginTransfer = Effect.fn("BotChat.beginTransfer")(
    function* (id: BotId, destination: EnvironmentId) {
      return yield* withOperation(id)(
        Effect.gen(function* () {
          const bot = yield* storage.get(id);
          const saved = yield* ownership.packageFor(id);
          if (saved && (bot.status === "transferring" || bot.status === "forwarded")) {
            if (saved.destinationEnvironmentId !== destination)
              return yield* new BotChatError({
                operation: "transfer",
                reason: "invalid-transfer",
              });
            return yield* ownership.describe(id, saved.transferId);
          }
          if (
            bot.ownerEnvironmentId !== ownerEnvironmentId ||
            !["active", "transferring"].includes(bot.status)
          )
            return yield* new BotChatError({ operation: "transfer", reason: "not-owner" });
          yield* ensureIdle(bot.threadId);
          if (bot.status === "active") yield* synchronize(bot);
          yield* FiberMap.remove(fibers, id);
          const core = yield* ownership.prepare(id, destination);
          const history = yield* events
            .readAgentEvents({ threadId: bot.threadId })
            .pipe(Stream.runCollect);
          const transfer: BotTransfer = {
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
        const bot = yield* storage.get(id);
        return yield* threadCommands.withLock(bot.threadId, effect);
      }),
    botError("transfer-export"),
  );
  const stageTransfer = Effect.fn("BotChat.stageTransfer")(function* (
    transferId: string,
    length: number,
  ) {
    const transfer = yield* ownership.readIncoming(transferId, length);
    const projectId = yield* ensureProject(transfer.identity.id, transfer.identity.name).pipe(
      botError("transfer-project"),
    );
    const id = transfer.identity.id;
    return yield* withOperation(id)(
      Effect.gen(function* () {
        if (Option.isNone(yield* projects.get(projectId)))
          return yield* new BotChatError({ operation: "transfer", reason: "not-found" });
        if (transfer.events.some((event) => event.threadId !== transfer.identity.threadId))
          return yield* new BotChatError({ operation: "transfer", reason: "invalid-transfer" });
        const created = transfer.events.find((event) => event.type === "thread.created");
        if (!created || created.payload.id !== transfer.identity.threadId)
          return yield* new BotChatError({ operation: "transfer", reason: "invalid-transfer" });
        const shell = yield* projections.getThreadShell(transfer.identity.threadId);
        if (shell && shell.botId !== id)
          return yield* new BotChatError({ operation: "transfer", reason: "invalid-transfer" });
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
                ? { ...event.payload, projectId, worktreePath: workspace, botId: id }
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
              payload: { ...thread, projectId, worktreePath: workspace, botId: id },
            },
          ],
        });
        yield* storage.advance(id, yield* events.latestAgentSequence(thread.id));
        yield* ownership.completeImport(id, transferId);
        return staged;
      }),
    );
  }, botError("transfer-import"));
  const activateTransfer = Effect.fn("BotChat.activateTransfer")(function* (
    id: BotId,
    transferId: string,
    secret: string,
  ) {
    const bot = yield* withOperation(id)(
      Effect.gen(function* () {
        const active = yield* ownership.activate(id, transferId, secret, ownerEnvironmentId);
        yield* Cache.invalidate(workers, id);
        return active;
      }),
    );
    yield* wake(id);
    return bot;
  }, botError("transfer-activate"));
  const cancelTransfer = Effect.fn("BotChat.cancelTransfer")(function* (
    id: BotId,
    transferId: string,
  ) {
    const bot = yield* withOperation(id)(ownership.cancel(id, transferId, ownerEnvironmentId));
    yield* wake(id);
    return bot;
  });
  const latest = yield* sink.latestSequence();
  yield* sink.stream({ afterSequence: latest }).pipe(
    Stream.filter(
      ({ event }) =>
        event.type === "thread.metadata-updated" ||
        (event.type === "message.updated" && !event.payload.streaming) ||
        (event.type === "turn-item.updated" &&
          !["running", "pending", "waiting"].includes(event.payload.status)) ||
        (event.type === "run.updated" &&
          ["completed", "failed", "interrupted", "cancelled"].includes(event.payload.status)),
    ),
    Stream.mapEffect(
      (stored) =>
        Effect.gen(function* () {
          const bot = yield* storage.forThread(stored.event.threadId);
          if (!bot || bot.status !== "active" || bot.ownerEnvironmentId !== ownerEnvironmentId)
            return;
          yield* withOperation(bot.id)(synchronize(bot));
          yield* wake(bot.id);
          if (
            stored.event.type === "run.updated" &&
            ["completed", "failed", "interrupted", "cancelled"].includes(
              stored.event.payload.status,
            )
          ) {
            const projection = yield* projections.getThreadRecords(bot.threadId, [
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
          Effect.catch((cause) => Effect.logError("Bot journal synchronization failed", { cause })),
        ),
      { concurrency: "unbounded", unordered: true },
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );
  // Recover committed thread output and durable compaction jobs after restart.
  for (const bot of yield* storage.list()) {
    if (bot.status !== "active" || bot.ownerEnvironmentId !== ownerEnvironmentId) continue;
    yield* withOperation(bot.id)(
      Effect.gen(function* () {
        yield* bindProject(bot);
        yield* synchronize(bot);
      }),
    );
    yield* wake(bot.id);
  }
  return {
    create,
    rename,
    reset,
    remove,
    prepare,
    delegatedContext,
    assertOwner,
    list: storage.list,
    forThread: storage.forThread,
    forProject,
    discover,
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
export class BotChat extends Context.Service<BotChat, Effect.Success<typeof make>>()(
  "@satslab/sora/bots/BotChat",
) {}
export const layer = Layer.effect(BotChat, make).pipe(Layer.provide(ThreadCommandExecutor.layer));
