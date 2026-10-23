import type { BotDiscordSettings } from "@satslab/contracts";
import type { DiscordMessage } from "./model.ts";

export function acceptsMessage(
  settings: BotDiscordSettings,
  message: DiscordMessage,
  knownReply: boolean,
) {
  if (
    !settings.enabled ||
    message.guildId === null ||
    message.authorIsBot ||
    message.webhook ||
    message.system
  )
    return false;
  const { mode, userIds } = settings.userPolicy;
  const listed = userIds.includes(message.authorId);
  if (mode === "block" ? listed : userIds.length > 0 && !listed) return false;
  return settings.interactionMode === "all-messages" || message.mentionsBot || knownReply;
}
