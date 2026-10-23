import type { BotId, BotIntegrationError } from "@satslab/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Pause external inputs before changing bot history or handing ownership to another environment. */
export class BotIntegrationLifecycle extends Context.Service<
  BotIntegrationLifecycle,
  {
    readonly suspend: (botId: BotId) => Effect.Effect<void>;
    readonly refresh: (botId: BotId) => Effect.Effect<void, BotIntegrationError>;
    readonly clearHistory: (botId: BotId) => Effect.Effect<void, BotIntegrationError>;
    readonly forget: (botId: BotId) => Effect.Effect<void, BotIntegrationError>;
  }
>()("@satslab/sora/bots/BotIntegrationLifecycle") {}
