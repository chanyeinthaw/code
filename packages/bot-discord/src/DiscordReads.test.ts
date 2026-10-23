import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { BotId, ThreadId } from "@satslab/contracts";
import { makeReader } from "./DiscordReads.ts";
import type { DiscordRoute } from "./model.ts";

const route: DiscordRoute = {
  id: "route",
  botId: BotId.make("bot"),
  threadId: ThreadId.make("thread"),
  guildId: "30",
  channelId: "20",
  triggerId: "100",
  userId: "40",
  rootId: "100",
  rootChannelId: "20",
  title: "query",
  destinationId: "100",
  workingId: null,
  delivered: true,
  input: "",
};
const rawMessage = (id: string) => ({
  id,
  channel_id: "20",
  author: { id: "40", username: "chan", bot: false },
  content: `message ${id}`,
  timestamp: "2026-10-23T00:00:00Z",
  edited_timestamp: null,
  attachments: [],
});
const setup = (respond: (path: string, query: URLSearchParams) => unknown) => {
  const calls: Array<{ path: string; query: URLSearchParams }> = [];
  const reader = makeReader({
    get: (path, query = new URLSearchParams()) =>
      Effect.sync(() => {
        calls.push({ path, query });
        return respond(path, query);
      }),
    members: () => Effect.succeed({ participants: [], nextCursor: null }),
    identity: () => ({ id: "50", username: "bot", displayName: "Bot", isBot: true }),
  });
  return { reader, calls };
};
const channel = { id: "20", name: "general", guild_id: "30", type: 0 };

it.effect(
  "reads history before the trigger in its source channel, not the created reply thread",
  () =>
    Effect.gen(function* () {
      const test = setup((path) =>
        path === "/channels/20" ? channel : [rawMessage("99"), rawMessage("98")],
      );
      const result = yield* test.reader(route, { action: "history", limit: 2 });
      assert.equal(test.calls[1]?.path, "/channels/20/messages");
      assert.equal(test.calls[1]?.query.get("before"), "100");
      assert.equal(result.action, "history");
      if (result.action !== "history") return;
      assert.deepEqual(
        result.messages.map((m) => m.id),
        ["98", "99"],
      );
      assert.isTrue(result.hasMore);
    }),
);

it.effect("rejects cross-guild channels and message links before reading their messages", () =>
  Effect.gen(function* () {
    const test = setup(() => ({ ...channel, guild_id: "31" }));
    const channelResult = yield* test
      .reader(route, { action: "history", location: { type: "channel", channelId: "21" } })
      .pipe(Effect.result);
    assert.equal(channelResult._tag, "Failure");
    assert.equal(test.calls.length, 1);
    const linkResult = yield* test
      .reader(route, {
        action: "message",
        reference: { type: "url", url: "https://discord.com/channels/31/21/101" },
      })
      .pipe(Effect.result);
    assert.equal(linkResult._tag, "Failure");
    assert.equal(test.calls.length, 1);
  }),
);

it.effect("uses native guild search and reports indexing without claiming empty results", () =>
  Effect.gen(function* () {
    const test = setup(() => ({ code: 110000, retry_after: 2 }));
    const result = yield* test.reader(route, { action: "search", query: "bug" });
    assert.equal(test.calls[0]?.path, "/guilds/30/messages/search");
    assert.equal(test.calls[0]?.query.get("content"), "bug");
    assert.deepEqual(result, { action: "search", status: "indexing", retryAfterMs: 2000 });
  }),
);

it.effect("normalizes nested search hits and paginates using total results", () =>
  Effect.gen(function* () {
    const test = setup(() => ({ total_results: 42, messages: [[rawMessage("99")]] }));
    const result = yield* test.reader(route, { action: "search", query: "bug", limit: 20 });
    if (result.action !== "search" || result.status !== "ready")
      return assert.fail("expected search results");
    assert.equal(result.messages[0]?.url, "https://discord.com/channels/30/20/99");
    assert.equal(result.nextCursor, "20");
  }),
);

