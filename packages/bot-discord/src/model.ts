import { BotId, ThreadId } from "@satslab/contracts";
import * as Schema from "effect/Schema";

export interface DiscordMessage {
  readonly id: string;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly inThread: boolean;
  readonly authorId: string;
  readonly authorName: string;
  readonly authorIsBot: boolean;
  readonly webhook: boolean;
  readonly system: boolean;
  readonly mentionsBot: boolean;
  readonly referenceId: string | null;
  readonly text: string;
  readonly attachments: ReadonlyArray<{
    readonly name: string;
    readonly contentType: string | null;
    readonly sizeBytes: number;
    readonly url: string;
  }>;
}

export const DiscordRoute = Schema.Struct({
  id: Schema.String,
  botId: BotId,
  threadId: ThreadId,
  guildId: Schema.String,
  channelId: Schema.String,
  triggerId: Schema.String,
  userId: Schema.String,
  rootId: Schema.String,
  rootChannelId: Schema.String,
  title: Schema.String,
  destinationId: Schema.NullOr(Schema.String),
  workingId: Schema.NullOr(Schema.String),
  delivered: Schema.Boolean,
  input: Schema.String,
});
export type DiscordRoute = typeof DiscordRoute.Type;

export interface DiscordPost {
  readonly channelId: string;
  readonly text: string;
  readonly mentionUserId?: string;
  readonly replyToId?: string;
  readonly nonce: string;
}
