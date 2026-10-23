import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  BotId,
  BotIntegrationError,
  DEFAULT_BOT_DISCORD_SETTINGS,
  ThreadId,
} from "@satslab/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeSqliteClient from "@satslab/shared/nodeSqliteClient";
import * as BotHost from "./BotHost.ts";
import * as DiscordClient from "./DiscordClient.ts";
import * as DiscordIntegration from "./DiscordIntegration.ts";
import * as DiscordPrompt from "./DiscordPrompt.ts";
import type { ReadRequest } from "./ConnectionSchema.ts";
import migration from "./migration.ts";
import type { DiscordMessage, DiscordPost, DiscordRoute } from "./model.ts";

const botId = BotId.make("bot-test");
const threadId = ThreadId.make("bot-thread");
const settings = { ...DEFAULT_BOT_DISCORD_SETTINGS, enabled: true };
const message = (id: string, patch: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id,
  channelId: "20",
  guildId: "30",
  inThread: false,
  authorId: "40",
  authorName: "Chan",
  authorIsBot: false,
  webhook: false,
  system: false,
  mentionsBot: true,
  referenceId: null,
  text: "Find this bug",
  attachments: [],
  ...patch,
});

const setup = Effect.gen(function* () {
  const events = yield* Queue.unbounded<DiscordMessage>();
  const delivered = yield* Queue.unbounded<Parameters<BotHost.BotHost["Service"]["deliver"]>[0]>();
  const posted = yield* Ref.make<Array<DiscordPost & { id: string }>>([]);
  const removed = yield* Ref.make<Array<string>>([]);
  const token = yield* Ref.make<string | undefined>(undefined);
  const owner = yield* Ref.make(true);
  const failures = yield* Ref.make(new Set<number>());
  const attempts = yield* Ref.make(0);
  const closed = yield* Queue.unbounded<void>();
  const connected = yield* Queue.unbounded<void>();
  const messageChannels = new Map<string, string>();
  const failInput = yield* Ref.make(false);
  const inputFailed = yield* Queue.unbounded<void>();
  const host = Layer.succeed(BotHost.BotHost, {
    assertOwner: () =>
      Ref.get(owner).pipe(
        Effect.flatMap((active) =>
          active
            ? Effect.succeed({ threadId })
            : Effect.fail(new BotIntegrationError({ operation: "owner", reason: "not-owner" })),
        ),
      ),
    deliver: (input) =>
      Effect.gen(function* () {
        if (yield* Ref.get(failInput)) {
          yield* Queue.offer(inputFailed, undefined);
          return yield* new BotIntegrationError({ operation: "input", reason: "input" });
        }
        yield* Queue.offer(delivered, input);
      }),
    credential: () => Ref.get(token),
    setCredential: (_, value) => Ref.set(token, value ?? undefined),
  });
  const queries = yield* Ref.make<Array<{ route: DiscordRoute; request: ReadRequest }>>([]);
  const client = Layer.succeed(DiscordClient.DiscordClient, {
    connect: () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Queue.offer(closed, undefined).pipe(Effect.asVoid));
        yield* Queue.offer(connected, undefined);
        return {
          events: Stream.fromQueue(events).pipe(
            Stream.tap((message) =>
              Effect.sync(() => {
                messageChannels.set(message.id, message.channelId);
              }),
            ),
          ),
          ready: () => true,
          query: (route, request) =>
            Ref.update(queries, (calls) => [...calls, { route, request }]).pipe(
              Effect.andThen(
                Effect.succeed({
                  action: "message" as const,
                  message: {
                    id: route.triggerId,
                    channelId: route.channelId,
                    url: "https://discord.com",
                    author: { id: "40", username: "chan", displayName: "Chan", isBot: false },
                    text: "query",
                    createdAt: "2026-10-23T00:00:00Z",
                    editedAt: null,
                    replyTo: null,
                    attachments: [],
                  },
                }),
              ),
            ),
          createThread: (_, id) => Effect.succeed(id),
          post: (input) =>
            Effect.gen(function* () {
              if (input.replyToId && messageChannels.get(input.replyToId) !== input.channelId)
                return yield* new BotIntegrationError({
                  operation: "cross-channel-quote",
                  reason: "delivery",
                });
              const index = yield* Ref.updateAndGet(attempts, (n) => n + 1);
              const failAt = yield* Ref.get(failures);
              if (failAt.has(index))
                return yield* new BotIntegrationError({ operation: "post", reason: "delivery" });
              const previous = (yield* Ref.get(posted)).find((post) => post.nonce === input.nonce);
              if (previous) return previous.id;
              const id = `sent-${index}`;
              messageChannels.set(id, input.channelId);
              yield* Ref.update(posted, (posts) => [...posts, { ...input, id }]);
              return id;
            }),
          remove: (_, id) => Ref.update(removed, (ids) => [...ids, id]),
        };
      }),
  });
  const database = Layer.effectDiscard(migration).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const context = yield* Layer.build(
    Layer.mergeAll(DiscordIntegration.layer, DiscordPrompt.layer).pipe(
      Layer.provide(Layer.mergeAll(host, client, database, NodeCrypto.layer)),
    ),
  );
  const integration = Context.get(context, DiscordIntegration.DiscordIntegration);
  const enable = Effect.gen(function* () {
    yield* integration.setCredential(botId, "test-token");
    yield* integration.configure(botId, settings);
    yield* Queue.take(connected);
  });
  const ingest = Effect.fn("Test.ingest")(function* (input: DiscordMessage) {
    yield* Queue.offer(events, input);
    return yield* Queue.take(delivered);
  });
  return {
    integration,
    prompt: Context.get(context, DiscordPrompt.DiscordPrompt),
    queries,
    enable,
    ingest,
    posted,
    removed,
    owner,
    failures,
    connected,
    closed,
    delivered,
    events,
    failInput,
    inputFailed,
  };
});

