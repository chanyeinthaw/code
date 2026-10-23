import * as Schema from "effect/Schema";
import { BotId } from "./baseSchemas.ts";

const DiscordSnowflake = Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/));

export const BotDiscordSettings = Schema.Struct({
  enabled: Schema.Boolean,
  interactionMode: Schema.Literals(["mention-only", "all-messages"]),
  userPolicy: Schema.Struct({
    mode: Schema.Literals(["allow", "block"]),
    userIds: Schema.Array(DiscordSnowflake),
  }),
  replyMode: Schema.Literals(["thread", "message"]),
});
export type BotDiscordSettings = typeof BotDiscordSettings.Type;

export const DEFAULT_BOT_DISCORD_SETTINGS: BotDiscordSettings = {
  enabled: false,
  interactionMode: "mention-only",
  userPolicy: { mode: "allow", userIds: [] },
  replyMode: "thread",
};

export const BotDiscordStatus = Schema.Struct({
  botId: BotId,
  settings: BotDiscordSettings,
  credentialConfigured: Schema.Boolean,
  connection: Schema.Literals(["disabled", "connecting", "connected", "error"]),
  error: Schema.NullOr(Schema.String),
});
export type BotDiscordStatus = typeof BotDiscordStatus.Type;

export class BotIntegrationError extends Schema.TaggedError<BotIntegrationError>()(
  "BotIntegrationError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "storage",
      "credentials",
      "connection",
      "not-owner",
      "invalid-route",
      "invalid-reply",
      "delivery",
      "input",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "storage":
        return "Bot integration storage failed.";
      case "credentials":
        return "Configure Discord bot credentials before enabling the integration.";
      case "connection":
        return "Discord connection failed. Check the token, gateway intents, and bot permissions.";
      case "not-owner":
        return "This environment does not own an active instance of this bot.";
      case "invalid-route":
        return "This Discord reply route does not belong to the calling bot conversation.";
      case "invalid-reply":
        return "Use a new reply ID for different content and provide non-empty text.";
      case "delivery":
        return "Discord message delivery failed. Retry with the same reply ID to resume.";
      case "input":
        return "The Discord message could not be delivered to the bot.";
    }
  }
}
