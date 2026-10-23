import { assert, it } from "@effect/vitest";
import * as BotHost from "@satslab/bot-discord/BotHost";
import {
  BotId,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell, idleThreadProjection } from "../mcp/McpToolAccess.testkit.ts";
import * as BotStorage from "./BotStorage.ts";
import * as BotIntegrationHost from "./BotIntegrationHost.ts";

const botId = BotId.make("bot");
const threadId = ThreadId.make("conversation");
const owner = EnvironmentId.make("owner");
const projection = idleThreadProjection(liveThreadShell(threadId));
const run = (status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: RunId.make("run"),
  threadId,
  ordinal: 1,
  providerInstanceId: projection.thread.providerInstanceId,
  modelSelection: projection.thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message"),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: projection.thread.createdAt,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

it.effect.each(["idle", "preparing", "starting", "running", "waiting"] as const)(
  "delivers %s Discord input to the existing bot conversation with a stable command ID",
  (status) => {
    const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
    const boundary = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({ ...projection, runs: status === "idle" ? [] : [run(status)] }),
      sendToThread: (input) =>
        Effect.sync(() => {
          sent.push(input);
          return {
            dispatch: { sequence: 1, storedEvents: [] },
            projection,
            run: run("running"),
            message: {
              id: input.messageId,
              threadId,
              runId: RunId.make("run"),
              nodeId: null,
              role: "user",
              text: input.text,
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "server",
              createdAt: projection.thread.createdAt,
              updatedAt: projection.thread.createdAt,
            },
            turnItem: null,
            delivery: status === "idle" ? "started" : "steered",
          };
        }),
    });
    const host = BotIntegrationHost.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          boundary,
          Layer.mock(BotStorage.BotStorage)({
            get: () =>
              Effect.succeed({
                id: botId,
                name: "Bot",
                threadId,
                ownerEnvironmentId: owner,
                generation: 0,
                status: "active",
                destinationEnvironmentId: null,
              }),
          }),
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(owner),
          }),
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: () => Effect.succeed(Option.none()),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const input = yield* BotHost.BotHost;
      const message = { botId, threadId, inputId: "discord:100", text: "Discord input" };
      yield* input.deliver(message);
      yield* input.deliver(message);
      assert.equal(sent[0]?.mode, status === "idle" ? "auto" : "steer");
      assert.equal(sent[0]?.threadId, threadId);
      assert.equal(sent[0]?.commandId, sent[1]?.commandId);
      assert.equal(sent[0]?.messageId, sent[1]?.messageId);
      assert.equal(
        (yield* input.deliver({ ...message, threadId: ThreadId.make("stale") }).pipe(Effect.flip))
          .reason,
        "invalid-route",
      );
      assert.equal(sent.length, 2);
    }).pipe(Effect.provide(host));
  },
);
