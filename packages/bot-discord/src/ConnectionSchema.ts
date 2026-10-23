import * as Schema from "effect/Schema";

export const DiscordId = Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
const Location = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["trigger", "reply", "parent"]) }),
  Schema.Struct({ type: Schema.Literal("channel"), channelId: DiscordId }),
]);
const Position = Schema.Union([
  Schema.Struct({ type: Schema.Literal("latest") }),
  Schema.Struct({ type: Schema.Literals(["before", "after", "around"]), messageId: DiscordId }),
]);
const Reference = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["trigger", "replied-to"]) }),
  Schema.Struct({ type: Schema.Literal("url"), url: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("id"),
    messageId: DiscordId,
    channelId: Schema.optionalKey(DiscordId),
  }),
]);
export const Reply = Schema.Struct({
  action: Schema.Literal("reply"),
  replyId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  kind: Schema.Literals(["progress", "answer"]),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
});
export const ReadRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("context") }),
  Schema.Struct({
    action: Schema.Literal("history"),
    location: Schema.optionalKey(Location),
    position: Schema.optionalKey(Position),
    limit: Schema.optionalKey(Limit),
  }),
  Schema.Struct({
    action: Schema.Literal("participants"),
    location: Schema.optionalKey(Location),
    mode: Schema.Literals(["recent-authors", "members"]),
    limit: Schema.optionalKey(Limit),
    cursor: Schema.optionalKey(DiscordId),
  }),
  Schema.Struct({
    action: Schema.Literal("search"),
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    channelIds: Schema.optionalKey(Schema.Array(DiscordId).check(Schema.isMaxLength(100))),
    authorIds: Schema.optionalKey(Schema.Array(DiscordId).check(Schema.isMaxLength(100))),
    beforeMessageId: Schema.optionalKey(DiscordId),
    afterMessageId: Schema.optionalKey(DiscordId),
    sort: Schema.optionalKey(Schema.Literals(["timestamp", "relevance"])),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
    cursor: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9]{1,4}$/))),
  }),
  Schema.Struct({ action: Schema.Literal("message"), reference: Reference }),
]);
export type ReadRequest = typeof ReadRequest.Type;
export const ConnectionInput = Schema.Struct({
  routeId: Schema.String.check(Schema.isMinLength(1)),
  request: Schema.Union([ReadRequest, Reply]),
});
export type ConnectionInput = typeof ConnectionInput.Type;

export const Author = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  displayName: Schema.String,
  isBot: Schema.Boolean,
});
export type Author = typeof Author.Type;
export const Message = Schema.Struct({
  id: Schema.String,
  channelId: Schema.String,
  url: Schema.String,
  author: Author,
  text: Schema.String,
  createdAt: Schema.String,
  editedAt: Schema.NullOr(Schema.String),
  replyTo: Schema.NullOr(Schema.Struct({ messageId: Schema.String, channelId: Schema.String })),
  attachments: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      contentType: Schema.NullOr(Schema.String),
      sizeBytes: Schema.Number,
    }),
  ),
});
const Channel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  isThread: Schema.Boolean,
});
export const ReadResult = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("context"),
    guild: Schema.Struct({ id: Schema.String, name: Schema.String }),
    bot: Author,
    triggerChannel: Channel,
    replyChannel: Schema.NullOr(Channel),
    trigger: Message,
  }),
  Schema.Struct({
    action: Schema.Literal("history"),
    channel: Channel,
    messages: Schema.Array(Message),
    hasMore: Schema.Boolean,
    oldestMessageId: Schema.NullOr(Schema.String),
    newestMessageId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("participants"),
    channel: Channel,
    mode: Schema.Literals(["recent-authors", "members"]),
    participants: Schema.Array(Author),
    nextCursor: Schema.NullOr(Schema.String),
    sample: Schema.NullOr(
      Schema.Struct({
        messageCount: Schema.Number,
        oldestMessageId: Schema.NullOr(Schema.String),
        newestMessageId: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("search"),
    status: Schema.Literal("indexing"),
    retryAfterMs: Schema.Number,
  }),
  Schema.Struct({
    action: Schema.Literal("search"),
    status: Schema.Literal("ready"),
    messages: Schema.Array(Message),
    totalResults: Schema.Number,
    nextCursor: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("message"), message: Message }),
]);
export type ReadResult = typeof ReadResult.Type;
export const ConnectionResult = Schema.Union([
  ReadResult,
  Schema.Struct({ action: Schema.Literal("reply"), messageIds: Schema.Array(Schema.String) }),
]);
