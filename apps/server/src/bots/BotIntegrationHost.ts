import * as BotHost from "@satslab/bot-discord/BotHost";
import { BotIntegrationError, CommandId, MessageId, type BotId } from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as BotStorage from "./BotStorage.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const make = Effect.gen(function* () {
  const bots = yield* BotStorage.BotStorage;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const assertOwner = Effect.fn("BotIntegrationHost.assertOwner")(function* (botId: BotId) {
    const bot = yield* bots
      .get(botId)
      .pipe(
        Effect.mapError(
          (cause) => new BotIntegrationError({ operation: "owner", reason: "not-owner", cause }),
        ),
      );
    if (bot.status !== "active" || bot.ownerEnvironmentId !== environmentId)
      return yield* new BotIntegrationError({ operation: "owner", reason: "not-owner" });
    return { threadId: bot.threadId };
  });
  const deliver = Effect.fn("BotIntegrationHost.deliver")(function* (
    input: Parameters<BotHost.BotHost["Service"]["deliver"]>[0],
  ) {
    const owner = yield* assertOwner(input.botId);
    if (owner.threadId !== input.threadId)
      return yield* new BotIntegrationError({ operation: "deliver", reason: "invalid-route" });
    const projection = yield* threads
      .getThreadRecords(owner.threadId, ["runs"])
      .pipe(
        Effect.mapError(
          (cause) => new BotIntegrationError({ operation: "deliver", reason: "input", cause }),
        ),
      );
    const active = projection.runs.some((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    );
    const command = {
      projectId: projection.thread.projectId,
      threadId: owner.threadId,
      commandId: CommandId.make(`bot-input:${input.inputId}`),
      messageId: MessageId.make(`bot-input:${input.inputId}`),
      text: input.text,
      attachments: [],
      createdBy: "user",
      creationSource: "server",
    } as const;
    yield* threads.sendToThread({ ...command, mode: active ? "steer" : "auto" }).pipe(
      Effect.catchTags({
        ThreadManagementNoSteerableRunError: () =>
          threads.sendToThread({ ...command, mode: "queue" }),
      }),
      Effect.mapError(
        (cause) => new BotIntegrationError({ operation: "deliver", reason: "input", cause }),
      ),
    );
  });
  const credential = Effect.fn("BotIntegrationHost.credential")(function* (name: string) {
    const value = yield* secrets
      .get(name)
      .pipe(
        Effect.mapError(
          (cause) =>
            new BotIntegrationError({ operation: "credentials", reason: "storage", cause }),
        ),
      );
    return Option.isSome(value) ? new TextDecoder().decode(value.value) : undefined;
  });
  const setCredential = Effect.fn("BotIntegrationHost.setCredential")(function* (
    name: string,
    token: string | null,
  ) {
    yield* (
      token === null ? secrets.remove(name) : secrets.set(name, new TextEncoder().encode(token))
    ).pipe(
      Effect.mapError(
        (cause) => new BotIntegrationError({ operation: "credentials", reason: "storage", cause }),
      ),
    );
  });
  return BotHost.BotHost.of({ assertOwner, deliver, credential, setCredential });
});

export const layer = Layer.effect(BotHost.BotHost, make);
