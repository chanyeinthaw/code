import { selectBotIdentities, type BotIdentity, type EnvironmentId } from "@satslab/contracts";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

export function resolveBotSettingsIdentity(
  records: readonly { bot: BotIdentity; environmentId: EnvironmentId }[],
  botId: string,
  environmentHint: string,
) {
  const candidates = records.filter((record) => record.bot.id === botId);
  // The URL only breaks ties; a newer identity or an active owner still wins.
  const ordered = [
    ...candidates.filter((record) => record.environmentId !== environmentHint),
    ...candidates.filter((record) => record.environmentId === environmentHint),
  ];
  const bot = selectBotIdentities(ordered.map((record) => record.bot))[0] ?? null;
  const confirmedOwner =
    bot?.status === "active" &&
    candidates.some(
      (record) => record.environmentId === bot.ownerEnvironmentId && record.bot === bot,
    );
  return {
    bot,
    redirectEnvironmentId:
      confirmedOwner && bot.ownerEnvironmentId !== environmentHint ? bot.ownerEnvironmentId : null,
  };
}

export function resolveBotSettingsGroup(
  groups: readonly SidebarProjectSnapshot[],
  bot: BotIdentity | null,
  root: {
    environmentId: EnvironmentId;
    id: string;
    projectId: string;
    botId?: string | undefined;
  } | null,
) {
  if (
    !bot ||
    bot.status === "deleted" ||
    bot.status === "staged" ||
    !root ||
    root.environmentId !== bot.ownerEnvironmentId ||
    root.id !== bot.threadId ||
    root.botId !== bot.id
  )
    return null;
  const group = groups.find((candidate) =>
    candidate.memberProjects.some(
      (member) =>
        member.isBot &&
        member.environmentId === bot.ownerEnvironmentId &&
        member.id === root.projectId,
    ),
  );
  const member = group?.memberProjects.find(
    (candidate) =>
      candidate.isBot &&
      candidate.environmentId === bot.ownerEnvironmentId &&
      candidate.id === root.projectId,
  );
  return group && member
    ? { ...group, environmentId: member.environmentId, id: member.id, memberProjects: [member] }
    : null;
}

export function botSettingsSearchDestination(bot: BotIdentity | null) {
  return bot
    ? {
        to: "/bots/settings/$environmentId/$botId" as const,
        params: { environmentId: bot.ownerEnvironmentId, botId: bot.id },
        hash: "bot-load-resources",
      }
    : { to: "/settings/bots" as const };
}

export function resolveLegacyBotSettingsIdentity(
  records: readonly { bot: BotIdentity; environmentId: EnvironmentId }[],
  members: SidebarProjectSnapshot["memberProjects"],
  roots: readonly {
    environmentId: EnvironmentId;
    id: string;
    projectId: string;
    botId?: string | undefined;
  }[],
) {
  const identities = members.flatMap((member) => {
    if (!member.isBot) return [];
    return roots.flatMap((root) => {
      if (
        !root.botId ||
        root.environmentId !== member.environmentId ||
        root.projectId !== member.id
      )
        return [];
      const { bot } = resolveBotSettingsIdentity(records, root.botId, member.environmentId);
      return bot?.status === "active" &&
        bot.ownerEnvironmentId === member.environmentId &&
        bot.threadId === root.id
        ? [bot]
        : [];
    });
  });
  const bot = identities[0];
  return bot && identities.every((identity) => identity.id === bot.id) ? bot : null;
}

export function parseBotSettingsReturnThread(origin: string | undefined) {
  const match = origin?.match(/^\/bots\/([^/?#]+)\/([^/?#]+)(?:[?#].*)?$/);
  if (!match || match[1] === "settings") return null;
  try {
    return {
      environmentId: decodeURIComponent(match[1]!),
      threadId: decodeURIComponent(match[2]!),
    };
  } catch {
    return null;
  }
}

export function botSettingsReturnHref(
  bot: BotIdentity | null,
  origin: string | undefined,
  context: { botId: string; threadId: string } | null,
) {
  if (origin && /^\/settings\/bots(?:[?#].*)?$/.test(origin)) return origin;
  const thread = parseBotSettingsReturnThread(origin);
  if (
    origin &&
    bot &&
    thread?.environmentId === bot.ownerEnvironmentId &&
    context?.botId === bot.id &&
    context.threadId === bot.threadId
  )
    return origin;
  return bot?.status === "active"
    ? `/bots/${encodeURIComponent(bot.ownerEnvironmentId)}/${encodeURIComponent(bot.threadId)}`
    : "/settings/bots";
}
