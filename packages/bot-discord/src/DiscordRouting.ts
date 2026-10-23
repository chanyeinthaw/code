import type { DiscordRoute } from "./model.ts";

/** The adapter owns the recipient prefix, including when an agent supplies it itself. */
export function replyText(userId: string, text: string) {
  let body = text.trimStart();
  const mentions = [`<@${userId}>`, `<@!${userId}>`];
  let leading = mentions.find((mention) => body.startsWith(mention));
  while (leading) {
    body = body.slice(leading.length).trimStart();
    leading = mentions.find((mention) => body.startsWith(mention));
  }
  return `<@${userId}> ${body}`;
}

/** Discord replies cannot reference a message in another channel or a thread's system placeholder. */
export function answerReference(route: DiscordRoute) {
  if (route.rootChannelId === route.destinationId) return { replyToId: route.rootId };
  return {
    replyToId: route.channelId === route.destinationId ? route.triggerId : undefined,
  };
}
