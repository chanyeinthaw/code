import { OrchestrationV2AppThread, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

const isAppThread = Schema.is(OrchestrationV2AppThread);
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);

const portableHistory = Effect.fn("BotTransferFiles.portableHistory")(function* (
  events: readonly OrchestrationV2DomainEvent[],
) {
  // Provider bindings and git checkpoints belong to the source environment.
  const history = events.filter(
    (event) =>
      !event.type.startsWith("provider-session.") &&
      !event.type.startsWith("provider-thread.") &&
      !event.type.startsWith("checkpoint") &&
      !event.type.startsWith("context-handoff."),
  );
  return yield* Effect.forEach(history, (event) =>
    decodeEvent({
      ...event,
      payload: isAppThread(event.payload)
        ? {
            ...event.payload,
            worktreePath: null,
            activeProviderThreadId: null,
            branch: null,
            forkedFrom: null,
          }
        : event.type === "message.updated"
          ? {
              ...event.payload,
              attachments: [],
              text:
                event.payload.text +
                (event.payload.attachments.length
                  ? `\n[Attachments unavailable after transfer: ${event.payload.attachments.map((attachment) => attachment.name).join(", ")}]`
                  : ""),
            }
          : event.type === "run.created" || event.type === "run.updated"
            ? {
                ...event.payload,
                providerThreadId: null,
                checkpointId: null,
                contextHandoffId: null,
              }
            : event.payload,
    }),
  );
});
export class BotTransferFiles extends Context.Service<
  BotTransferFiles,
  { readonly portableHistory: typeof portableHistory }
>()("t3/bots/BotTransferFiles") {}
export const layer = Layer.succeed(BotTransferFiles, { portableHistory });
