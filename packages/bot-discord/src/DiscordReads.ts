import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DiscordRoute } from "./model.ts";
import { DiscordId, type Author, type ReadRequest, type ReadResult } from "./ConnectionSchema.ts";

export class DiscordReadError extends Schema.TaggedError<DiscordReadError>()("DiscordReadError", {
  reason: Schema.Literals([
    "invalid-request",
    "invalid-reference",
    "wrong-guild",
    "unavailable",
    "members-unavailable",
    "invalid-response",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    switch (this.reason) {
      case "invalid-request":
        return "Invalid bot connection request. Check the action fields, limits, and cursor.";
      case "invalid-reference":
        return "Provide a valid message ID or Discord message link from the triggering guild.";
      case "wrong-guild":
        return "Only channels and messages in the triggering Discord guild are accessible.";
      case "members-unavailable":
        return "Member lookup failed. Check the Discord application's Server Members privileged intent and access to this channel.";
      case "unavailable":
        return "Discord context is unavailable. Check channel access and Read Message History permissions.";
      case "invalid-response":
        return "Discord returned an unsupported context response.";
    }
  }
}
const User = Schema.Struct({
  id: DiscordId,
  username: Schema.String,
  global_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bot: Schema.optionalKey(Schema.Boolean),
});
const Member = Schema.Struct({ nick: Schema.optionalKey(Schema.NullOr(Schema.String)) });
const RawMessage = Schema.Struct({
  id: DiscordId,
  channel_id: DiscordId,
  author: User,
  member: Schema.optionalKey(Member),
  content: Schema.String,
  timestamp: Schema.String,
  edited_timestamp: Schema.NullOr(Schema.String),
  message_reference: Schema.optionalKey(
    Schema.Struct({
      message_id: Schema.optionalKey(DiscordId),
      channel_id: Schema.optionalKey(DiscordId),
    }),
  ),
  attachments: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      url: Schema.String,
      size: Schema.Number,
      content_type: Schema.optionalKey(Schema.String),
    }),
  ),
});
const RawChannel = Schema.Struct({
  id: DiscordId,
  guild_id: DiscordId,
  name: Schema.String,
  type: Schema.Number,
  parent_id: Schema.optionalKey(Schema.NullOr(DiscordId)),
});
const Search = Schema.Union([
  Schema.Struct({ code: Schema.Literal(110000), retry_after: Schema.Number }),
  Schema.Struct({ total_results: Schema.Number, messages: Schema.Array(Schema.Array(RawMessage)) }),
]);

