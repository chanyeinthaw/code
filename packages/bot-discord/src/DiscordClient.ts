import { BotIntegrationError } from "@satslab/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { DiscordMessage, DiscordPost, DiscordRoute } from "./model.ts";
import type { ReadRequest, ReadResult } from "./ConnectionSchema.ts";
import { makeMembers } from "./DiscordMembers.ts";
import { DiscordReadError, makeReader } from "./DiscordReads.ts";

export interface DiscordConnection {
  readonly events: Stream.Stream<DiscordMessage, BotIntegrationError>;
  readonly ready: () => boolean;
  readonly query: (
    route: DiscordRoute,
    request: ReadRequest,
  ) => Effect.Effect<ReadResult, DiscordReadError>;
  readonly createThread: (
    channelId: string,
    messageId: string,
    name: string,
  ) => Effect.Effect<string, BotIntegrationError>;
  readonly post: (input: DiscordPost) => Effect.Effect<string, BotIntegrationError>;
  readonly remove: (
    channelId: string,
    messageId: string,
  ) => Effect.Effect<void, BotIntegrationError>;
}

export class DiscordClient extends Context.Service<
  DiscordClient,
  {
    readonly connect: (
      token: string,
    ) => Effect.Effect<DiscordConnection, BotIntegrationError, Scope.Scope>;
  }
>()("@satslab/bot-discord/DiscordClient") {}

const request = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new BotIntegrationError({
        operation,
        reason: operation === "connect" ? "connection" : "delivery",
        cause,
      }),
  });

const connect = Effect.fn("DiscordClient.connect")(function* (token: string) {
  const { ChannelType, Client, Events, GatewayIntentBits, MessageType, Options } = yield* request(
    "connect",
    () => import("discord.js"),
  );
  const queue = yield* Queue.unbounded<DiscordMessage, BotIntegrationError>();
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
          ],
          makeCache: Options.cacheWithLimits({ MessageManager: 0, ReactionManager: 0 }),
        }),
    ),
    (client) => Effect.promise(() => client.destroy()),
  );
  client.on(Events.MessageCreate, (message) => {
    Queue.offerUnsafe(queue, {
      id: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      inThread: message.channel.isThread(),
      authorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.displayName,
      authorIsBot: message.author.bot,
      webhook: message.webhookId !== null,
      system: message.system || ![MessageType.Default, MessageType.Reply].includes(message.type),
      mentionsBot: client.user !== null && message.mentions.users.has(client.user.id),
      referenceId: message.reference?.messageId ?? null,
      text: message.content,
      attachments: [...message.attachments.values()].map((attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        sizeBytes: attachment.size,
        url: attachment.url,
      })),
    });
  });
  // EventEmitter errors must be observed; the stream supervisor owns cleanup and exposes a safe status.
  client.on(Events.Error, () =>
    Queue.failCauseUnsafe(
      queue,
      Cause.fail(new BotIntegrationError({ operation: "gateway", reason: "connection" })),
    ),
  );
  client.on(Events.Invalidated, () =>
    Queue.failCauseUnsafe(
      queue,
      Cause.fail(new BotIntegrationError({ operation: "gateway", reason: "connection" })),
    ),
  );
  yield* request("connect", () => client.login(token)).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError(
      (cause) => new BotIntegrationError({ operation: "connect", reason: "connection", cause }),
    ),
  );
  const createThread = Effect.fn("DiscordClient.createThread")(function* (
    channelId: string,
    messageId: string,
    name: string,
  ) {
    return yield* request("create-thread", async () => {
      const channel = await client.channels.fetch(channelId);
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
      )
        throw new Error("Channel does not support threads");
      // Threads created from messages use the source message ID, including after a restart.
      const existing = await client.channels.fetch(messageId).catch(() => null);
      if (existing?.isThread() && existing.parentId === channelId) return existing.id;
      return (
        await channel.threads.create({
          startMessage: messageId,
          name: name.slice(0, 100) || "Bot reply",
        })
      ).id;
    });
  });
  const post = Effect.fn("DiscordClient.post")((input: DiscordPost) =>
    request("post", async () => {
      const channel = await client.channels.fetch(input.channelId);
      if (!channel?.isSendable()) throw new Error("Channel does not support messages");
      const message = await channel.send({
        content: input.text,
        nonce: input.nonce,
        enforceNonce: true,
        allowedMentions: {
          parse: [],
          users: input.mentionUserId ? [input.mentionUserId] : [],
          repliedUser: false,
        },
        ...(input.replyToId
          ? { reply: { messageReference: input.replyToId, failIfNotExists: true } }
          : {}),
      });
      return message.id;
    }),
  );
  const remove = Effect.fn("DiscordClient.remove")((channelId: string, messageId: string) =>
    request("remove", async () => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) throw new Error("Channel does not support messages");
      try {
        await channel.messages.delete(messageId);
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === 10008)
          return;
        throw cause;
      }
    }),
  );
  const query = makeReader({
    get: (path, query) =>
      Effect.tryPromise({
        try: (signal) => client.rest.get(path, { ...(query ? { query } : {}), signal }),
        catch: (cause) => new DiscordReadError({ reason: "unavailable", cause }),
      }),
    identity: () => ({
      id: client.user?.id ?? "",
      username: client.user?.username ?? "",
      displayName: client.user?.displayName ?? "",
      isBot: true,
    }),
    members: makeMembers(client),
  });
  return {
    query,
    events: Stream.fromQueue(queue),
    ready: () => client.isReady(),
    createThread,
    post,
    remove,
  };
});

export const layer = Layer.succeed(DiscordClient, { connect });
