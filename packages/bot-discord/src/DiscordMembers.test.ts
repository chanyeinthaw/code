import { assert, it } from "@effect/vitest";
import { Client } from "discord.js";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { makeMembers } from "./DiscordMembers.ts";

const guild = { id: "30", name: "Test", owner_id: "90", roles: [], emojis: [], features: [] };
const member = (id: string, roles: ReadonlyArray<string> = []) => ({
  user: { id, username: `user-${id}`, discriminator: "0", avatar: null },
  roles,
  joined_at: "2026-10-23T00:00:00Z",
  deaf: false,
  mute: false,
  flags: 0,
});
const channel = {
  id: "20",
  guild_id: "30",
  name: "general",
  type: 0,
  permission_overwrites: [{ id: "30", type: 0, allow: "0", deny: "1024" }],
};

it.effect(
  "filters a guild member page by effective channel permissions without losing its cursor",
  () =>
    Effect.gen(function* () {
      const client = new Client({ intents: [] });
      try {
        using spy = vi.spyOn(client.rest, "get").mockImplementation(async (path) => {
          if (path === "/guilds/30") return guild;
          if (path === "/channels/20") return channel;
          if (path === "/guilds/30/roles")
            return [
              { id: "30", name: "@everyone", permissions: "1024", position: 0 },
              { id: "60", name: "admin", permissions: "8", position: 1 },
            ];
          if (path === "/guilds/30/members") return [member("40", ["60"]), member("41")];
          throw new Error(`Unexpected fixture request: ${path}`);
        });
        yield* Effect.promise(() => client.guilds.fetch("30"));
        const result = yield* makeMembers(client)("20", 2, "39");
        assert.deepEqual(
          result.participants.map((item) => item.id),
          ["40"],
        );
        assert.equal(result.nextCursor, "41");
        const call = spy.mock.calls.find(([path]) => path === "/guilds/30/members");
        assert.equal(call?.[1]?.query?.get("after"), "39");
        assert.equal(call?.[1]?.query?.get("limit"), "2");
      } finally {
        yield* Effect.promise(() => client.destroy());
      }
    }),
);

it.effect("pages joined thread members with guild member data", () =>
  Effect.gen(function* () {
    const client = new Client({ intents: [] });
    try {
      using spy = vi.spyOn(client.rest, "get").mockImplementation(async (path) => {
        if (path === "/guilds/30") return guild;
        if (path === "/channels/100")
          return {
            ...channel,
            id: "100",
            type: 11,
            parent_id: "20",
            owner_id: "40",
            thread_metadata: {
              archived: false,
              locked: false,
              auto_archive_duration: 60,
              archive_timestamp: "2026-10-23T00:00:00Z",
            },
          };
        if (path === "/channels/100/thread-members")
          return [
            {
              id: "100",
              user_id: "40",
              join_timestamp: "2026-10-23T00:00:00Z",
              flags: 0,
              member: member("40"),
            },
          ];
        throw new Error(`Unexpected fixture request: ${path}`);
      });
      yield* Effect.promise(() => client.guilds.fetch("30"));
      const result = yield* makeMembers(client)("100", 1, "39");
      assert.equal(result.participants[0]?.id, "40");
      assert.equal(result.nextCursor, "40");
      const call = spy.mock.calls.find(([path]) => path.endsWith("/thread-members"));
      assert.equal(call?.[1]?.query?.get("with_member"), "true");
      assert.equal(call?.[1]?.query?.get("after"), "39");
    } finally {
      yield* Effect.promise(() => client.destroy());
    }
  }),
);

it.effect("returns an actionable member access error when Discord rejects roster access", () =>
  Effect.gen(function* () {
    const client = new Client({ intents: [] });
    try {
      using _spy = vi.spyOn(client.rest, "get").mockImplementation(async (path) => {
        if (path === "/guilds/30") return guild;
        if (path === "/channels/20") return channel;
        if (path.endsWith("/roles")) return [];
        throw new Error("Missing privileged intent");
      });
      yield* Effect.promise(() => client.guilds.fetch("30"));
      const result = yield* makeMembers(client)("20", 20).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "members-unavailable");
    } finally {
      yield* Effect.promise(() => client.destroy());
    }
  }),
);