it.effect(
  "delivers Discord inputs to the existing conversation and posts only through the reply tool",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* test.enable;
        const incoming = yield* test.ingest(
          message("100", {
            attachments: [
              {
                name: "error.log",
                contentType: "text/plain",
                sizeBytes: 4,
                url: "https://cdn.discordapp.com/error.log",
              },
            ],
          }),
        );
        assert.equal(incoming.threadId, threadId);
        assert.include(incoming.text, '"source":"discord"');
        assert.include(incoming.text, "https://cdn.discordapp.com/error.log");
        const working = yield* Ref.get(test.posted);
        assert.equal(working.length, 1);
        assert.equal(working[0]?.text, "Working...");
        assert.equal(working[0]?.channelId, "100");
        yield* test.integration.reply(threadId, {
          routeId: incoming.inputId,
          replyId: "progress",
          kind: "progress",
          text: "I am investigating.",
        });
        const progress = (yield* Ref.get(test.posted))[1];
        assert.equal(progress?.text, "<@40> I am investigating.");
        assert.equal(progress?.replyToId, undefined);
        assert.deepEqual(yield* Ref.get(test.removed), [working[0]?.id]);
        yield* test.integration.reply(threadId, {
          routeId: incoming.inputId,
          replyId: "answer",
          kind: "answer",
          text: "Found the cause.",
        });
        const answer = (yield* Ref.get(test.posted))[2];
        assert.equal(answer?.replyToId, undefined);
        assert.equal(answer?.text, "<@40> Found the cause.");
        assert.equal(answer?.channelId, "100");
        assert.equal(answer?.mentionUserId, "40");
      }),
    ),
);

it.effect(
  "accepts replies to bot responses without mentions and quotes the follow-up in its thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* test.enable;
        const first = yield* test.ingest(message("100"));
        const response = yield* test.integration.reply(threadId, {
          routeId: first.inputId,
          replyId: "first",
          kind: "answer",
          text: "Here is the answer.",
        });
        const followup = yield* test.ingest(
          message("101", {
            channelId: "100",
            inThread: true,
            mentionsBot: false,
            referenceId: response.messageIds[0] ?? null,
            authorId: "41",
          }),
        );
        yield* test.integration.reply(threadId, {
          routeId: followup.inputId,
          replyId: "second",
          kind: "answer",
          text: "More details.",
        });
        const answer = (yield* Ref.get(test.posted)).at(-1);
        assert.equal(answer?.replyToId, "101");
        assert.equal(answer?.text, "<@41> More details.");
        assert.equal(answer?.channelId, "100");
      }),
    ),
);

