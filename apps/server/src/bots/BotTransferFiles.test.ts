import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  CheckpointScopeId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as BotTransferFiles from "./BotTransferFiles.ts";

it.effect("removes source workspace and live provider bindings without filesystem services", () =>
  Effect.gen(function* () {
    const files = yield* BotTransferFiles.BotTransferFiles;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("root");
    const instanceId = ProviderInstanceId.make("codex");
    const thread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("source"),
      title: "Bot",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "source-branch",
      worktreePath: "/source/workspace",
      activeProviderThreadId: ProviderThreadId.make("source-provider-thread"),
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
    const events: OrchestrationV2DomainEvent[] = [
      {
        id: EventId.make("created"),
        threadId,
        occurredAt: now,
        type: "thread.created",
        payload: thread,
      },
    ];
    events.push(
      {
        id: EventId.make("detached"),
        threadId,
        occurredAt: now,
        type: "provider-session.detached",
        payload: { providerSessionId: ProviderSessionId.make("source-session"), detachedAt: now },
      },
      {
        id: EventId.make("scope"),
        threadId,
        occurredAt: now,
        type: "checkpoint-scope.created",
        payload: {
          id: CheckpointScopeId.make("source-scope"),
          threadId,
          runId: null,
          nodeId: NodeId.make("source-node"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: false,
          cwd: "/source/workspace",
          createdAt: now,
        },
      },
    );
    const exported = yield* files.portableHistory(events);
    assert.equal(exported.length, 1);
    const created = exported[0];
    assert.equal(created?.type, "thread.created");
    if (created?.type !== "thread.created") return yield* Effect.die("Missing root");
    assert.isNull(created.payload.worktreePath);
    assert.isNull(created.payload.activeProviderThreadId);
    assert.isNull(created.payload.branch);
    assert.deepEqual(yield* files.portableHistory(exported), exported);
  }).pipe(Effect.provide(BotTransferFiles.layer)),
);
