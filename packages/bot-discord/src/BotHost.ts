import type { BotId, BotIntegrationError, ThreadId } from "@satslab/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** The adapter never creates conversations or owns provider execution. */
export class BotHost extends Context.Service<
  BotHost,
  {
    readonly assertOwner: (botId: BotId) => Effect.Effect<
      {
        readonly threadId: ThreadId;
      },
      BotIntegrationError
    >;
    readonly deliver: (input: {
      readonly botId: BotId;
      readonly threadId: ThreadId;
      readonly inputId: string;
      readonly text: string;
    }) => Effect.Effect<void, BotIntegrationError>;
    readonly credential: (name: string) => Effect.Effect<string | undefined, BotIntegrationError>;
    readonly setCredential: (
      name: string,
      token: string | null,
    ) => Effect.Effect<void, BotIntegrationError>;
  }
>()("@satslab/bot-discord/BotHost") {}