it.effect("adds the recipient mention once when the agent includes leading mentions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.enable;
      const incoming = yield* test.ingest(message("100", { inThread: true }));
      yield* test.integration.reply(threadId, {
        routeId: incoming.inputId,
        replyId: "mention",
        kind: "answer",
        text: "<@40> <@!40> Found the cause.",
      });
      assert.equal((yield* Ref.get(test.posted)).at(-1)?.text, "<@40> Found the cause.");
    }),
  ),
);

it.effect("rejects concurrent reuse of a reply ID across different destinations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.enable;
      const first = yield* test.ingest(message("100", { inThread: true }));
      const second = yield* test.ingest(message("101", { inThread: true, channelId: "21" }));
      const results = yield* Effect.all(
        [
          test.integration
            .reply(threadId, {
              routeId: first.inputId,
              replyId: "same",
              kind: "answer",
              text: "First",
            })
            .pipe(Effect.result),
          test.integration
            .reply(threadId, {
              routeId: second.inputId,
              replyId: "same",
              kind: "answer",
              text: "Second",
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
      assert.equal((yield* Ref.get(test.posted)).length, 3);
    }),
  ),
);

it.effect("removes credentials and disables the connection without returning the token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* setup;
      assert.equal(
        (yield* test.integration.configure(botId, settings).pipe(Effect.flip)).reason,
        "credentials",
      );
      yield* test.enable;
      const enabled = yield* test.integration.read(botId);
      assert.isTrue(enabled.credentialConfigured);
      assert.isFalse("token" in enabled);
      const disabled = yield* test.integration.setCredential(botId, null);
      yield* Queue.take(test.closed);
      assert.isFalse(disabled.settings.enabled);
      assert.isFalse(disabled.credentialConfigured);
      assert.equal(disabled.connection, "disabled");
    }),
  ),
);

it.effect("keeps routes separate when messages from different users steer the same bot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.enable;
      yield* test.integration.configure(botId, { ...settings, replyMode: "message" });
      yield* Queue.take(test.connected);
      const first = yield* test.ingest(message("100"));
      const second = yield* test.ingest(message("101", { channelId: "21", authorId: "41" }));
      yield* test.integration.reply(threadId, {
        routeId: first.inputId,
        replyId: "first",
        kind: "answer",
        text: "First answer",
      });
      yield* test.integration.refresh(botId);
      yield* Queue.take(test.connected);
      yield* test.integration.reply(threadId, {
        routeId: second.inputId,
        replyId: "second",
        kind: "answer",
        text: "Second answer",
      });
      const posts = yield* Ref.get(test.posted);
      assert.equal(posts[2]?.channelId, "20");
      assert.equal(posts[2]?.replyToId, "100");
      assert.equal(posts[3]?.channelId, "21");
      assert.equal(posts[3]?.replyToId, "101");
    }),
  ),
);

it.effect(
  "recovers accepted input after a connection restarts and deduplicates gateway replays",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* test.enable;
        yield* Ref.set(test.failInput, true);
        yield* Queue.offer(test.events, message("100"));
        yield* Queue.take(test.inputFailed);
        yield* test.integration.suspend(botId);
        yield* Ref.set(test.failInput, false);
        yield* test.integration.refresh(botId);
        yield* Queue.take(test.connected);
        const recovered = yield* Queue.take(test.delivered);
        assert.equal(recovered.inputId, `${botId}:100`);
        yield* Queue.offer(test.events, message("100"));
        const next = yield* test.ingest(message("101"));
        assert.equal(next.inputId, `${botId}:101`);
      }),
    ),
);

