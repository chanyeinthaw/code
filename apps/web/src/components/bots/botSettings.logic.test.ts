import { BotId, EnvironmentId, ProjectId, ThreadId, type BotIdentity } from "@satslab/contracts";
import { describe, expect, it } from "vite-plus/test";
import type {
  SidebarProjectSnapshot,
  SidebarProjectGroupMember,
} from "../../sidebarProjectGrouping";
import { resolveSettingsScope } from "../settings/settingsScope";
import {
  botSettingsSearchDestination,
  botSettingsReturnHref,
  resolveBotSettingsGroup,
  resolveBotSettingsIdentity,
  resolveLegacyBotSettingsIdentity,
} from "./botSettings.logic";

const source = EnvironmentId.make("source");
const destination = EnvironmentId.make("destination");
const bot: BotIdentity = {
  id: BotId.make("bot"),
  name: "Bot",
  ownerEnvironmentId: source,
  threadId: ThreadId.make("root"),
  generation: 1,
  status: "active",
  destinationEnvironmentId: null,
};
function record(identity = bot, environmentId = identity.ownerEnvironmentId) {
  return { bot: identity, environmentId };
}
function member(environmentId: EnvironmentId, id = "project"): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    isBot: true,
    title: "Bot",
    workspaceRoot: `/bots/${id}`,
    physicalProjectKey: `${environmentId}:${id}`,
    environmentLabel: environmentId,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
  };
}
const local = member(source);
const remote = member(destination);
const group: SidebarProjectSnapshot = {
  ...local,
  projectKey: "bot-group",
  displayName: "Bot",
  memberProjects: [remote, local],
  memberProjectRefs: [
    { environmentId: source, projectId: local.id },
    { environmentId: destination, projectId: remote.id },
  ],
  groupedProjectCount: 2,
  environmentPresence: "mixed",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [],
};
const root = { environmentId: source, id: bot.threadId, projectId: local.id, botId: bot.id };

describe("bot settings identity", () => {
  it("does not substitute another bot when identity data is unavailable", () => {
    expect(resolveBotSettingsIdentity([record()], "missing", source)).toEqual({
      bot: null,
      redirectEnvironmentId: null,
    });
    expect(resolveBotSettingsIdentity([], bot.id, source).bot).toBeNull();
  });
  it("uses the durable identity's current root after reset", () => {
    const reset = { ...bot, generation: 2, threadId: ThreadId.make("fresh-root") };
    const selected = resolveBotSettingsIdentity([record(), record(reset)], bot.id, source).bot;
    expect(selected).toEqual(reset);
    expect(resolveBotSettingsGroup([group], selected, root)).toBeNull();
    expect(
      resolveBotSettingsGroup([group], selected, { ...root, id: reset.threadId })?.memberProjects,
    ).toEqual([local]);
  });
  it("redirects only to a confirmed active owner, never a staged transfer", () => {
    const staged: BotIdentity = {
      ...bot,
      ownerEnvironmentId: destination,
      generation: 2,
      status: "staged",
    };
    expect(resolveBotSettingsIdentity([record(), record(staged)], bot.id, source)).toEqual({
      bot,
      redirectEnvironmentId: null,
    });
    const active = { ...staged, status: "active" as const };
    expect(resolveBotSettingsIdentity([record(), record(active)], bot.id, source)).toEqual({
      bot: active,
      redirectEnvironmentId: destination,
    });
    expect(
      resolveBotSettingsIdentity([record(active, source)], bot.id, source).redirectEnvironmentId,
    ).toBeNull();
  });
  it("keeps transfer and confirmed deletion distinct from an unavailable identity", () => {
    for (const status of ["transferring", "forwarded", "deleted"] as const) {
      const identity = { ...bot, generation: 2, status, destinationEnvironmentId: destination };
      expect(resolveBotSettingsIdentity([record(), record(identity)], bot.id, source)).toEqual({
        bot: identity,
        redirectEnvironmentId: null,
      });
    }
  });
});

describe("bot backing checkout", () => {
  it("pins a grouped selection to the physical owner and project", () => {
    const selected = resolveBotSettingsGroup([group], bot, root)!;
    expect(selected.memberProjects).toEqual([local]);
    const scope = resolveSettingsScope(
      { project: selected.projectKey, machine: source, checkout: local.physicalProjectKey },
      [group],
      [
        { environmentId: source, label: "Source" },
        { environmentId: destination, label: "Destination" },
      ],
    );
    expect(scope.kind).toBe("checkout");
    expect(scope.members).toEqual([local]);
    expect(scope.environmentIds).toEqual([source]);
  });
  it("does not broaden missing owner or checkout data to another group member", () => {
    expect(resolveBotSettingsGroup([group], bot, null)).toBeNull();
    expect(resolveBotSettingsGroup([group], bot, { ...root, botId: "another-bot" })).toBeNull();
    expect(
      resolveBotSettingsGroup([group], bot, { ...root, environmentId: destination }),
    ).toBeNull();
    expect(resolveBotSettingsGroup([{ ...group, memberProjects: [remote] }], bot, root)).toBeNull();
    const scope = resolveSettingsScope(
      { project: group.projectKey, machine: source, checkout: local.physicalProjectKey },
      [{ ...group, memberProjects: [remote] }],
      [{ environmentId: source, label: "Source" }],
    );
    expect(scope).toMatchObject({ kind: "unavailable", members: [], environmentIds: [] });
  });
  it("redirects legacy selections only with the exact owner, root, and backing project", () => {
    expect(resolveLegacyBotSettingsIdentity([record()], [local], [root])).toEqual(bot);
    expect(resolveLegacyBotSettingsIdentity([record()], [remote], [root])).toBeNull();
    expect(
      resolveLegacyBotSettingsIdentity([record()], [local], [{ ...root, id: "stale-root" }]),
    ).toBeNull();
    expect(
      resolveLegacyBotSettingsIdentity([record()], [{ ...local, isBot: false }], [root]),
    ).toBeNull();
  });
});

it("routes resource search to the selected bot or management without choosing another bot", () => {
  expect(botSettingsSearchDestination(bot)).toEqual({
    to: "/bots/settings/$environmentId/$botId",
    params: { environmentId: source, botId: bot.id },
    hash: "bot-load-resources",
  });
  expect(botSettingsSearchDestination(null)).toEqual({ to: "/settings/bots" });
});

it("returns to the originating root, subagent, or management and replaces stale origins", () => {
  expect(
    botSettingsReturnHref(bot, "/bots/source/root", { botId: bot.id, threadId: bot.threadId }),
  ).toBe("/bots/source/root");
  expect(
    botSettingsReturnHref(bot, "/bots/source/subagent", { botId: bot.id, threadId: bot.threadId }),
  ).toBe("/bots/source/subagent");
  expect(botSettingsReturnHref(bot, "/settings/bots?machine=source", null)).toBe(
    "/settings/bots?machine=source",
  );
  expect(botSettingsReturnHref(bot, "/bots/source/old", { botId: bot.id, threadId: "old" })).toBe(
    "/bots/source/root",
  );
  expect(
    botSettingsReturnHref(bot, "/bots/destination/root", { botId: bot.id, threadId: bot.threadId }),
  ).toBe("/bots/source/root");
  expect(botSettingsReturnHref(bot, undefined, null)).toBe("/bots/source/root");
  expect(botSettingsReturnHref(null, undefined, null)).toBe("/settings/bots");
});