it.effect("fetches a replied-to message and preserves bot authors in recent participants", () =>
  Effect.gen(function* () {
    const test = setup((path) => {
      if (path === "/channels/20") return channel;
      if (path.endsWith("/100"))
        return { ...rawMessage("100"), message_reference: { message_id: "98", channel_id: "20" } };
      if (path.endsWith("/98")) return rawMessage("98");
      return [
        rawMessage("99"),
        { ...rawMessage("98"), author: { id: "50", username: "bot", bot: true } },
        rawMessage("97"),
      ];
    });
    const result = yield* test.reader(route, {
      action: "message",
      reference: { type: "replied-to" },
    });
    assert.equal(result.action, "message");
    if (result.action === "message") assert.equal(result.message.id, "98");
    const participants = yield* test.reader(route, {
      action: "participants",
      mode: "recent-authors",
    });
    if (participants.action !== "participants") return assert.fail("expected participants");
    assert.equal(participants.participants.length, 2);
    assert.isTrue(participants.participants.some((author) => author.isBot));
    assert.equal(participants.sample?.messageCount, 3);
  }),
);

it.effect(
  "reports trigger and destination context separately and reads explicit thread locations at the latest tip",
  () =>
    Effect.gen(function* () {
      const test = setup((path) => {
        if (path === "/guilds/30") return { id: "30", name: "Guild" };
        if (path === "/channels/20") return channel;
        if (path === "/channels/100")
          return { ...channel, id: "100", type: 11, parent_id: "20", name: "Reply thread" };
        if (path === "/channels/20/messages/100") return rawMessage("100");
        return [];
      });
      const context = yield* test.reader(route, { action: "context" });
      if (context.action !== "context") return assert.fail("expected context");
      assert.equal(context.triggerChannel.id, "20");
      assert.equal(context.replyChannel?.id, "100");
      assert.equal(context.replyChannel?.parentId, "20");
      assert.equal(context.bot.id, "50");
      yield* test.reader(route, { action: "history", location: { type: "reply" } });
      assert.equal(test.calls.at(-1)?.path, "/channels/100/messages");
      assert.isFalse(test.calls.at(-1)?.query.has("before"));
      yield* test.reader(
        { ...route, channelId: "100" },
        { action: "history", location: { type: "parent" } },
      );
      assert.equal(test.calls.at(-1)?.path, "/channels/20/messages");
      assert.isFalse(test.calls.at(-1)?.query.has("before"));
    }),
);

it.effect("preserves native search filters and stops pagination at the API offset ceiling", () =>
  Effect.gen(function* () {
    const test = setup((path) =>
      path.startsWith("/channels/") ? channel : { total_results: 12000, messages: [] },
    );
    const result = yield* test.reader(route, {
      action: "search",
      query: "bug",
      channelIds: ["20"],
      authorIds: ["40", "41"],
      beforeMessageId: "200",
      afterMessageId: "100",
      sort: "relevance",
      limit: 25,
      cursor: "9975",
    });
    const query = test.calls.at(-1)?.query;
    assert.deepEqual(query?.getAll("author_id"), ["40", "41"]);
    assert.deepEqual(query?.getAll("channel_id"), ["20"]);
    assert.equal(query?.get("max_id"), "200");
    assert.equal(query?.get("min_id"), "100");
    assert.equal(query?.get("offset"), "9975");
    assert.equal(query?.get("sort_by"), "relevance");
    if (result.action !== "search" || result.status !== "ready")
      return assert.fail("expected search results");
    assert.equal(result.nextCursor, null);
  }),
);

it.effect("rejects malformed external message IDs through the typed error channel", () =>
  Effect.gen(function* () {
    const test = setup((path) => (path === "/channels/20" ? channel : [rawMessage("bad")]));
    const result = yield* test.reader(route, { action: "history" }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "invalid-response");
  }),
);