it.effect(
  "resumes partially delivered chunks without duplicating successful messages or repeated pings",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* test.enable;
        const incoming = yield* test.ingest(message("100", { inThread: true }));
        yield* Ref.set(test.failures, new Set([3]));
        const input = {
          routeId: incoming.inputId,
          replyId: "long",
          kind: "answer",
          text: "word ".repeat(1000),
        } as const;
        assert.equal(
          (yield* test.integration.reply(threadId, input).pipe(Effect.result))._tag,
          "Failure",
        );
        const result = yield* test.integration.reply(threadId, input);
        assert.equal(result.messageIds.length, 3);
        const chunks = (yield* Ref.get(test.posted)).slice(1);
        assert.equal(chunks.length, 3);
        assert.equal(chunks.map((post) => post.text).join(""), `<@40> ${input.text}`);
        assert.isTrue(chunks.every((post) => post.text.length <= 2000));
        assert.equal(chunks[0]?.replyToId, "100");
        assert.equal(chunks[1]?.replyToId, undefined);
        assert.equal(chunks[1]?.mentionUserId, undefined);
        const duplicate = yield* test.integration.reply(threadId, input);
        assert.deepEqual(duplicate, result);
        assert.equal((yield* Ref.get(test.posted)).length, 4);
        assert.equal(
          (yield* test.integration
            .reply(threadId, { ...input, text: "different" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }),
    ),
);

it.effect(
  "rejects other conversations and ownership loss, and closes connections when disabled",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* test.enable;
        const incoming = yield* test.ingest(message("100"));
        const input = {
          routeId: incoming.inputId,
          replyId: "answer",
          kind: "answer",
          text: "answer",
        } as const;
        assert.equal(
          (yield* test.integration.reply(ThreadId.make("other-thread"), input).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        yield* Ref.set(test.owner, false);
        assert.equal(
          (yield* test.integration.reply(threadId, input).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* Ref.set(test.owner, true);
        yield* test.integration.configure(botId, { ...settings, enabled: false });
        yield* Queue.take(test.closed);
        assert.equal((yield* test.integration.read(botId)).connection, "disabled");
        assert.equal((yield* Ref.get(test.posted)).length, 1);
      }),
    ),
);

it.effect(
  "dispatches connection reads by route and rejects other conversations, ownership loss, and disabled bots",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* setup;
        yield* test.enable;
        const incoming = yield* test.ingest(message("100"));
        const input = { routeId: incoming.inputId, request: { action: "context" } } as const;
        yield* test.integration.connection(threadId, input);
        const queries = yield* Ref.get(test.queries);
        assert.equal(queries[0]?.route.channelId, "20");
        assert.equal(queries[0]?.route.destinationId, "100");
        assert.equal((yield* Ref.get(test.posted)).length, 1);
        assert.equal((yield* Ref.get(test.removed)).length, 0);
        assert.equal(
          (yield* test.integration.connection(ThreadId.make("other"), input).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        yield* Ref.set(test.owner, false);
        assert.equal(
          (yield* test.integration.connection(threadId, input).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* Ref.set(test.owner, true);
        yield* test.integration.configure(botId, { ...settings, enabled: false });
        assert.equal(
          (yield* test.integration.connection(threadId, input).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal((yield* Ref.get(test.queries)).length, 1);
      }),
    ),
);

it.effect("posts replies through the single connection tool and preserves idempotency", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.enable;
      const incoming = yield* test.ingest(message("100"));
      const input = {
        routeId: incoming.inputId,
        request: { action: "reply", kind: "answer", replyId: "one", text: "Answer" },
      } as const;
      const first = yield* test.integration.connection(threadId, input);
      assert.deepEqual(yield* test.integration.connection(threadId, input), first);
      assert.equal(first.action, "reply");
      assert.equal((yield* Ref.get(test.posted)).length, 2);
    }),
  ),
);

it.effect("includes Discord routing rules only while the bot connection is enabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* setup;
      assert.equal(yield* test.prompt.instructions(botId), "");
      yield* test.enable;
      const prompt = yield* test.prompt.instructions(botId);
      assert.include(prompt, "# Connections - Discord");
      assert.include(prompt, "Track the source of each request separately");
      assert.include(prompt, "For requests sent from the Sora app, reply normally in Sora");
      assert.include(prompt, "s3_bot_connection");
      assert.include(prompt, "including steers and delegated results");
      yield* test.integration.suspend(botId);
      assert.equal(yield* test.prompt.instructions(botId), prompt);
      yield* test.integration.configure(botId, { ...settings, enabled: false });
      assert.equal(yield* test.prompt.instructions(botId), "");
    }),
  ),
);
