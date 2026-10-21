import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  BotId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as BotStorage from "../bots/BotStorage.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { checkpointWorkspace } from "@satslab/provider-testing/replayWorkspace";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

it.effect.each(["preparing", "starting"] as const)(
  "buffers memory steers on the same %s run without a provider session",
  (status) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`memory-steering-${status}`);
        const instanceId = ProviderInstanceId.make("codex");
        const databaseLayer = SqlitePersistence.layerMemory;
        const runtime = ProviderReplayHarness.layerWithRegistry(
          { name: `memory-steering-${status}` },
          ProviderAdapterRegistry.layerSingle({
            instanceId,
            driver: ProviderDriverKind.make("codex"),
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
            openSession: () => Effect.die("Preparing input must not open a provider session"),
          }),
          { databaseLayer, runEffectWorker: false },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const storage = yield* BotStorage.BotStorage;
          const threadId = ThreadId.make("memory-steering");
          const botId = BotId.make("buffered-memory");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project"),
            title: "Memory steering",
            modelSelection: { instanceId, model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            threadId,
            messageId: MessageId.make("initial"),
            text: "Start the task",
            attachments: [],
            dispatchMode: { type: status === "preparing" ? "defer_start" : "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const initial = yield* orchestrator.getThreadProjection(threadId);
          const run = initial.runs[0]!;
          const steer = {
            type: "message.dispatch" as const,
            commandId: CommandId.make("steer"),
            threadId,
            messageId: MessageId.make("correction"),
            text: "Use the new requirement",
            attachments: [],
            dispatchMode: { type: "steer_active" as const, targetRunId: run.id },
            createdBy: "user" as const,
            creationSource: "web" as const,
          };
          // The original thread still rejects steering until a provider turn exists.
          assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.dispatch(steer))));
          yield* storage.create({
            id: botId,
            threadId,
            name: "Memory",
            ownerEnvironmentId: EnvironmentId.make("local"),
            generation: 0,
            status: "active",
            destinationEnvironmentId: null,
          });
          yield* sink.write({
            events: [
              {
                id: EventId.make("bind-memory"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: initial.thread.updatedAt,
                payload: { ...initial.thread, botId: botId },
              },
            ],
          });
          const buffered = { ...steer, commandId: CommandId.make("buffer-steer") };
          yield* orchestrator.dispatch(buffered);
          yield* orchestrator.dispatch(buffered);
          const result = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(result.runs.length, 1);
          assert.equal(result.runs[0]?.status, status);
          assert.equal(result.providerTurns.length, 0);
          assert.deepEqual(
            result.messages.map((message) => [message.id, message.runId]),
            [
              [MessageId.make("initial"), run.id],
              [MessageId.make("correction"), run.id],
            ],
          );
          const correction = result.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === buffered.messageId,
          );
          assert.equal(
            correction?.type === "user_message" ? correction.inputIntent : null,
            "steer",
          );
          assert.isNull(correction?.providerTurnId);
        }).pipe(
          Effect.provide(Layer.merge(runtime, BotStorage.layer.pipe(Layer.provide(databaseLayer)))),
        );
      }),
    ),
);