export interface ReadTransport {
  readonly get: (
    path: `/${string}`,
    query?: URLSearchParams,
  ) => Effect.Effect<unknown, DiscordReadError>;
  readonly identity: () => Author;
  readonly members: (
    channelId: string,
    limit: number,
    cursor?: string,
  ) => Effect.Effect<
    { readonly participants: ReadonlyArray<Author>; readonly nextCursor: string | null },
    DiscordReadError
  >;
}
const decoder = <A, I>(schema: Schema.Codec<A, I>) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: unknown) =>
    decode(value).pipe(
      Effect.mapError((cause) => new DiscordReadError({ reason: "invalid-response", cause })),
    );
};
const decodeChannel = decoder(RawChannel);
const decodeMessage = decoder(RawMessage);
const decodeMessages = decoder(Schema.Array(RawMessage));
const decodeSearch = decoder(Search);
const decodeGuild = decoder(Schema.Struct({ id: DiscordId, name: Schema.String }));
const author = (message: typeof RawMessage.Type): Author => ({
  id: message.author.id,
  username: message.author.username,
  displayName: message.member?.nick ?? message.author.global_name ?? message.author.username,
  isBot: message.author.bot ?? false,
});
const normalize = (guildId: string, message: typeof RawMessage.Type) => ({
  id: message.id,
  channelId: message.channel_id,
  url: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`,
  author: author(message),
  text: message.content,
  createdAt: message.timestamp,
  editedAt: message.edited_timestamp,
  replyTo: message.message_reference?.message_id
    ? {
        messageId: message.message_reference.message_id,
        channelId: message.message_reference.channel_id ?? message.channel_id,
      }
    : null,
  attachments: message.attachments.map((item) => ({
    name: item.filename,
    url: item.url,
    sizeBytes: item.size,
    contentType: item.content_type ?? null,
  })),
});

export const makeReader = (transport: ReadTransport) => {
  const channel = Effect.fn("DiscordReads.channel")(function* (guildId: string, channelId: string) {
    const raw = yield* decodeChannel(yield* transport.get(`/channels/${channelId}`));
    if (raw.guild_id !== guildId) return yield* new DiscordReadError({ reason: "wrong-guild" });
    return {
      id: raw.id,
      name: raw.name,
      parentId: raw.parent_id ?? null,
      isThread: [10, 11, 12].includes(raw.type),
    };
  });
  const message = Effect.fn("DiscordReads.message")(function* (
    route: DiscordRoute,
    channelId: string,
    messageId: string,
  ) {
    yield* channel(route.guildId, channelId);
    const raw = yield* decodeMessage(
      yield* transport.get(`/channels/${channelId}/messages/${messageId}`),
    );
    return normalize(route.guildId, raw);
  });
  const read = Effect.fn("DiscordReads.read")(function* (
    route: DiscordRoute,
    request: ReadRequest,
  ): Effect.fn.Return<ReadResult, DiscordReadError> {
    if (request.action === "context") {
      const guild = yield* decodeGuild(yield* transport.get(`/guilds/${route.guildId}`));
      return {
        action: "context",
        guild,
        bot: transport.identity(),
        triggerChannel: yield* channel(route.guildId, route.channelId),
        replyChannel: route.destinationId
          ? yield* channel(route.guildId, route.destinationId)
          : null,
        trigger: yield* message(route, route.channelId, route.triggerId),
      };
    }
    if (request.action === "search") {
      const offset = Number(request.cursor ?? "0");
      if (offset > 9975) return yield* new DiscordReadError({ reason: "invalid-request" });
      const limit = request.limit ?? 20;
      const query = new URLSearchParams({
        content: request.query,
        limit: String(limit),
        offset: String(offset),
        sort_by: request.sort ?? "timestamp",
        sort_order: "desc",
      });
      for (const id of request.channelIds ?? []) {
        yield* channel(route.guildId, id);
        query.append("channel_id", id);
      }
      for (const id of request.authorIds ?? []) query.append("author_id", id);
      if (request.beforeMessageId) query.set("max_id", request.beforeMessageId);
      if (request.afterMessageId) query.set("min_id", request.afterMessageId);
      const result = yield* decodeSearch(
        yield* transport.get(`/guilds/${route.guildId}/messages/search`, query),
      );
      if ("code" in result)
        return { action: "search", status: "indexing", retryAfterMs: result.retry_after * 1000 };
      const next = offset + limit;
      return {
        action: "search",
        status: "ready",
        messages: result.messages.flat().map((item) => normalize(route.guildId, item)),
        totalResults: result.total_results,
        nextCursor: next < result.total_results && next <= 9975 ? String(next) : null,
      };
    }
    if (request.action === "message") {
      const reference = request.reference;
      let channelId = route.channelId;
      let messageId = route.triggerId;
      if (reference.type === "id") {
        channelId = reference.channelId ?? channelId;
        messageId = reference.messageId;
      }
      if (reference.type === "url") {
        const match =
          /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/([0-9]{1,20})\/([0-9]{1,20})\/([0-9]{1,20})(?:[?#].*)?$/.exec(
            reference.url,
          );
        if (!match || !match[2] || !match[3])
          return yield* new DiscordReadError({ reason: "invalid-reference" });
        if (match[1] !== route.guildId)
          return yield* new DiscordReadError({ reason: "wrong-guild" });
        channelId = match[2];
        messageId = match[3];
      }
      if (reference.type === "replied-to") {
        const trigger = yield* message(route, route.channelId, route.triggerId);
        if (!trigger.replyTo) return yield* new DiscordReadError({ reason: "invalid-reference" });
        channelId = trigger.replyTo.channelId;
        messageId = trigger.replyTo.messageId;
      }
      return { action: "message", message: yield* message(route, channelId, messageId) };
    }
    const location = request.location;
    let channelId =
      location?.type === "channel"
        ? location.channelId
        : location?.type === "reply"
          ? route.destinationId
          : route.channelId;
    if (!channelId) return yield* new DiscordReadError({ reason: "invalid-reference" });
    if (location?.type === "parent") {
      const source = yield* channel(route.guildId, route.channelId);
      channelId = source.isThread ? source.parentId : source.id;
      if (!channelId) return yield* new DiscordReadError({ reason: "invalid-reference" });
    }
    const resolved = yield* channel(route.guildId, channelId);
    const limit = request.limit ?? 20;
    if (request.action === "participants" && request.mode === "members") {
      return {
        action: "participants",
        channel: resolved,
        mode: "members",
        ...(yield* transport.members(channelId, limit, request.cursor)),
        sample: null,
      };
    }
    const query = new URLSearchParams({
      limit: String(request.action === "participants" ? 100 : limit),
    });
    if (request.action === "history") {
      const position =
        request.position ??
        (!location || location.type === "trigger"
          ? ({ type: "before", messageId: route.triggerId } as const)
          : ({ type: "latest" } as const));
      if (position.type !== "latest") query.set(position.type, position.messageId);
    } else if (request.cursor) {
      return yield* new DiscordReadError({ reason: "invalid-request" });
    }
    const raw = yield* decodeMessages(
      yield* transport.get(`/channels/${channelId}/messages`, query),
    );
    // Snowflakes order messages even when timestamps have equal millisecond precision.
    const messages = raw
      .toSorted((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))
      .map((item) => normalize(route.guildId, item));
    const oldestMessageId = messages[0]?.id ?? null;
    const newestMessageId = messages.at(-1)?.id ?? null;
    if (request.action === "history")
      return {
        action: "history",
        channel: resolved,
        messages,
        hasMore: raw.length === limit,
        oldestMessageId,
        newestMessageId,
      };
    const participants = [
      ...new Map(messages.toReversed().map((item) => [item.author.id, item.author])).values(),
    ].slice(0, limit);
    return {
      action: "participants",
      channel: resolved,
      mode: "recent-authors",
      participants,
      nextCursor: null,
      sample: { messageCount: messages.length, oldestMessageId, newestMessageId },
    };
  });
  return read;
};
