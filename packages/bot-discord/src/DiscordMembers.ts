import type { Client } from "discord.js";
import * as Effect from "effect/Effect";
import { DiscordReadError, type ReadTransport } from "./DiscordReads.ts";

export const makeMembers = (client: Client): ReadTransport["members"] => {
  return Effect.fn("DiscordClient.members")(function* (channelId, limit, cursor) {
    return yield* Effect.tryPromise({
      try: async () => {
        const channel = await client.channels.fetch(channelId);
        if (!channel || channel.isDMBased()) throw new Error("Guild channel required");
        if (channel.isThread()) {
          const members = await channel.members.fetch({
            withMember: true,
            limit,
            ...(cursor ? { after: cursor } : {}),
            cache: false,
          });
          return {
            participants: [...members.values()].map((item) => ({
              id: item.id,
              username: item.guildMember.user.username,
              displayName: item.guildMember.displayName,
              isBot: item.guildMember.user.bot,
            })),
            nextCursor: members.size === limit ? (members.lastKey() ?? null) : null,
          };
        }
        // REST pagination does not require adding the privileged intent to the gateway connection.
        await channel.guild.roles.fetch();
        const members = await channel.guild.members.list({
          limit,
          ...(cursor ? { after: cursor } : {}),
          cache: false,
        });
        return {
          participants: [...members.values()]
            .filter((member) => channel.permissionsFor(member)?.has("ViewChannel"))
            .map((member) => ({
              id: member.id,
              username: member.user.username,
              displayName: member.displayName,
              isBot: member.user.bot,
            })),
          // Cursor follows the scanned guild page, including members filtered out by channel permissions.
          nextCursor: members.size === limit ? (members.lastKey() ?? null) : null,
        };
      },
      catch: (cause) => new DiscordReadError({ reason: "members-unavailable", cause }),
    });
  });
};
